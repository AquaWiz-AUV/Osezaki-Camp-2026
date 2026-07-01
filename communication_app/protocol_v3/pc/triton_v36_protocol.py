#!/usr/bin/env python3
from __future__ import annotations

import dataclasses
import struct


APP_CMD = 0x31
APP_EXTENDED_CMD = 0xA0
PARENT_ID = 0x00
HEADER = 0x24
FOOTER = 0x3B
PROTOCOL_VERSION = 0x02

PACKET_CMD = 0x10
PACKET_ACK = 0x11
PACKET_STATUS = 0x12

CMD_NOP = 0x00
CMD_LOAD_PLAN = 0x01
CMD_START_PLAN = 0x02
CMD_STOP_SAFE = 0x03
CMD_REQUEST_STATUS = 0x04

FLAG_DEPTH_TRIGGER_ENABLE = 0x01
FLAG_MAX_DEPTH_ENABLE = 0x02
FLAG_COMM_TIMEOUT_ENABLE = 0x04
FLAG_ALLOW_INFINITE_REPEAT = 0x08
FLAG_REQUIRE_DEPTH_SENSOR = 0x10
FLAG_RESERVED_MASK = 0xE0

POLICY_STOP_SAFE_ONLY = 0x00
SAFETY_KEY = 0xA55A

STATE_SAFE_IDLE = 0x00
STATE_PLAN_LOADED = 0x01
STATE_RUNNING = 0x02
STATE_COMPLETED = 0x03
STATE_ERROR_LOCKOUT = 0x04

PHASE_IDLE = 0x00
PHASE_PREPARE = 0x01
PHASE_EXHAUST_OPEN = 0x02
PHASE_DESCENT_COAST = 0x03
PHASE_BOTTOM_WAIT = 0x04
PHASE_INJECTION_OPEN = 0x05
PHASE_ASCENT_WAIT = 0x06
PHASE_COMPLETE = 0x07
PHASE_ERROR = 0x08

RESULT_OK = 0x00
RESULT_OK_DUPLICATE_ACK = 0x01
RESULT_OK_STOPPED = 0x02
RESULT_OK_STOPPED_LOCKOUT = 0x03
RESULT_REJECT_BAD_CRC = 0x10
RESULT_REJECT_BAD_FORMAT = 0x11
RESULT_REJECT_BAD_PROTOCOL = 0x12
RESULT_REJECT_BAD_DEVICE = 0x13
RESULT_REJECT_SEQ_MISMATCH = 0x14
RESULT_REJECT_BAD_SAFETY_KEY = 0x15
RESULT_REJECT_BAD_STATE = 0x16
RESULT_REJECT_PLAN_NOT_LOADED = 0x17
RESULT_REJECT_PLAN_MISMATCH = 0x18
RESULT_REJECT_PLAN_EXPIRED = 0x19
RESULT_REJECT_BAD_PARAM = 0x1A
RESULT_REJECT_SENSOR_REQUIRED = 0x1B
RESULT_REJECT_BUSY_RUNNING = 0x1C
RESULT_REJECT_UNKNOWN_COMMAND = 0x1D

ERR_BAD_CRC = 0x0001
ERR_COMM_TIMEOUT = 0x0010
ERR_MAX_DEPTH = 0x0020
ERR_VALVE_CONFLICT = 0x0040
ERR_PLAN_EXPIRED = 0x0080
ERR_BAD_PARAM = 0x0100
ERR_ERROR_LOCKOUT = 0x0200
ERR_SENSOR_STALE = 0x0400

STATUS_GPS_VALID = 0x01
STATUS_SD_OK = 0x02
STATUS_TEMP_OK = 0x04
STATUS_DEPTH_OK = 0x08
STATUS_PLAN_VALID = 0x10
STATUS_PC_LINK_RECENT = 0x20

CMD_LEN = 40
ACK_LEN = 20
STATUS_LEN = 40
APP_LINE_BUF_RECOMMENDED = 128


class ProtocolError(ValueError):
    pass


