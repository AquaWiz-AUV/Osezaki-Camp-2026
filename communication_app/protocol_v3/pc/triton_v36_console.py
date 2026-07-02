#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as _dt
import pathlib
import random
import signal
import sys
import time
from typing import Any

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    serial = None  # type: ignore[assignment]
    list_ports = None  # type: ignore[assignment]

try:
    from . import triton_v36_protocol as proto
except ImportError:
    import triton_v36_protocol as proto


BAUD = 115200
ACK_RETRY_TIMEOUTS = (0.45, 0.55, 0.7, 0.85, 1.05, 1.3, 1.6, 2.0, 2.5, 3.2, 4.0, 5.0)
ACK_RETRY_JITTER_FRACTION = 0.30


def jittered_timeout(base_timeout: float) -> float:
    if ACK_RETRY_JITTER_FRACTION <= 0:
        return base_timeout
    return base_timeout + random.uniform(0.0, base_timeout * ACK_RETRY_JITTER_FRACTION)


def parse_int_auto(value: str) -> int:
    return int(value, 0)


def find_default_stick() -> str | None:
    if list_ports is None:
        return None
    ports = [port.device for port in list_ports.comports() if port.device]
    preferred = [port for port in ports if "usbserial" in port.lower() or "com" in port.lower()]
    return sorted(preferred or ports)[0] if ports else None


def require_pyserial() -> None:
    if serial is None:
        raise RuntimeError("pyserial is required. Run: python -m pip install -r requirements.txt")


def open_serial(path: str):
    require_pyserial()
    ser = serial.Serial(
        port=path,
        baudrate=BAUD,
        bytesize=serial.EIGHTBITS,
        parity=serial.PARITY_NONE,
        stopbits=serial.STOPBITS_ONE,
        timeout=0.1,
        write_timeout=0.5,
        xonxoff=False,
        rtscts=False,
        dsrdtr=False,
    )
    try:
        ser.reset_input_buffer()
        ser.reset_output_buffer()
    except serial.SerialException:
        pass
    return ser


class WireLogger:
    def __init__(self, path: str | None, port: str):
        self.path = pathlib.Path(path) if path else None
        self.port = port
        self.file = None
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.file = self.path.open("a", encoding="utf-8")
            self.file.write("# timestamp\tdir\tport\tline\tlogical_id\tapp_cmd\tpacket\tseq\tcommand\tresult\tcrc\tlrc\tnote\n")

    def close(self) -> None:
        if self.file:
            self.file.close()
            self.file = None

    def log(self, direction: str, line: bytes | str, note: str = "") -> None:
        if not self.file:
            return
        if isinstance(line, bytes):
            text = line.decode("ascii", errors="replace")
        else:
            text = line
        logical = app_cmd = packet = seq = command = result = "-"
        crc = lrc = "NA"
        app, app_error = proto.decode_app_uart(text)
        if app_error:
            lrc = "NG"
            note = note or app_error
        elif app is not None:
            lrc = "OK"
            logical = f"0x{app.logical_id:02X}"
            app_cmd = f"0x{app.app_cmd:02X}"
            app_unwrapped, unwrap_error = proto.unwrap_app_frame(app)
            if unwrap_error:
                note = note or unwrap_error
            elif app_unwrapped is not None and app_unwrapped.app_cmd == proto.APP_CMD:
                payload = app_unwrapped.payload
                if len(payload) in (proto.CMD_LEN, proto.ACK_LEN, proto.STATUS_LEN):
                    err = proto.verify_raw_frame(payload)
                    crc = "OK" if err is None else "NG"
                    packet = f"0x{payload[2]:02X}"
                    if payload[2] == proto.PACKET_CMD:
                        seq = str(proto.frame_seq(payload))
                        command = f"0x{proto.frame_command(payload):02X}"
                    elif payload[2] == proto.PACKET_ACK:
                        try:
                            ack = proto.parse_ack(payload)
                            seq = str(ack.acked_seq)
                            command = f"0x{ack.command_echo:02X}"
                            result = proto.result_name(ack.result_code)
                        except proto.ProtocolError as exc:
                            note = note or str(exc)
                    elif payload[2] == proto.PACKET_STATUS:
                        try:
                            status = proto.parse_status(payload)
                            seq = str(status.status_seq)
                            result = proto.result_name(status.last_cmd_result)
                        except proto.ProtocolError as exc:
                            note = note or str(exc)
        timestamp = _dt.datetime.now().isoformat(timespec="milliseconds")
        safe_line = text.replace("\t", " ").replace("\r", "\\r").replace("\n", "\\n")
        self.file.write(
            f"{timestamp}\t{direction}\t{self.port}\t{safe_line}\t{logical}\t{app_cmd}\t"
            f"{packet}\t{seq}\t{command}\t{result}\t{crc}\t{lrc}\t{note}\n"
        )
        self.file.flush()


