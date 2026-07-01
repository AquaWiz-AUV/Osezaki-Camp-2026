#!/usr/bin/env python3
from __future__ import annotations

import dataclasses
import datetime as dt
import errno
import json
import os
import pathlib
import queue
import random
import sys
import threading
import time
import traceback
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    serial = None  # type: ignore[assignment]
    list_ports = None  # type: ignore[assignment]


APP_DIR = pathlib.Path(__file__).resolve().parent
RELEASE_DIR = APP_DIR.parent
PROTO_DIR_CANDIDATES = (
    APP_DIR / "protocol_v3" / "pc",
    RELEASE_DIR / "protocol_v3" / "pc",
    APP_DIR / "protocol_v36" / "pc",
    RELEASE_DIR / "protocol_v36" / "pc",
)
for PROTO_DIR in PROTO_DIR_CANDIDATES:
    if (PROTO_DIR / "triton_v36_protocol.py").exists():
        if str(PROTO_DIR) not in sys.path:
            sys.path.insert(0, str(PROTO_DIR))
        break
else:
    searched = ", ".join(str(path) for path in PROTO_DIR_CANDIDATES)
    raise ModuleNotFoundError(f"Could not find triton_v36_protocol.py in: {searched}")

import triton_v36_protocol as proto  # noqa: E402


HOST = "127.0.0.1"
PORT = int(os.environ.get("TRITON_WEB_GUI_PORT", "8765"))
PORT_SCAN_COUNT = int(os.environ.get("TRITON_WEB_GUI_PORT_SCAN", "20"))
DEBUG_TRACEBACKS = os.environ.get("TRITON_WEB_GUI_DEBUG", "") == "1"
BAUD = 115200
MAIN_FIRMWARE_ALLOW_COMM_TIMEOUT = False
ACK_RETRY_TIMEOUTS = (0.45, 0.55, 0.7, 0.85, 1.05, 1.3, 1.6, 2.0, 2.5, 3.2, 4.0, 5.0)
LINK_ACK_RETRY_TIMEOUTS = ACK_RETRY_TIMEOUTS
ACK_RETRY_JITTER_FRACTION = float(os.environ.get("TRITON_ACK_RETRY_JITTER_FRACTION", "0.30"))


STATE_NAMES = {
    proto.STATE_SAFE_IDLE: "SAFE_IDLE",
    proto.STATE_PLAN_LOADED: "PLAN_LOADED",
    proto.STATE_RUNNING: "RUNNING",
    proto.STATE_COMPLETED: "COMPLETED",
    proto.STATE_ERROR_LOCKOUT: "ERROR_LOCKOUT",
}

PHASE_NAMES = {
    proto.PHASE_IDLE: "IDLE",
    proto.PHASE_PREPARE: "PREPARE",
    proto.PHASE_EXHAUST_OPEN: "EXHAUST_OPEN",
    proto.PHASE_DESCENT_COAST: "DESCENT_COAST",
    proto.PHASE_BOTTOM_WAIT: "BOTTOM_WAIT",
    proto.PHASE_INJECTION_OPEN: "INJECTION_OPEN",
    proto.PHASE_ASCENT_WAIT: "ASCENT_WAIT",
    proto.PHASE_COMPLETE: "COMPLETE",
    proto.PHASE_ERROR: "ERROR",
}

COMMANDS = {
    "nop": proto.CMD_NOP,
    "load": proto.CMD_LOAD_PLAN,
    "start": proto.CMD_START_PLAN,
    "stop": proto.CMD_STOP_SAFE,
    "status": proto.CMD_REQUEST_STATUS,
}

COMMAND_NAMES = {
    proto.CMD_NOP: "NOP",
    proto.CMD_LOAD_PLAN: "LOAD_PLAN",
    proto.CMD_START_PLAN: "START_PLAN",
    proto.CMD_STOP_SAFE: "STOP_SAFE",
    proto.CMD_REQUEST_STATUS: "REQUEST_STATUS",
}


def parse_int(value: Any, name: str) -> int:
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        return int(value.strip(), 0)
    raise ValueError(f"{name} must be an integer")