@dataclasses.dataclass(frozen=True)
class ControlPlan:
    plan_flags: int = 0
    max_runtime_min: int = 0
    plan_id: int = 1
    repeat_count: int = 1
    prepare_s: int = 0
    exhaust_open_s: int = 0
    descent_coast_s: int = 0
    bottom_wait_s: int = 0
    injection_open_s: int = 20
    ascent_wait_s: int = 0
    depth_trigger_cm: int = 0
    max_depth_cm: int = 0
    log_interval_100ms: int = 5
    status_interval_100ms: int = 10
    comm_timeout_s: int = 0
    safety_policy: int = POLICY_STOP_SAFE_ONLY

    def fields_bytes(self) -> bytes:
        values = [
            self.plan_flags,
            self.max_runtime_min,
            self.plan_id,
            self.repeat_count,
            self.prepare_s,
            self.exhaust_open_s,
            self.descent_coast_s,
            self.bottom_wait_s,
            self.injection_open_s,
            self.ascent_wait_s,
            self.depth_trigger_cm,
            self.max_depth_cm,
            self.log_interval_100ms,
            self.status_interval_100ms,
            self.comm_timeout_s,
            self.safety_policy,
        ]
        _check_ranges(values)
        return struct.pack(
            ">BBHHHHHHHHHHHHBB",
            self.plan_flags,
            self.max_runtime_min,
            self.plan_id,
            self.repeat_count,
            self.prepare_s,
            self.exhaust_open_s,
            self.descent_coast_s,
            self.bottom_wait_s,
            self.injection_open_s,
            self.ascent_wait_s,
            self.depth_trigger_cm,
            self.max_depth_cm,
            self.log_interval_100ms,
            self.status_interval_100ms,
            self.comm_timeout_s,
            self.safety_policy,
        )


@dataclasses.dataclass(frozen=True)
class AppFrame:
    logical_id: int
    app_cmd: int
    payload: bytes


@dataclasses.dataclass(frozen=True)
class AckFrame:
    acked_seq: int
    device_id: int
    command_echo: int
    result_code: int
    control_state: int
    phase: int
    active_plan_id: int
    detail_u16: int
    valve_bits: int
    error_flags_low: int


@dataclasses.dataclass(frozen=True)
class StatusFrame:
    status_seq: int
    device_id: int
    control_state: int
    phase: int
    valve_bits: int
    status_flags: int
    active_plan_id: int
    cycle_count: int
    phase_elapsed_s: int
    phase_remaining_s: int
    depth_cm: int
    max_depth_cm: int
    water_temp_centi_c: int
    pressure_mbar: int
    gps_sat: int
    last_cmd_result: int
    last_cmd_seq: int
    battery_mv: int
    error_flags: int
    pc_seen_age_s: int
    twelite_lqi: int


def _check_ranges(values: list[int]) -> None:
    for value in values:
        if not 0 <= value <= 0xFFFF:
            raise ProtocolError("plan field out of uint16 range")
    if not 0 <= values[0] <= 0xFF or not 0 <= values[1] <= 0xFF:
        raise ProtocolError("byte plan field out of range")
    if not 0 <= values[-2] <= 0xFF or not 0 <= values[-1] <= 0xFF:
        raise ProtocolError("byte plan field out of range")