def write_all(ser: Any, data: bytes) -> None:
    ser.write(data)
    ser.flush()


def state_name(value: int) -> str:
    return {
        proto.STATE_SAFE_IDLE: "SAFE_IDLE",
        proto.STATE_PLAN_LOADED: "PLAN_LOADED",
        proto.STATE_RUNNING: "RUNNING",
        proto.STATE_COMPLETED: "COMPLETED",
        proto.STATE_ERROR_LOCKOUT: "ERROR_LOCKOUT",
    }.get(value, f"0x{value:02X}")


def phase_name(value: int) -> str:
    return {
        proto.PHASE_IDLE: "IDLE",
        proto.PHASE_PREPARE: "PREPARE",
        proto.PHASE_EXHAUST_OPEN: "EXHAUST_OPEN",
        proto.PHASE_DESCENT_COAST: "DESCENT_COAST",
        proto.PHASE_BOTTOM_WAIT: "BOTTOM_WAIT",
        proto.PHASE_INJECTION_OPEN: "INJECTION_OPEN",
        proto.PHASE_ASCENT_WAIT: "ASCENT_WAIT",
        proto.PHASE_COMPLETE: "COMPLETE",
        proto.PHASE_ERROR: "ERROR",
    }.get(value, f"0x{value:02X}")


def print_ack(ack: proto.AckFrame) -> None:
    print(
        f"ACK seq={ack.acked_seq} cmd=0x{ack.command_echo:02X} "
        f"result={proto.result_name(ack.result_code)} "
        f"state={state_name(ack.control_state)} phase={phase_name(ack.phase)} "
        f"plan={ack.active_plan_id} detail=0x{ack.detail_u16:04X} "
        f"valves=0x{ack.valve_bits:02X} err_low=0x{ack.error_flags_low:02X}"
    )


def print_status(status: proto.StatusFrame) -> None:
    print(
        f"STATUS seq={status.status_seq} "
        f"state={state_name(status.control_state)} phase={phase_name(status.phase)} "
        f"valves=0x{status.valve_bits:02X} plan={status.active_plan_id} "
        f"cycle={status.cycle_count} elapsed={status.phase_elapsed_s}s "
        f"remain={status.phase_remaining_s}s last={proto.result_name(status.last_cmd_result)} "
        f"last_seq={status.last_cmd_seq} pc_age={status.pc_seen_age_s}s "
        f"errors=0x{status.error_flags:04X}"
    )