def find_serial_ports() -> list[str]:
    if list_ports is None:
        return []
    ports = [port.device for port in list_ports.comports() if port.device]
    return sorted(dict.fromkeys(ports))


def require_pyserial() -> None:
    if serial is None:
        raise RuntimeError("pyserial is required. Run: python -m pip install -r requirements.txt")


def open_serial_port(port: str):
    require_pyserial()
    ser = serial.Serial(
        port=port,
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


class EventHub:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.subscribers: list[queue.Queue[dict[str, Any]]] = []
        self.history: list[dict[str, Any]] = []

    def publish(self, event_type: str, payload: dict[str, Any]) -> None:
        event = {
            "type": event_type,
            "time": dt.datetime.now().isoformat(timespec="milliseconds"),
            "payload": payload,
        }
        with self.lock:
            self.history.append(event)
            self.history = self.history[-400:]
            subscribers = list(self.subscribers)
        for subscriber in subscribers:
            try:
                subscriber.put_nowait(event)
            except queue.Full:
                pass

    def subscribe(self) -> queue.Queue[dict[str, Any]]:
        subscriber: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=200)
        with self.lock:
            self.subscribers.append(subscriber)
            snapshot = list(self.history[-80:])
        for event in snapshot:
            subscriber.put(event)
        return subscriber

    def unsubscribe(self, subscriber: queue.Queue[dict[str, Any]]) -> None:
        with self.lock:
            if subscriber in self.subscribers:
                self.subscribers.remove(subscriber)