def validate_control_plan(plan: ControlPlan) -> list[str]:
    errors: list[str] = []
    if plan.plan_flags & FLAG_RESERVED_MASK:
        errors.append("reserved plan_flags bits must be 0")
    if plan.plan_id == 0:
        errors.append("plan_id must be 1..65535")
    if plan.repeat_count == 0:
        errors.append("repeat_count must be 1..65535")
    if plan.prepare_s > 3600:
        errors.append("prepare_s must be 0..3600")
    if plan.exhaust_open_s > 600:
        errors.append("exhaust_open_s must be 0..600")
    if plan.descent_coast_s > 3600:
        errors.append("descent_coast_s must be 0..3600")
    if plan.bottom_wait_s > 3600:
        errors.append("bottom_wait_s must be 0..3600")
    if not 1 <= plan.injection_open_s <= 600:
        errors.append("injection_open_s must be 1..600")
    if plan.ascent_wait_s > 3600:
        errors.append("ascent_wait_s must be 0..3600")
    if plan.depth_trigger_cm > 6000:
        errors.append("depth_trigger_cm must be 0..6000")
    if plan.max_depth_cm > 8000:
        errors.append("max_depth_cm must be 0..8000")
    if not 5 <= plan.log_interval_100ms <= 600:
        errors.append("log_interval_100ms must be 5..600")
    if not 5 <= plan.status_interval_100ms <= 600:
        errors.append("status_interval_100ms must be 5..600")
    if not 0 <= plan.comm_timeout_s <= 255:
        errors.append("comm_timeout_s must be 0..255")
    if not 0 <= plan.max_runtime_min <= 255:
        errors.append("max_runtime_min must be 0..255")
    if plan.safety_policy != POLICY_STOP_SAFE_ONLY:
        errors.append("safety_policy must be STOP_SAFE_ONLY")
    if (plan.plan_flags & FLAG_DEPTH_TRIGGER_ENABLE) and plan.depth_trigger_cm == 0:
        errors.append("DEPTH_TRIGGER_ENABLE requires depth_trigger_cm > 0")
    if (plan.plan_flags & FLAG_MAX_DEPTH_ENABLE) and plan.max_depth_cm == 0:
        errors.append("MAX_DEPTH_ENABLE requires max_depth_cm > 0")
    if (plan.plan_flags & FLAG_COMM_TIMEOUT_ENABLE) and plan.comm_timeout_s == 0:
        errors.append("COMM_TIMEOUT_ENABLE requires comm_timeout_s > 0")
    if plan.repeat_count == 0xFFFF:
        if not (plan.plan_flags & FLAG_ALLOW_INFINITE_REPEAT):
            errors.append("repeat_count=0xFFFF requires ALLOW_INFINITE_REPEAT")
        if plan.max_runtime_min == 0:
            errors.append("repeat_count=0xFFFF requires max_runtime_min > 0")
    if (
        plan.plan_flags & FLAG_DEPTH_TRIGGER_ENABLE
        and plan.plan_flags & FLAG_MAX_DEPTH_ENABLE
        and plan.max_depth_cm < plan.depth_trigger_cm + 200
    ):
        errors.append("max_depth_cm must be at least depth_trigger_cm + 200")
    return errors


def crc16_ccitt_false(data: bytes) -> int:
    crc = 0xFFFF
    for value in data:
        crc ^= value << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
    return crc


def app_lrc8(raw_without_lrc: bytes) -> int:
    return (-sum(raw_without_lrc)) & 0xFF


def build_cmd_frame(
    seq: int,
    device_id: int,
    command: int,
    plan: ControlPlan | None = None,
    safety_key: int = 0,
) -> bytes:
    plan_fields = b"\x00" * 28 if plan is None else plan.fields_bytes()
    frame = bytearray()
    frame.extend([HEADER, PROTOCOL_VERSION, PACKET_CMD])
    frame.extend(struct.pack(">HBB", seq & 0xFFFF, device_id & 0xFF, command & 0xFF))
    frame.extend(plan_fields)
    frame.extend(struct.pack(">H", safety_key & 0xFFFF))
    crc = crc16_ccitt_false(bytes(frame))
    frame.extend(struct.pack(">H", crc))
    frame.append(FOOTER)
    if len(frame) != CMD_LEN:
        raise AssertionError(f"CMD length bug: {len(frame)}")
    return bytes(frame)


def build_ack_frame(
    acked_seq: int,
    device_id: int,
    command_echo: int,
    result_code: int,
    control_state: int,
    phase: int,
    active_plan_id: int = 0,
    detail_u16: int = 0,
    valve_bits: int = 0,
    error_flags_low: int = 0,
) -> bytes:
    frame = bytearray()
    frame.extend([HEADER, PROTOCOL_VERSION, PACKET_ACK])
    frame.extend(struct.pack(
        ">HBBBBBHHBBB",
        acked_seq & 0xFFFF,
        device_id & 0xFF,
        command_echo & 0xFF,
        result_code & 0xFF,
        control_state & 0xFF,
        phase & 0xFF,
        active_plan_id & 0xFFFF,
        detail_u16 & 0xFFFF,
        valve_bits & 0xFF,
        error_flags_low & 0xFF,
        0,
    ))
    frame.extend(struct.pack(">H", crc16_ccitt_false(bytes(frame))))
    frame.append(FOOTER)
    if len(frame) != ACK_LEN:
        raise AssertionError(f"ACK length bug: {len(frame)}")
    return bytes(frame)