class Receiver:
    def __init__(self, ser: Any, raw: bool = False, logger: WireLogger | None = None):
        self.ser = ser
        self.raw = raw
        self.logger = logger
        self.buffer = b""
        self.decode_errors = 0
        self.skipped_lines = 0
        self.acks: list[proto.AckFrame] = []
        self.statuses: list[proto.StatusFrame] = []

    def poll(self, timeout: float) -> list[proto.AckFrame | proto.StatusFrame]:
        events: list[proto.AckFrame | proto.StatusFrame] = []
        old_timeout = self.ser.timeout
        try:
            self.ser.timeout = max(0.0, timeout)
            chunk = self.ser.read(4096)
        finally:
            self.ser.timeout = old_timeout
        if not chunk:
            return events
        self.buffer += chunk
        while b"\n" in self.buffer:
            raw_line, self.buffer = self.buffer.split(b"\n", 1)
            raw_line = raw_line.rstrip(b"\r")
            if self.logger:
                self.logger.log("RX", raw_line)
            if self.raw:
                print(f"raw: {raw_line.decode('ascii', errors='replace')}")
            app, app_error = proto.decode_app_uart(raw_line)
            if app_error:
                # Framing/LRC failure: TWELITE local response (':DBA1...') or line noise,
                # not a Triton frame. Spec 4.7 says these are log-only, never an error.
                self.skipped_lines += 1
                continue
            app, unwrap_error = proto.unwrap_app_frame(app)
            if unwrap_error or app is None:
                self.skipped_lines += 1
                continue
            if app.app_cmd != proto.APP_CMD:
                # app_cmd != 0x31 (e.g. a TWELITE local echo): not addressed to Triton.
                self.skipped_lines += 1
                continue
            try:
                if len(app.payload) == proto.ACK_LEN and app.payload[2] == proto.PACKET_ACK:
                    ack = proto.parse_ack(app.payload)
                    self.acks.append(ack)
                    events.append(ack)
                    print_ack(ack)
                elif len(app.payload) == proto.STATUS_LEN and app.payload[2] == proto.PACKET_STATUS:
                    status = proto.parse_status(app.payload)
                    self.statuses.append(status)
                    events.append(status)
                    print_status(status)
            except proto.ProtocolError:
                self.decode_errors += 1
        return events

    def wait_ack(self, seq: int, device_id: int, timeout: float) -> proto.AckFrame | None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for event in self.poll(0.1):
                if isinstance(event, proto.AckFrame) and event.acked_seq == seq and event.device_id == device_id:
                    return event
        return None


def send_cmd(
    ser: Any,
    dest: int,
    seq: int,
    device_id: int,
    command: int,
    plan: proto.ControlPlan | None = None,
    safety_key: int = 0,
    logger: WireLogger | None = None,
    raw_frame: bytes | None = None,
) -> bytes:
    raw = raw_frame if raw_frame is not None else proto.build_cmd_frame(seq, device_id, command, plan, safety_key)
    app_line = proto.encode_app_uart(dest, raw)
    write_all(ser, app_line)
    if logger:
        logger.log("TX", app_line.rstrip(b"\r\n"))
    return raw


def send_cmd_reliable(
    ser: Any,
    rx: Receiver,
    dest: int,
    seq: int,
    device_id: int,
    command: int,
    plan: proto.ControlPlan | None = None,
    safety_key: int = 0,
    logger: WireLogger | None = None,
) -> tuple[bytes, proto.AckFrame | None]:
    raw = proto.build_cmd_frame(seq, device_id, command, plan, safety_key)
    for attempt, base_timeout in enumerate(ACK_RETRY_TIMEOUTS, start=1):
        timeout = jittered_timeout(base_timeout)
        send_cmd(ser, dest, seq, device_id, command, plan, safety_key, logger=logger, raw_frame=raw)
        print(
            f"CMD 0x{command:02X} sent seq={seq} attempt={attempt}/{len(ACK_RETRY_TIMEOUTS)} "
            f"ack_wait={timeout:.2f}s"
        )
        ack = rx.wait_ack(seq, device_id, timeout)
        if ack is not None:
            return raw, ack
    return raw, None


def make_plan(args: argparse.Namespace) -> proto.ControlPlan:
    return proto.ControlPlan(
        plan_flags=args.plan_flags,
        max_runtime_min=args.max_runtime_min,
        plan_id=args.plan_id,
        repeat_count=args.repeat_count,
        prepare_s=args.prepare_s,
        exhaust_open_s=args.exhaust_open_s,
        descent_coast_s=args.descent_coast_s,
        bottom_wait_s=args.bottom_wait_s,
        injection_open_s=args.injection_open_s,
        ascent_wait_s=args.ascent_wait_s,
        depth_trigger_cm=args.depth_trigger_cm,
        max_depth_cm=args.max_depth_cm,
        log_interval_100ms=args.log_interval_100ms,
        status_interval_100ms=args.status_interval_100ms,
        comm_timeout_s=args.comm_timeout_s,
        safety_policy=proto.POLICY_STOP_SAFE_ONLY,
    )