class TritonBackend:
    def __init__(self) -> None:
        self.hub = EventHub()
        self.serial_port: Any | None = None
        self.port = ""
        self.connected = False
        self.seq = self._seed_seq()
        self.buffer = b""
        self.reader_thread: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.lock = threading.RLock()
        self.ack_condition = threading.Condition(self.lock)
        self.write_lock = threading.RLock()
        self.command_lock = threading.Lock()
        self.pending_load_start: dict[str, Any] | None = None
        self.ack_by_seq: dict[int, dict[str, Any]] = {}
        self.last_ack: dict[str, Any] | None = None
        self.last_status: dict[str, Any] | None = None
        self.last_status_by_device: dict[int, dict[str, Any]] = {}
        self.log_file = self._open_log()

    def _seed_seq(self) -> int:
        return ((time.monotonic_ns() ^ os.getpid()) & 0xFFFF) or 1

    def _open_log(self):
        log_dir = pathlib.Path(os.environ.get("TRITON_WEB_GUI_LOG_DIR", APP_DIR / "logs"))
        log_dir.mkdir(parents=True, exist_ok=True)
        stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
        return (log_dir / f"web_gui_{stamp}.log").open("a", encoding="utf-8")

    def log(self, level: str, message: str, **extra: Any) -> None:
        payload = {"level": level, "message": message, **extra}
        line = f"[{dt.datetime.now().isoformat(timespec='milliseconds')}] {level.upper()} {message}"
        if extra:
            line += " " + json.dumps(extra, ensure_ascii=False, sort_keys=True)
        self.log_file.write(line + "\n")
        self.log_file.flush()
        self.hub.publish("log", payload)

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "connected": self.connected,
                "port": self.port,
                "seq": self.seq,
                "lastAck": self.last_ack,
                "lastStatus": self.last_status,
            }

    def connect(self, port: str) -> dict[str, Any]:
        with self.lock:
            if self.serial_port is not None:
                return self.snapshot()
            ser = open_serial_port(port)
            self.serial_port = ser
            self.port = port
            self.connected = True
            self.buffer = b""
            self.ack_by_seq.clear()
            self.stop_event.clear()
            self.reader_thread = threading.Thread(target=self._reader_loop, name="triton-web-serial", daemon=True)
            self.reader_thread.start()
        self.log("ok", f"connected {port}", port=port)
        self.hub.publish("connection", self.snapshot())
        return self.snapshot()

    def disconnect(self) -> dict[str, Any]:
        with self.lock:
            self.stop_event.set()
            ser = self.serial_port
            self.serial_port = None
            old_port = self.port
            self.connected = False
            self.port = ""
            self.pending_load_start = None
            self.ack_by_seq.clear()
            self.last_status_by_device.clear()
            self.ack_condition.notify_all()
        if ser is not None:
            try:
                ser.close()
            except Exception:
                pass
        self.log("warn", "disconnected", port=old_port)
        self.hub.publish("connection", self.snapshot())
        return self.snapshot()

    def _next_seq(self) -> int:
        with self.lock:
            seq = self.seq & 0xFFFF
            self.seq = (self.seq + 1) & 0xFFFF
            return seq

    def build_plan(self, data: dict[str, Any]) -> proto.ControlPlan:
        plan = proto.ControlPlan(
            plan_flags=parse_int(data.get("planFlags", 0), "planFlags"),
            max_runtime_min=parse_int(data.get("maxRuntimeMin", 0), "maxRuntimeMin"),
            plan_id=parse_int(data.get("planId", 1), "planId"),
            repeat_count=parse_int(data.get("repeatCount", 1), "repeatCount"),
            prepare_s=parse_int(data.get("prepareS", 0), "prepareS"),
            exhaust_open_s=parse_int(data.get("exhaustOpenS", 0), "exhaustOpenS"),
            descent_coast_s=parse_int(data.get("descentCoastS", 0), "descentCoastS"),
            bottom_wait_s=parse_int(data.get("bottomWaitS", 0), "bottomWaitS"),
            injection_open_s=parse_int(data.get("injectionOpenS", 1), "injectionOpenS"),
            ascent_wait_s=parse_int(data.get("ascentWaitS", 0), "ascentWaitS"),
            depth_trigger_cm=parse_int(data.get("depthTriggerCm", 0), "depthTriggerCm"),
            max_depth_cm=parse_int(data.get("maxDepthCm", 0), "maxDepthCm"),
            log_interval_100ms=parse_int(data.get("logInterval100ms", 5), "logInterval100ms"),
            status_interval_100ms=parse_int(data.get("statusInterval100ms", 10), "statusInterval100ms"),
            comm_timeout_s=parse_int(data.get("commTimeoutS", 0), "commTimeoutS"),
            safety_policy=proto.POLICY_STOP_SAFE_ONLY,
        )
        if not MAIN_FIRMWARE_ALLOW_COMM_TIMEOUT and (
            (plan.plan_flags & proto.FLAG_COMM_TIMEOUT_ENABLE) or plan.comm_timeout_s != 0
        ):
            raise ValueError("COMM_TIMEOUT is disabled in the Triton-3 Osezaki Camp 2026 firmware")
        errors = proto.validate_control_plan(plan)
        if errors:
            raise ValueError("; ".join(errors))
        plan.fields_bytes()
        return plan

    def send_command_request(self, request: dict[str, Any]) -> dict[str, Any]:
        action = str(request.get("action", "")).strip()
        if not self.command_lock.acquire(blocking=False):
            raise RuntimeError("another command is still in progress")
        try:
            if action == "load_start":
                return self.send_load_start(request)
            if action not in COMMANDS:
                raise ValueError(f"unknown action: {action}")
            plan: proto.ControlPlan | None = None
            safety_key = 0
            if action in {"load", "start"}:
                plan = self.build_plan(request.get("plan") or {})
                safety_key = proto.SAFETY_KEY
            result = self._send_command(
                dest=parse_int(request.get("dest", "0x78"), "dest"),
                device_id=parse_int(request.get("deviceId", "0x01"), "deviceId"),
                command=COMMANDS[action],
                plan=plan,
                safety_key=safety_key,
            )
            self._raise_if_rejected(result)
            if action == "load" and plan is not None:
                expected_crc = proto.crc16_ccitt_false(plan.fields_bytes())
                ack = result["ack"]
                if ack["detail"] != expected_crc:
                    raise RuntimeError(f"LOAD_PLAN CRC mismatch: {ack['detailHex']} expected=0x{expected_crc:04X}")
            return result
        finally:
            self.command_lock.release()

    def _raise_if_rejected(self, result: dict[str, Any]) -> None:
        ack = result.get("ack")
        if ack is not None and not ack["ok"]:
            raise RuntimeError(f"{result['command']} rejected: {ack['result']} detail={ack['detailHex']}")

    def send_load_start(self, request: dict[str, Any]) -> dict[str, Any]:
        plan = self.build_plan(request.get("plan") or {})
        dest = parse_int(request.get("dest", "0x78"), "dest")
        device_id = parse_int(request.get("deviceId", "0x01"), "deviceId")
        with self.write_lock:
            result = self._send_command(dest, device_id, proto.CMD_LOAD_PLAN, plan, proto.SAFETY_KEY)
            crc = proto.crc16_ccitt_false(plan.fields_bytes())
            load_ack = result["ack"]
            if not load_ack["ok"] or load_ack["detail"] != crc:
                raise RuntimeError(
                    f"LOAD_PLAN failed: {load_ack['result']} detail={load_ack['detailHex']} expected=0x{crc:04X}"
                )
            self.log("ok", "LOAD_PLAN OK; sending START_PLAN", seq=result["seq"], planCrc=f"0x{crc:04X}")
            start = self._send_command(dest, device_id, proto.CMD_START_PLAN, plan, proto.SAFETY_KEY)
            start_ack = start["ack"]
            if not start_ack["ok"]:
                raise RuntimeError(f"START_PLAN failed: {start_ack['result']} detail={start_ack['detailHex']}")
        return {
            "seq": start["seq"],
            "dest": dest,
            "deviceId": device_id,
            "command": "LOAD_START",
            "load": result,
            "start": start,
            "ack": start_ack,
            "pendingStart": False,
            "planCrc": crc,
        }

    def _send_command(
        self,
        dest: int,
        device_id: int,
        command: int,
        plan: proto.ControlPlan | None,
        safety_key: int,
    ) -> dict[str, Any]:
        with self.lock:
            ser = self.serial_port
        if ser is None:
            raise RuntimeError("serial is not connected")
        seq = self._next_seq()
        raw = proto.build_cmd_frame(seq, device_id, command, plan, safety_key)
        app_line = proto.encode_app_uart(dest, raw)
        command_name = COMMAND_NAMES.get(command, f"0x{command:02X}")
        retry_timeouts = ACK_RETRY_TIMEOUTS if self._holds_write_lock(command) else LINK_ACK_RETRY_TIMEOUTS
        status_before = self._last_status_seq(device_id) if command == proto.CMD_REQUEST_STATUS else None
        payload = {
            "seq": seq,
            "dest": dest,
            "deviceId": device_id,
            "command": command_name,
            "raw": app_line.decode("ascii", errors="replace").strip(),
        }
        with self.ack_condition:
            self.ack_by_seq.pop(seq, None)
        if self._holds_write_lock(command):
            with self.write_lock:
                return self._send_command_attempts(ser, app_line, command, payload, retry_timeouts, status_before)
        return self._send_command_attempts(ser, app_line, command, payload, retry_timeouts, status_before)

    def _send_command_attempts(
        self,
        ser: Any,
        app_line: bytes,
        command: int,
        payload: dict[str, Any],
        retry_timeouts: tuple[float, ...],
        status_before: int | None,
    ) -> dict[str, Any]:
        command_name = payload["command"]
        write_locked = self._holds_write_lock(command)
        for attempt, base_timeout in enumerate(retry_timeouts, start=1):
            timeout = self._jittered_timeout(base_timeout)
            attempt_payload = {
                **payload,
                "attempt": attempt,
                "attempts": len(retry_timeouts),
                "ackWaitS": round(timeout, 3),
            }
            if write_locked:
                self._write_app_line(ser, app_line)
            else:
                with self.write_lock:
                    self._write_app_line(ser, app_line)
            self.hub.publish("tx", attempt_payload)
            self.log(
                "tx",
                f"{command_name} sent",
                seq=payload["seq"],
                dest=f"0x{payload['dest']:02X}",
                deviceId=f"0x{payload['deviceId']:02X}",
                attempt=f"{attempt}/{len(retry_timeouts)}",
                ackWaitS=f"{timeout:.2f}",
            )
            ack = self._wait_for_ack(payload["seq"], payload["deviceId"], timeout)
            if ack is not None:
                return {**payload, "attempt": attempt, "attempts": len(retry_timeouts), "ack": ack}
        if command == proto.CMD_REQUEST_STATUS:
            status = self._status_after(status_before, payload["deviceId"])
            if status is not None:
                self.log(
                    "warn",
                    "REQUEST_STATUS ACK timeout; using passive STATUS",
                    seq=payload["seq"],
                    statusSeq=status["statusSeq"],
                )
                return {
                    **payload,
                    "attempt": len(retry_timeouts),
                    "attempts": len(retry_timeouts),
                    "ack": None,
                    "status": status,
                    "statusOnly": True,
                }
        raise TimeoutError(f"ACK timeout for {command_name} seq={payload['seq']}")

    def _jittered_timeout(self, base_timeout: float) -> float:
        if ACK_RETRY_JITTER_FRACTION <= 0:
            return base_timeout
        return base_timeout + random.uniform(0.0, base_timeout * ACK_RETRY_JITTER_FRACTION)

    def _holds_write_lock(self, command: int) -> bool:
        return command in {proto.CMD_LOAD_PLAN, proto.CMD_START_PLAN, proto.CMD_STOP_SAFE}

    def _last_status_seq(self, device_id: int) -> int | None:
        with self.lock:
            status = self.last_status_by_device.get(device_id)
            if status is None:
                return None
            return status["statusSeq"]

    def _status_after(self, previous_seq: int | None, device_id: int) -> dict[str, Any] | None:
        with self.lock:
            status = self.last_status_by_device.get(device_id)
        if status is None:
            return None
        if previous_seq is None or status["statusSeq"] != previous_seq:
            return status
        return None

    def _write_app_line(self, ser: Any, app_line: bytes) -> None:
        ser.write(app_line)
        ser.flush()

    def _wait_for_ack(self, seq: int, device_id: int, timeout: float) -> dict[str, Any] | None:
        deadline = time.monotonic() + timeout
        with self.ack_condition:
            while True:
                ack = self.ack_by_seq.get(seq)
                if ack is not None and ack["deviceId"] == device_id:
                    return ack
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self.ack_condition.wait(remaining)

    def _reader_loop(self) -> None:
        while not self.stop_event.is_set():
            with self.lock:
                ser = self.serial_port
            if ser is None:
                break
            try:
                chunk = ser.read(4096)
            except Exception as exc:
                if not self.stop_event.is_set():
                    self.log("error", f"serial read failed: {exc}")
                    self.disconnect()
                break
            if not chunk:
                continue
            self.buffer += chunk
            while b"\n" in self.buffer:
                raw_line, self.buffer = self.buffer.split(b"\n", 1)
                raw_line = raw_line.rstrip(b"\r")
                self._handle_line(raw_line)

    def _handle_line(self, raw_line: bytes) -> None:
        text = raw_line.decode("ascii", errors="replace")
        self.hub.publish("raw_rx", {"line": text})
        app, app_error = proto.decode_app_uart(raw_line)
        if app_error:
            self.hub.publish("skip", {"reason": app_error, "line": text[:140]})
            return
        app, unwrap_error = proto.unwrap_app_frame(app)
        if unwrap_error or app is None:
            self.hub.publish("skip", {"reason": unwrap_error or "unwrap failed", "line": text[:140]})
            return
        if app.app_cmd != proto.APP_CMD:
            self.hub.publish("skip", {"reason": f"app_cmd=0x{app.app_cmd:02X}", "line": text[:140]})
            return
        payload = app.payload
        try:
            if len(payload) == proto.ACK_LEN and payload[2] == proto.PACKET_ACK:
                ack = proto.parse_ack(payload)
                self._handle_ack(ack)
            elif len(payload) == proto.STATUS_LEN and payload[2] == proto.PACKET_STATUS:
                status = proto.parse_status(payload)
                self._handle_status(status)
            else:
                self.hub.publish("skip", {"reason": f"payload len={len(payload)}", "line": text[:140]})
        except proto.ProtocolError as exc:
            self.log("error", f"parse failed: {exc}", line=text[:180])

    def _handle_ack(self, ack: proto.AckFrame) -> None:
        data = ack_to_json(ack)
        with self.ack_condition:
            self.last_ack = data
            if ack.acked_seq in self.ack_by_seq:
                self.ack_by_seq.pop(ack.acked_seq)
            self.ack_by_seq[ack.acked_seq] = data
            while len(self.ack_by_seq) > 128:
                self.ack_by_seq.pop(next(iter(self.ack_by_seq)))
            self.ack_condition.notify_all()
        self.hub.publish("ack", data)
        self.log(
            "ok" if data["ok"] else "error",
            f"ACK {data['command']} {data['result']}",
            seq=ack.acked_seq,
            state=data["state"],
            phase=data["phase"],
        )

    def _handle_status(self, status: proto.StatusFrame) -> None:
        data = status_to_json(status)
        with self.lock:
            self.last_status = data
            self.last_status_by_device[data["deviceId"]] = data
        self.hub.publish("status", data)
        self.log(
            "error" if data["errorFlags"] else "rx",
            f"STATUS {data['state']} / {data['phase']}",
            seq=status.status_seq,
            depth=data["depthText"],
            errors=data["errorFlagsHex"],
        )