def build_status_frame(
    status_seq: int,
    device_id: int,
    control_state: int,
    phase: int,
    valve_bits: int = 0,
    status_flags: int = 0,
    active_plan_id: int = 0,
    cycle_count: int = 0,
    phase_elapsed_s: int = 0,
    phase_remaining_s: int = 0,
    depth_cm: int = 0,
    max_depth_cm: int = 0,
    water_temp_centi_c: int = 0,
    pressure_mbar: int = 0,
    gps_sat: int = 0,
    last_cmd_result: int = 0,
    last_cmd_seq: int = 0,
    battery_mv: int = 0xFFFF,
    error_flags: int = 0,
    pc_seen_age_s: int = 255,
    twelite_lqi: int = 0xFF,
) -> bytes:
    # Spec 19.3: the invalid sentinel for the signed int16 fields is INT16_MIN = 0x8000.
    # Accept the literal 0x8000 (the value the spec tells implementers to use) as well as
    # the equivalent signed -32768, so callers can pass either form.
    if depth_cm == 0x8000:
        depth_cm = -0x8000
    if water_temp_centi_c == 0x8000:
        water_temp_centi_c = -0x8000
    frame = bytearray()
    frame.extend([HEADER, PROTOCOL_VERSION, PACKET_STATUS])
    frame.extend(struct.pack(
        ">HBBBBBHHHHhHhHBBHHHBBB",
        status_seq & 0xFFFF,
        device_id & 0xFF,
        control_state & 0xFF,
        phase & 0xFF,
        valve_bits & 0xFF,
        status_flags & 0xFF,
        active_plan_id & 0xFFFF,
        cycle_count & 0xFFFF,
        phase_elapsed_s & 0xFFFF,
        phase_remaining_s & 0xFFFF,
        depth_cm,
        max_depth_cm & 0xFFFF,
        water_temp_centi_c,
        pressure_mbar & 0xFFFF,
        gps_sat & 0xFF,
        last_cmd_result & 0xFF,
        last_cmd_seq & 0xFFFF,
        battery_mv & 0xFFFF,
        error_flags & 0xFFFF,
        pc_seen_age_s & 0xFF,
        twelite_lqi & 0xFF,
        0,
    ))
    frame.extend(struct.pack(">H", crc16_ccitt_false(bytes(frame))))
    frame.append(FOOTER)
    if len(frame) != STATUS_LEN:
        raise AssertionError(f"STATUS length bug: {len(frame)}")
    return bytes(frame)


def encode_app_uart(logical_id: int, payload: bytes, app_cmd: int = APP_CMD) -> bytes:
    raw = bytes([logical_id & 0xFF, app_cmd & 0xFF]) + bytes(payload)
    raw += bytes([app_lrc8(raw)])
    return b":" + raw.hex().upper().encode("ascii") + b"\r\n"


def decode_app_uart(line: str | bytes) -> tuple[AppFrame | None, str | None]:
    if isinstance(line, bytes):
        try:
            line = line.decode("ascii")
        except UnicodeDecodeError:
            return None, "non-ascii"
    line = line.strip()
    if not line.startswith(":"):
        return None, "missing colon"
    hex_text = line[1:]
    if len(hex_text) & 1:
        return None, "odd hex"
    try:
        raw = bytes.fromhex(hex_text)
    except ValueError:
        return None, "invalid hex"
    if len(raw) < 3:
        return None, "too short"
    if sum(raw) & 0xFF:
        return None, "bad lrc"
    return AppFrame(raw[0], raw[1], raw[2:-1]), None


def unwrap_app_frame(frame: AppFrame) -> tuple[AppFrame | None, str | None]:
    if frame.app_cmd != APP_EXTENDED_CMD:
        return frame, None
    if len(frame.payload) < 12:
        return None, "extended too short"
    data_len = int.from_bytes(frame.payload[10:12], "big")
    data = frame.payload[12:12 + data_len]
    if len(data) != data_len:
        return None, "extended length mismatch"
    return AppFrame(frame.logical_id, frame.payload[0], data), None