def require_ok_ack(ack: proto.AckFrame | None, accepted: set[int]) -> bool:
    if ack is None:
        print("ACK timeout.")
        return False
    return ack.result_code in accepted


def main() -> int:
    default_port = find_default_stick()
    parser = argparse.ArgumentParser(description="Triton-3 TWELITE protocol v3.6 console")
    parser.add_argument("--port", default=default_port, help="TWELITE STICK serial port")
    parser.add_argument("--dest", type=parse_int_auto, default=0x78, help="TWELITE child logical ID")
    parser.add_argument("--device-id", type=parse_int_auto, default=1, help="Triton device_id")
    parser.add_argument("--action", choices=["demo", "load", "start", "stop", "status", "nop"], default="demo")
    parser.add_argument(
        "--seq",
        type=parse_int_auto,
        default=None,
        help="first CMD seq. Default: random, so reruns within the firmware 30 s ACK cache do not collide",
    )
    parser.add_argument("--run-seconds", type=float, default=3.0, help="demo observation window after START")
    parser.add_argument("--heartbeat", type=float, default=0.8, help="REQUEST_STATUS interval in demo")
    parser.add_argument("--no-stop", action="store_true", help="do not send STOP_SAFE at demo end")
    parser.add_argument("--raw", action="store_true")
    parser.add_argument(
        "--log-file",
        default=None,
        help="wire log path. Default: communication_app/logs/triton_v36_<timestamp>.tsv",
    )

    parser.add_argument("--plan-flags", type=parse_int_auto, default=0)
    parser.add_argument("--max-runtime-min", type=parse_int_auto, default=5)
    parser.add_argument("--plan-id", type=parse_int_auto, default=1)
    parser.add_argument("--repeat-count", type=parse_int_auto, default=1)
    parser.add_argument("--prepare-s", type=parse_int_auto, default=1)
    parser.add_argument("--exhaust-open-s", type=parse_int_auto, default=0)
    parser.add_argument("--descent-coast-s", type=parse_int_auto, default=0)
    parser.add_argument("--bottom-wait-s", type=parse_int_auto, default=0)
    parser.add_argument("--injection-open-s", type=parse_int_auto, default=1)
    parser.add_argument("--ascent-wait-s", type=parse_int_auto, default=0)
    parser.add_argument("--depth-trigger-cm", type=parse_int_auto, default=0)
    parser.add_argument("--max-depth-cm", type=parse_int_auto, default=0)
    parser.add_argument("--log-interval-100ms", type=parse_int_auto, default=5)
    parser.add_argument("--status-interval-100ms", type=parse_int_auto, default=10)
    parser.add_argument("--comm-timeout-s", type=parse_int_auto, default=0)
    args = parser.parse_args()

    if serial is None:
        print("pyserial is required. Run: python -m pip install -r requirements.txt", file=sys.stderr)
        return 2

    if not args.port:
        print("TWELITE STICK port was not found. Pass --port.", file=sys.stderr)
        return 2

    stop_requested = False

    def handle_signal(_signum, _frame):
        nonlocal stop_requested
        stop_requested = True

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    plan = make_plan(args)
    if args.action in ("demo", "load", "start"):
        errors = proto.validate_control_plan(plan)
        if errors:
            for error in errors:
                print(f"plan error: {error}", file=sys.stderr)
            return 2

    if args.log_file is None:
        stamp = _dt.datetime.now().strftime("%Y%m%d_%H%M%S")
        log_dir = pathlib.Path(__file__).resolve().parents[2] / "logs"
        args.log_file = str(log_dir / f"triton_v36_{stamp}.tsv")

    ser = open_serial(args.port)
    logger = WireLogger(args.log_file, args.port)
    rx = Receiver(ser, raw=args.raw, logger=logger)
    seq = (args.seq if args.seq is not None else random.randrange(1, 0x10000)) & 0xFFFF

    print(f"Opened TWELITE STICK: {args.port}")
    print(f"dest=0x{args.dest:02X} device_id=0x{args.device_id:02X} action={args.action}")
    try:
        if args.action in ("load", "demo"):
            raw, ack = send_cmd_reliable(
                ser, rx, args.dest, seq, args.device_id, proto.CMD_LOAD_PLAN, plan, proto.SAFETY_KEY, logger=logger
            )
            expected_plan_crc = proto.crc16_ccitt_false(proto.frame_plan_fields(raw))
            print(f"LOAD_PLAN sent seq={seq} expected_plan_crc=0x{expected_plan_crc:04X}")
            if not require_ok_ack(ack, {proto.RESULT_OK, proto.RESULT_OK_DUPLICATE_ACK}):
                return 1
            if ack.detail_u16 != expected_plan_crc:
                print(f"loaded_plan_crc mismatch: ack=0x{ack.detail_u16:04X}")
                return 1
            seq = (seq + 1) & 0xFFFF

        if args.action in ("start", "demo"):
            _, ack = send_cmd_reliable(
                ser, rx, args.dest, seq, args.device_id, proto.CMD_START_PLAN, plan, proto.SAFETY_KEY, logger=logger
            )
            print(f"START_PLAN sent seq={seq}")
            if not require_ok_ack(ack, {proto.RESULT_OK, proto.RESULT_OK_DUPLICATE_ACK}):
                return 1
            seq = (seq + 1) & 0xFFFF

        if args.action == "stop":
            _, ack = send_cmd_reliable(ser, rx, args.dest, seq, args.device_id, proto.CMD_STOP_SAFE, logger=logger)
            print(f"STOP_SAFE sent seq={seq}")
            return 0 if require_ok_ack(ack, {proto.RESULT_OK_STOPPED, proto.RESULT_OK_STOPPED_LOCKOUT}) else 1

        if args.action == "status":
            _, ack = send_cmd_reliable(ser, rx, args.dest, seq, args.device_id, proto.CMD_REQUEST_STATUS, logger=logger)
            print(f"REQUEST_STATUS sent seq={seq}")
            return 0 if require_ok_ack(ack, {proto.RESULT_OK, proto.RESULT_OK_DUPLICATE_ACK}) else 1

        if args.action == "nop":
            _, ack = send_cmd_reliable(ser, rx, args.dest, seq, args.device_id, proto.CMD_NOP, logger=logger)
            print(f"NOP sent seq={seq}")
            return 0 if require_ok_ack(ack, {proto.RESULT_OK, proto.RESULT_OK_DUPLICATE_ACK}) else 1

        if args.action == "demo":
            deadline = time.monotonic() + args.run_seconds
            next_heartbeat = 0.0
            completed = False
            while not stop_requested and time.monotonic() < deadline:
                now = time.monotonic()
                if now >= next_heartbeat:
                    send_cmd(ser, args.dest, seq, args.device_id, proto.CMD_REQUEST_STATUS, logger=logger)
                    print(f"REQUEST_STATUS sent seq={seq}")
                    seq = (seq + 1) & 0xFFFF
                    next_heartbeat = now + args.heartbeat
                for event in rx.poll(0.1):
                    if isinstance(event, proto.StatusFrame) and event.control_state == proto.STATE_COMPLETED:
                        completed = True
                if completed:
                    break

            if not args.no_stop:
                _, ack = send_cmd_reliable(ser, rx, args.dest, seq, args.device_id, proto.CMD_STOP_SAFE, logger=logger)
                print(f"STOP_SAFE sent seq={seq}")
                if not require_ok_ack(ack, {proto.RESULT_OK_STOPPED, proto.RESULT_OK_STOPPED_LOCKOUT}):
                    return 1

            print(
                f"SUMMARY acks={len(rx.acks)} statuses={len(rx.statuses)} "
                f"decode_errors={rx.decode_errors} skipped_lines={rx.skipped_lines} "
                f"completed={completed}"
            )
            return 0 if rx.decode_errors == 0 else 1

        return 0
    finally:
        logger.close()
        ser.close()


if __name__ == "__main__":
    raise SystemExit(main())