def ack_to_json(ack: proto.AckFrame) -> dict[str, Any]:
    result = proto.result_name(ack.result_code)
    command = COMMAND_NAMES.get(ack.command_echo, f"0x{ack.command_echo:02X}")
    return {
        "ackedSeq": ack.acked_seq,
        "deviceId": ack.device_id,
        "command": command,
        "result": result,
        "resultCode": ack.result_code,
        "ok": ack.result_code
        in {
            proto.RESULT_OK,
            proto.RESULT_OK_DUPLICATE_ACK,
            proto.RESULT_OK_STOPPED,
            proto.RESULT_OK_STOPPED_LOCKOUT,
        },
        "state": STATE_NAMES.get(ack.control_state, f"0x{ack.control_state:02X}"),
        "phase": PHASE_NAMES.get(ack.phase, f"0x{ack.phase:02X}"),
        "activePlanId": ack.active_plan_id,
        "detail": ack.detail_u16,
        "detailHex": f"0x{ack.detail_u16:04X}",
        "valveBits": ack.valve_bits,
        "valveBitsHex": f"0x{ack.valve_bits:02X}",
        "errorFlagsLow": ack.error_flags_low,
        "errorFlagsLowHex": f"0x{ack.error_flags_low:02X}",
    }


def status_flags(flags: int) -> list[str]:
    names: list[str] = []
    if flags & proto.STATUS_GPS_VALID:
        names.append("GPS")
    if flags & proto.STATUS_SD_OK:
        names.append("SD")
    if flags & proto.STATUS_TEMP_OK:
        names.append("TEMP")
    if flags & proto.STATUS_DEPTH_OK:
        names.append("DEPTH")
    if flags & proto.STATUS_PLAN_VALID:
        names.append("PLAN")
    if flags & proto.STATUS_PC_LINK_RECENT:
        names.append("LINK")
    return names