def verify_raw_frame(raw: bytes, expected_packet: int | None = None) -> str | None:
    if len(raw) not in (CMD_LEN, ACK_LEN, STATUS_LEN):
        return "bad length"
    if raw[0] != HEADER or raw[-1] != FOOTER:
        return "bad header/footer"
    if raw[1] != PROTOCOL_VERSION:
        return "bad protocol"
    if expected_packet is not None and raw[2] != expected_packet:
        return "bad packet type"
    if raw[2] == PACKET_ACK and len(raw) != ACK_LEN:
        return "bad ACK length"
    if raw[2] in (PACKET_CMD, PACKET_STATUS) and len(raw) != CMD_LEN:
        return "bad frame length"
    crc_offset = 17 if len(raw) == ACK_LEN else 37
    expected_crc = int.from_bytes(raw[crc_offset:crc_offset + 2], "big")
    actual_crc = crc16_ccitt_false(raw[:crc_offset])
    if expected_crc != actual_crc:
        return "bad crc"
    return None


def parse_ack(raw: bytes) -> AckFrame:
    error = verify_raw_frame(raw, PACKET_ACK)
    if error:
        raise ProtocolError(error)
    fields = struct.unpack(">HBBBBBHHBBB", raw[3:17])
    return AckFrame(*fields[:-1])


def parse_status(raw: bytes) -> StatusFrame:
    error = verify_raw_frame(raw, PACKET_STATUS)
    if error:
        raise ProtocolError(error)
    fields = struct.unpack(">HBBBBBHHHHhHhHBBHHHBBB", raw[3:37])
    return StatusFrame(*fields[:-1])


def frame_plan_fields(raw_cmd: bytes) -> bytes:
    if len(raw_cmd) != CMD_LEN:
        raise ProtocolError("CMD length required")
    return raw_cmd[7:35]


def frame_plan_id(raw_cmd: bytes) -> int:
    if len(raw_cmd) != CMD_LEN:
        raise ProtocolError("CMD length required")
    return int.from_bytes(raw_cmd[9:11], "big")


def frame_seq(raw_cmd: bytes) -> int:
    return int.from_bytes(raw_cmd[3:5], "big")


def frame_command(raw_cmd: bytes) -> int:
    return raw_cmd[6]


def result_name(code: int) -> str:
    names = {
        RESULT_OK: "OK",
        RESULT_OK_DUPLICATE_ACK: "OK_DUPLICATE_ACK",
        RESULT_OK_STOPPED: "OK_STOPPED",
        RESULT_OK_STOPPED_LOCKOUT: "OK_STOPPED_LOCKOUT",
        RESULT_REJECT_BAD_CRC: "REJECT_BAD_CRC",
        RESULT_REJECT_BAD_FORMAT: "REJECT_BAD_FORMAT",
        RESULT_REJECT_BAD_PROTOCOL: "REJECT_BAD_PROTOCOL",
        RESULT_REJECT_BAD_DEVICE: "REJECT_BAD_DEVICE",
        RESULT_REJECT_SEQ_MISMATCH: "REJECT_SEQ_MISMATCH",
        RESULT_REJECT_BAD_SAFETY_KEY: "REJECT_BAD_SAFETY_KEY",
        RESULT_REJECT_BAD_STATE: "REJECT_BAD_STATE",
        RESULT_REJECT_PLAN_NOT_LOADED: "REJECT_PLAN_NOT_LOADED",
        RESULT_REJECT_PLAN_MISMATCH: "REJECT_PLAN_MISMATCH",
        RESULT_REJECT_PLAN_EXPIRED: "REJECT_PLAN_EXPIRED",
        RESULT_REJECT_BAD_PARAM: "REJECT_BAD_PARAM",
        RESULT_REJECT_SENSOR_REQUIRED: "REJECT_SENSOR_REQUIRED",
        RESULT_REJECT_BUSY_RUNNING: "REJECT_BUSY_RUNNING",
        RESULT_REJECT_UNKNOWN_COMMAND: "REJECT_UNKNOWN_COMMAND",
    }
    return names.get(code, f"0x{code:02X}")