def depth_text(value: int) -> str:
    if value == -0x8000:
        return "NA"
    return f"{value / 100:.2f} m"


def temp_text(value: int) -> str:
    if value == -0x8000:
        return "NA"
    return f"{value / 100:.2f} C"


def status_to_json(status: proto.StatusFrame) -> dict[str, Any]:
    return {
        "statusSeq": status.status_seq,
        "deviceId": status.device_id,
        "state": STATE_NAMES.get(status.control_state, f"0x{status.control_state:02X}"),
        "phase": PHASE_NAMES.get(status.phase, f"0x{status.phase:02X}"),
        "valveBits": status.valve_bits,
        "valveBitsHex": f"0x{status.valve_bits:02X}",
        "statusFlags": status.status_flags,
        "statusFlagNames": status_flags(status.status_flags),
        "activePlanId": status.active_plan_id,
        "cycleCount": status.cycle_count,
        "phaseElapsedS": status.phase_elapsed_s,
        "phaseRemainingS": status.phase_remaining_s,
        "depthCm": status.depth_cm,
        "depthText": depth_text(status.depth_cm),
        "maxDepthCm": status.max_depth_cm,
        "maxDepthText": f"{status.max_depth_cm / 100:.2f} m",
        "waterTempCentiC": status.water_temp_centi_c,
        "waterTempText": temp_text(status.water_temp_centi_c),
        "pressureMbar": status.pressure_mbar,
        "gpsSat": status.gps_sat,
        "lastCmdResult": status.last_cmd_result,
        "lastCmdResultName": proto.result_name(status.last_cmd_result),
        "lastCmdSeq": status.last_cmd_seq,
        "batteryMv": status.battery_mv,
        "errorFlags": status.error_flags,
        "errorFlagsHex": f"0x{status.error_flags:04X}",
        "pcSeenAgeS": status.pc_seen_age_s,
        "tweliteLqi": status.twelite_lqi,
    }


BACKEND = TritonBackend()


class TritonHttpServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request: Any, client_address: Any) -> None:
        exc_type, _, _ = sys.exc_info()
        if exc_type in {BrokenPipeError, ConnectionResetError}:
            return
        if DEBUG_TRACEBACKS:
            super().handle_error(request, client_address)


class Handler(BaseHTTPRequestHandler):
    server_version = "TritonWebGui/1.0"

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors()
        self.end_headers()

    def do_HEAD(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path in {"", "/"}:
            dist = pathlib.Path(__file__).resolve().parent / "dist"
            target = dist / "index.html"
            if target.exists():
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(target.stat().st_size))
                self.end_headers()
                return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/ports":
                self._json({"ports": find_serial_ports()})
            elif parsed.path == "/api/snapshot":
                self._json(BACKEND.snapshot())
            elif parsed.path == "/events":
                self._events()
            else:
                self._static(parsed.path)
        except Exception as exc:
            self._json_error(exc)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            body = self._read_json()
            if parsed.path == "/api/connect":
                self._json(BACKEND.connect(str(body.get("port", ""))))
            elif parsed.path == "/api/disconnect":
                self._json(BACKEND.disconnect())
            elif parsed.path == "/api/command":
                self._json(BACKEND.send_command_request(body))
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
        except Exception as exc:
            self._json_error(exc)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _json_error(self, exc: Exception) -> None:
        if DEBUG_TRACEBACKS:
            traceback.print_exc()
        BACKEND.log("error", str(exc))
        self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)

    def _events(self) -> None:
        subscriber = BACKEND.hub.subscribe()
        self.send_response(HTTPStatus.OK)
        self._cors()
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        self.wfile.write(b": connected\n\n")
        self.wfile.flush()
        try:
            while True:
                try:
                    event = subscriber.get(timeout=15)
                    data = json.dumps(event, ensure_ascii=False).encode("utf-8")
                    self.wfile.write(b"data: " + data + b"\n\n")
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            BACKEND.hub.unsubscribe(subscriber)

    def _static(self, path: str) -> None:
        dist = pathlib.Path(__file__).resolve().parent / "dist"
        if path in {"", "/"}:
            target = dist / "index.html"
        else:
            clean = pathlib.PurePosixPath(path.lstrip("/"))
            target = dist / clean
        resolved_target = target.resolve()
        inside_dist = resolved_target == dist or dist in resolved_target.parents
        if not target.exists() or not target.is_file() or not inside_dist:
            target = dist / "index.html"
        if not target.exists():
            self.send_error(HTTPStatus.NOT_FOUND, "React build not found. Run: npm run build")
            return
        content_type = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".ico": "image/x-icon",
        }.get(target.suffix, "application/octet-stream")
        raw = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, fmt: str, *args: Any) -> None:
        return


def create_server() -> tuple[TritonHttpServer, int]:
    last_error: OSError | None = None
    for candidate in range(PORT, PORT + max(1, PORT_SCAN_COUNT)):
        try:
            return TritonHttpServer((HOST, candidate), Handler), candidate
        except OSError as exc:
            if exc.errno != errno.EADDRINUSE:
                raise
            last_error = exc
    end_port = PORT + max(1, PORT_SCAN_COUNT) - 1
    raise RuntimeError(f"No free port found from {PORT} to {end_port}") from last_error


def main() -> int:
    server, bound_port = create_server()
    if bound_port != PORT:
        print(f"Port {PORT} is already in use; using {bound_port} instead.")
    print(f"Triton-3 React GUI: http://{HOST}:{bound_port}")
    print("Press Ctrl-C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        BACKEND.disconnect()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
