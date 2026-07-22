#!/usr/bin/env python3
"""Conservative automatic test for TWELITE interactive-mode transitions."""

from __future__ import annotations

import argparse
import contextlib
import io
import re
import sys
import time
from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable

import stick_test as common


ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
NEW_CONFIG_RE = re.compile(r"^\s*\[CONFIG(?: MENU)?/[^\]\r\n]+", re.MULTILINE | re.IGNORECASE)
OLD_CONFIG_RE = re.compile(r"^\s*---\s*CONFIG/[^\r\n]+", re.MULTILINE | re.IGNORECASE)
SID_RE = re.compile(r"SID\s*=\s*(?:0x)?([0-9A-F]{8})", re.IGNORECASE)
VERSION_RE = re.compile(r"(?:^|[/ ])v?(\d+(?:[-._]\d+){1,2})", re.IGNORECASE)
SETTING_RE = re.compile(
    r"^\s*([A-Za-z])\s*:[^\r\n(\[]*"
    r"(?:\(\s*([^\r\n)]*?)\s*\)|\[\s*([^\r\n\]]*?)\s*\])",
    re.MULTILINE,
)
class DeviceState(Enum):
    UNKNOWN = "UNKNOWN"
    APP_EXPECTED = "APP_EXPECTED"
    INTERACTIVE = "INTERACTIVE"


@dataclass(frozen=True)
class MenuInfo:
    detected: bool
    app_uart: bool
    serial_id: str | None
    version: str | None
    settings: dict[str, str]
    esc_supported: bool
    header: str


@dataclass(frozen=True)
class Check:
    name: str
    status: str
    detail: str


def clean_terminal(text: str) -> str:
    return ANSI_RE.sub("", text).replace("\x00", "")


def parse_settings(text: str) -> dict[str, str]:
    clean = clean_terminal(text)
    settings: dict[str, str] = {}
    for match in SETTING_RE.finditer(clean):
        key = match.group(1)
        # Current firmware uses (...); old App_Uart uses [...] for header h.
        # Footer commands S/R/!/:/* have neither and are naturally excluded.
        value = match.group(2) if match.group(2) is not None else match.group(3)
        settings[key] = " ".join(value.split())
    return settings


def parse_menu(text: str) -> MenuInfo:
    clean = clean_terminal(text)
    header_match = NEW_CONFIG_RE.search(clean) or OLD_CONFIG_RE.search(clean)
    header = header_match.group(0).strip() if header_match else ""
    sid_match = SID_RE.search(clean)
    version_match = VERSION_RE.search(header)
    settings = parse_settings(clean)
    # Requiring a CONFIG header, SID and at least two settings avoids matching
    # ordinary radio payloads that happen to contain one menu-like word.
    detected = bool(header_match and sid_match and len(settings) >= 2)
    app_uart = bool(re.search(r"APP[_ ]?UART|TWE UART APP|UART APP", header, re.IGNORECASE))
    esc_supported = bool(re.search(r"\[ESC\]\s*:\s*Exit", clean, re.IGNORECASE))
    return MenuInfo(
        detected=detected,
        app_uart=app_uart,
        serial_id=sid_match.group(1).upper() if sid_match else None,
        version=version_match.group(1) if version_match else None,
        settings=settings,
        esc_supported=esc_supported,
        header=header,
    )


def parse_leading_int(value: str | None, base: int = 10) -> int | None:
    if not value:
        return None
    pattern = r"0x[0-9A-Fa-f]+|[0-9]+" if base == 0 else r"[0-9]+"
    match = re.search(pattern, value)
    if not match:
        return None
    return int(match.group(0), base)


def parse_decimal_list(value: str | None) -> tuple[int, ...]:
    if not value:
        return ()
    return tuple(int(item, 10) for item in re.findall(r"[0-9]+", value))


def compare_menus(expected: MenuInfo, actual: MenuInfo) -> tuple[bool, str]:
    identity_changed: list[str] = []
    if expected.app_uart != actual.app_uart:
        identity_changed.append("firmware")
    if expected.serial_id != actual.serial_id:
        identity_changed.append("serial_id")
    if expected.version != actual.version:
        identity_changed.append("version")

    if expected.settings == actual.settings and not identity_changed:
        return True, f"device identity and {len(expected.settings)} displayed settings unchanged"
    changed = sorted(
        key for key in expected.settings.keys() | actual.settings.keys()
        if expected.settings.get(key) != actual.settings.get(key)
    )
    detail: list[str] = []
    if identity_changed:
        detail.append("identity=" + ",".join(identity_changed))
    if changed:
        detail.append("settings=" + ",".join(changed))
    return False, "changed_or_missing=" + ";".join(detail)


class InteractiveTester:
    def __init__(
        self,
        ser: Any,
        *,
        profile: str,
        expected_app_id: int,
        expected_channel: int,
        cycles: int,
        plus_interval: float,
        timeout: float,
        test_escape: bool,
        raw: bool,
        now: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.ser = ser
        self.profile = profile
        self.expected_app_id = expected_app_id
        self.expected_channel = expected_channel
        self.cycles = cycles
        self.plus_interval = plus_interval
        self.timeout = timeout
        self.test_escape = test_escape
        self.raw = raw
        self.now = now
        self.sleep = sleep
        self.state = DeviceState.UNKNOWN
        self.esc_supported = False
        self.esc_verified = False
        self.baseline: MenuInfo | None = None
        self.checks: list[Check] = []
        self.sent_bytes = bytearray()

    def report(self, name: str, status: str, detail: str) -> None:
        self.checks.append(Check(name, status, detail))
        print(f"{status}: {name}: {detail}")

    def reset_input(self) -> None:
        self.ser.reset_input_buffer()

    def write_exact(self, data: bytes) -> None:
        written = self.ser.write(data)
        if isinstance(written, int) and 0 <= written <= len(data):
            self.sent_bytes.extend(data[:written])
        if written != len(data):
            raise RuntimeError(f"serial partial write: {written}/{len(data)}")
        self.ser.flush()

    def collect(self, total_timeout: float | None = None, idle_timeout: float = 0.20) -> str:
        total = self.timeout if total_timeout is None else total_timeout
        deadline = self.now() + total
        idle_deadline: float | None = None
        data = bytearray()
        while self.now() < deadline:
            chunk = self.ser.read(4096)
            if chunk:
                data.extend(chunk)
                idle_deadline = self.now() + idle_timeout
                continue
            if data and idle_deadline is not None and self.now() >= idle_deadline:
                break
            self.sleep(0.01)
        text = data.decode("utf-8", errors="replace")
        if self.raw and text:
            print("--- RAW START ---")
            print(repr(text))
            print("--- RAW END ---")
        return text

    def pulse_plus(self) -> str:
        # State becomes unknown as soon as a toggle starts: interruption after
        # the third '+' can otherwise make cleanup toggle in the wrong direction.
        self.state = DeviceState.UNKNOWN
        self.reset_input()
        for _ in range(3):
            self.write_exact(b"+")
            self.sleep(self.plus_interval)
        return self.collect()

    def press_cr(self) -> str:
        if self.state != DeviceState.INTERACTIVE:
            raise RuntimeError("internal safety guard: CR is allowed only in confirmed interactive mode")
        self.reset_input()
        self.write_exact(b"\r")
        return self.collect(total_timeout=min(self.timeout, 1.2))

    def press_escape(self) -> str:
        if self.state != DeviceState.INTERACTIVE:
            raise RuntimeError("internal safety guard: ESC is allowed only in confirmed interactive mode")
        if not self.esc_supported:
            raise RuntimeError("internal safety guard: current menu does not advertise ESC exit")
        self.state = DeviceState.UNKNOWN
        self.reset_input()
        self.write_exact(b"\x1b")
        return self.collect(total_timeout=min(self.timeout, 1.2))

    def recognize_menu(self, text: str) -> MenuInfo:
        menu = parse_menu(text)
        if menu.detected:
            self.state = DeviceState.INTERACTIVE
            self.esc_supported = self.esc_supported or menu.esc_supported
        return menu

    def synchronize(self) -> MenuInfo | None:
        # Drain boot/stale bytes, but never use them as state evidence. Only a
        # menu caused by this process's immediately preceding +++ confirms the
        # current interactive state.
        self.collect(total_timeout=min(self.timeout, 0.5))

        # Initial state can be APP or the interactive top menu. Official +++
        # entry prints the menu automatically, so no CR is ever sent while the
        # state is unknown. Two toggles converge from either initial state.
        for attempt in (1, 2):
            text = self.pulse_plus()
            menu = self.recognize_menu(text)
            if menu.detected:
                self.report("SYNC", "PASS", f"interactive menu detected after toggle {attempt}")
                return menu
        self.report("SYNC", "FAIL", "state unknown after two toggles; hardware reset required")
        return None

    def validate_config(self, menu: MenuInfo) -> None:
        settings = menu.settings
        self.report("FIRMWARE", "PASS" if menu.app_uart else "FAIL", menu.header or "header missing")
        self.report("FIRMWARE_VERSION", "PASS" if menu.version else "FAIL", menu.version or "missing")
        self.report("SERIAL_ID", "PASS" if menu.serial_id else "FAIL", menu.serial_id or "missing")

        app_id = parse_leading_int(settings.get("a"), 0)
        self.report(
            "APPLICATION_ID",
            "PASS" if app_id == self.expected_app_id else "FAIL",
            f"actual={app_id!r} expected=0x{self.expected_app_id:08X}",
        )
        channels = parse_decimal_list(settings.get("c"))
        self.report(
            "CHANNEL",
            "PASS" if channels == (self.expected_channel,) else "FAIL",
            f"actual={channels!r} expected=({self.expected_channel},)",
        )
        logical_id = parse_leading_int(settings.get("i"))
        logical_ok = logical_id == 121 if self.profile == "stick" else (
            logical_id is not None and (1 <= logical_id <= 100 or logical_id == 120)
        )
        expected = "121(parent)" if self.profile == "stick" else "1..100 or 120(child)"
        self.report("LOGICAL_ID", "PASS" if logical_ok else "FAIL", f"actual={logical_id!r} expected={expected}")

        mode = settings.get("m", "").strip().upper()
        self.report("UART_MODE", "PASS" if mode == "A" else "FAIL", f"actual={mode or 'missing'} expected=A")

        uart = " ".join(value for key in ("b", "B") if (value := settings.get(key)))
        framing_ok = bool(re.search(r"8N1", uart, re.IGNORECASE))
        self.report("UART_FRAMING", "PASS" if framing_ok else "WARN", f"stored={uart or 'not displayed'}; host=8N1")

        role = parse_leading_int(settings.get("r"), 0)
        self.report("NETWORK_ROLE", "PASS" if role == 0 else "FAIL", f"actual={role!r} expected=0")

        encryption = parse_leading_int(settings.get("C"))
        self.report("ENCRYPTION", "PASS" if encryption == 0 else "FAIL", f"actual={encryption!r} expected=0")

        option_bits = parse_leading_int(settings.get("o"), 0)
        response_ok = option_bits is not None and not bool(option_bits & 0x00001000)
        self.report(
            "TX_RESPONSE_OPTION",
            "PASS" if response_ok else "FAIL",
            f"actual={option_bits!r}; bit 0x00001000 must be clear for PING diagnostics",
        )

    def redraw(self, expected: MenuInfo) -> None:
        refreshed = self.recognize_menu(self.press_cr())
        if not refreshed.detected:
            # Bare Enter redraw is not guaranteed on every old firmware.
            self.state = DeviceState.INTERACTIVE
            self.report("REDRAW", "WARN", "CR produced no full menu; transition tests continue")
            return
        same, detail = compare_menus(expected, refreshed)
        self.report("REDRAW", "PASS" if same else "FAIL", detail)

    def exit_and_reenter_with_plus(self, cycle: int) -> MenuInfo | None:
        exit_text = self.pulse_plus()  # known interactive -> expected APP
        exit_menu = self.recognize_menu(exit_text)
        if exit_menu.detected:
            self.report(f"CYCLE_{cycle}", "FAIL", "first +++ did not leave the CONFIG menu")
            return None
        # Positive exit proof is a successful re-entry using the next toggle.
        text = self.pulse_plus()
        menu = self.recognize_menu(text)
        if not menu.detected:
            self.report(f"CYCLE_{cycle}", "FAIL", "+++ exit/re-entry was not reproducible; state unknown")
            return None
        same, detail = compare_menus(self.baseline or menu, menu)
        self.report(f"CYCLE_{cycle}", "PASS" if same else "FAIL", f"+++ exit/re-enter; {detail}")
        return menu

    def test_escape_exit(self) -> bool:
        if not self.test_escape:
            self.report("ESC_EXIT", "SKIP", "disabled by --skip-esc")
            return True
        if not self.esc_supported:
            self.report("ESC_EXIT", "SKIP", "current menu does not advertise [ESC]:Exit")
            return True

        exit_text = self.press_escape()  # known interactive -> expected APP
        exit_menu = self.recognize_menu(exit_text)
        if exit_menu.detected:
            self.report("ESC_EXIT", "FAIL", "ESC did not leave the CONFIG menu")
            return False
        text = self.pulse_plus()  # expected APP -> interactive
        menu = self.recognize_menu(text)
        if not menu.detected:
            self.report("ESC_EXIT", "FAIL", "ESC exit followed by +++ re-entry failed")
            return False
        same, detail = compare_menus(self.baseline or menu, menu)
        self.esc_verified = same
        self.report("ESC_EXIT", "PASS" if same else "FAIL", f"ESC exit/re-enter; {detail}")
        return same

    def final_exit(self) -> bool:
        method = "ESC" if self.esc_verified else "+++"
        text = self.press_escape() if self.esc_verified else self.pulse_plus()
        if self.recognize_menu(text).detected:
            self.report("FINAL_EXIT", "FAIL", f"{method} returned CONFIG; still interactive")
            return False
        # This is intentionally APP_EXPECTED, not a positive APP assertion:
        # proving App_Uart traffic here would itself transmit a radio frame.
        self.state = DeviceState.APP_EXPECTED
        self.report(
            "FINAL_EXIT",
            "PASS",
            f"previously verified {method} sent; final state APP_EXPECTED (no APP probe sent)",
        )
        return True

    def cleanup(self) -> None:
        if self.state != DeviceState.INTERACTIVE:
            return
        try:
            if self.esc_verified:
                text = self.press_escape()
                method = "ESC"
            else:
                text = self.pulse_plus()
                method = "+++"
            if self.recognize_menu(text).detected:
                print(f"CLEANUP FAIL: {method} returned CONFIG; reset TWELITE manually", file=sys.stderr)
            else:
                self.state = DeviceState.APP_EXPECTED
                print(f"CLEANUP: {method} sent; final state APP_EXPECTED")
        except Exception as exc:  # keep the original test failure visible
            self.state = DeviceState.UNKNOWN
            print(f"CLEANUP FAIL: {exc}; reset TWELITE manually", file=sys.stderr)

    def run(self) -> bool:
        print("[INTERACTIVE MODE AUTOMATIC TEST]")
        print("host-byte allowlist: '+', confirmed-menu CR, and advertised-menu ESC only")
        completed = False
        try:
            menu = self.synchronize()
            if menu is not None:
                self.baseline = menu
                self.validate_config(menu)
                self.redraw(menu)
                completed = self.test_escape_exit()

                cycle = 1
                while completed and cycle <= self.cycles:
                    completed = self.exit_and_reenter_with_plus(cycle) is not None
                    cycle += 1

                if completed:
                    completed = self.final_exit()
        finally:
            self.cleanup()
            forbidden = set(self.sent_bytes) - {ord("+"), 0x0D, 0x1B}
            if forbidden:
                self.report("HOST_WRITE_ALLOWLIST", "FAIL", f"unexpected bytes={sorted(forbidden)}")
            else:
                self.report("HOST_WRITE_ALLOWLIST", "PASS", f"bytes_sent={len(self.sent_bytes)}")
            self.report(
                "NO_CONFIG_COMMANDS",
                "PASS",
                "host did not intentionally send save/reset/AppSel/settings commands",
            )

            failures = [check for check in self.checks if check.status == "FAIL"]
            warnings = [check for check in self.checks if check.status == "WARN"]
            summary_ok = completed and not failures
            print(
                f"SUMMARY {'PASS' if summary_ok else 'FAIL'} "
                f"failures={len(failures)} warnings={len(warnings)} final_state={self.state.value}"
            )
            if self.state == DeviceState.UNKNOWN:
                print("ACTION REQUIRED: hardware-reset TWELITE before reuse")

        failures = [check for check in self.checks if check.status == "FAIL"]
        return completed and not failures


class FakeClock:
    def __init__(self) -> None:
        self.value = 0.0

    def now(self) -> float:
        return self.value

    def sleep(self, seconds: float) -> None:
        self.value += seconds


class FakeSerial:
    MENU = (
        "\x1b[2J[CONFIG MENU/App_Uart:0/v1-05-1/SID=8300051A]\r\n"
        "a: (0x67720103) Application ID\r\n"
        "i: (121) Device ID\r\n"
        "c: (18) Channel(s)\r\n"
        "x: (0x03) RF Power/Retransmissions\r\n"
        "b: (115200,8N1) UART Baud Alt.\r\n"
        "o: (0x00000100) Option bits\r\n"
        "r: (0x00) Role\r\n"
        "l: (1) LayerTree repeat layer\r\n"
        "m: (A) UART mode\r\n"
        "t: (0x0D0A) Tx trigger character\r\n"
        "u: (0) Minimum data size\r\n"
        "T: (0) Timeout\r\n"
        "h: (;U;%t;%i;0x%A;%q;%s;<*;%X;\\n) Header format\r\n"
        "C: (0) Encryption\r\n"
        "K: (*CRYPT_KEY_HERE*) Encryption key\r\n"
        "[ESC]:Exit [!]:Reset System [*]:Extr Menu [:]:AppSel\r\n"
    ).encode()

    def __init__(
        self,
        *,
        initial_interactive: bool = False,
        fragment: bool = False,
        sticky_exit: bool = False,
    ) -> None:
        self.interactive = initial_interactive
        self.fragment = fragment
        self.sticky_exit = sticky_exit
        self.buffer = bytearray()
        self.plus_count = 0
        self.writes = bytearray()
        self.closed = False

    def reset_input_buffer(self) -> None:
        self.buffer.clear()

    def write(self, data: bytes) -> int:
        self.writes.extend(data)
        if data == b"+":
            self.plus_count += 1
            if self.plus_count == 3:
                self.plus_count = 0
                if self.interactive and self.sticky_exit:
                    self.buffer.extend(self.MENU)
                else:
                    self.interactive = not self.interactive
                    self.buffer.extend(self.MENU if self.interactive else b"EXIT\r\n")
        else:
            self.plus_count = 0
            if data == b"\r" and self.interactive:
                self.buffer.extend(self.MENU)
            elif data == b"\x1b" and self.interactive:
                self.interactive = False
                self.buffer.extend(b"EXIT\r\n")
        return len(data)

    def flush(self) -> None:
        pass

    def read(self, size: int) -> bytes:
        if not self.buffer:
            return b""
        count = 1 if self.fragment else min(size, len(self.buffer))
        result = bytes(self.buffer[:count])
        del self.buffer[:count]
        return result

    def close(self) -> None:
        self.closed = True


def make_fake_tester(fake: FakeSerial, clock: FakeClock, cycles: int = 2) -> InteractiveTester:
    return InteractiveTester(
        fake,
        profile="stick",
        expected_app_id=0x67720103,
        expected_channel=18,
        cycles=cycles,
        plus_interval=0.25,
        timeout=0.5,
        test_escape=True,
        raw=False,
        now=clock.now,
        sleep=clock.sleep,
    )


def self_test() -> None:
    current = parse_menu(FakeSerial.MENU.decode())
    assert current.detected and current.app_uart and current.serial_id == "8300051A"
    assert current.version == "1-05-1"
    assert current.settings["m"] == "A" and current.settings["K"] == "*CRYPT_KEY_HERE*"
    assert current.esc_supported and parse_decimal_list(current.settings["c"]) == (18,)

    changed_sid = parse_menu(FakeSerial.MENU.decode().replace("8300051A", "8300051B"))
    same, detail = compare_menus(current, changed_sid)
    assert not same and "serial_id" in detail
    assert parse_decimal_list("18,19") == (18, 19)

    old_menu = (
        "--- CONFIG/TWE UART APP V1-04-5/SID=0x82018CA0/LID=0x78 ---\r\n"
        "a: set Application ID (0x67720103)\r\n"
        "i: set Device ID (120=0x78)\r\n"
        "c: set Channels (18)\r\n"
        "b: set UART baud (38400)\r\n"
        "B: set UART option (8N1)\r\n"
        "m: set UART mode (A)\r\n"
        "h: set header format [;U;%t;%i;0x%A;%q;%s;<*>;%X;\\n]\r\n"
    )
    old = parse_menu(old_menu)
    assert old.detected and old.settings["B"] == "8N1" and old.settings["h"].startswith(";U;")
    assert not parse_menu("payload says CONFIG and Application ID only").detected

    for initial in (False, True):
        clock = FakeClock()
        fake = FakeSerial(initial_interactive=initial, fragment=True)
        tester = make_fake_tester(fake, clock)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            assert tester.run()
        assert not fake.interactive
        assert set(fake.writes) <= {ord("+"), 0x0D, 0x1B}

    clock = FakeClock()
    fake = FakeSerial()
    tester = make_fake_tester(fake, clock, cycles=1)
    tester.test_escape = False
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        assert tester.run()
    assert b"\x1b" not in fake.writes
    assert tester.state == DeviceState.APP_EXPECTED

    class SilentSerial(FakeSerial):
        def write(self, data: bytes) -> int:
            self.writes.extend(data)
            return len(data)

    clock = FakeClock()
    silent = SilentSerial()
    tester = make_fake_tester(silent, clock, cycles=1)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        assert not tester.run()
    # Two toggle attempts only; no CR in unknown/app state and no blind cleanup.
    assert silent.writes == b"++++++"

    clock = FakeClock()
    guarded = make_fake_tester(FakeSerial(), clock)
    try:
        guarded.press_cr()
    except RuntimeError:
        pass
    else:
        raise AssertionError("CR safety guard accepted UNKNOWN state")

    class PartialSerial(FakeSerial):
        def write(self, data: bytes) -> int:
            self.writes.extend(data[:1])
            return min(1, len(data))

    clock = FakeClock()
    partial = PartialSerial()
    tester = make_fake_tester(partial, clock)
    try:
        tester.write_exact(b"++")
    except RuntimeError:
        pass
    else:
        raise AssertionError("partial serial write was accepted")
    assert tester.sent_bytes == b"+"

    clock = FakeClock()
    sticky = FakeSerial(initial_interactive=True, sticky_exit=True)
    tester = make_fake_tester(sticky, clock)
    tester.state = DeviceState.INTERACTIVE
    tester.baseline = current
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        assert not tester.final_exit()
    assert tester.state == DeviceState.INTERACTIVE

    clock = FakeClock()
    cleanup_fake = FakeSerial(initial_interactive=True)
    tester = make_fake_tester(cleanup_fake, clock)
    tester.state = DeviceState.INTERACTIVE
    tester.esc_supported = True
    tester.esc_verified = False
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        tester.cleanup()
    assert b"\x1b" not in cleanup_fake.writes
    assert tester.state == DeviceState.APP_EXPECTED

    print(
        "SELF TEST PASS: parsers, fragmented I/O, safe state sync, exit/re-entry, "
        "partial writes, sticky exit, and conservative cleanup"
    )


def parse_int(value: str) -> int:
    return int(value, 0)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="TWELITE interactive mode non-persistent automatic transition test"
    )
    parser.add_argument("--port", help="required device port, e.g. COM5 or /dev/cu.usbserial-XXXX")
    parser.add_argument("--list-ports", action="store_true")
    parser.add_argument("--self-test", action="store_true", help="run without hardware")
    parser.add_argument("--profile", choices=("stick", "client"), default="stick")
    parser.add_argument("--cycles", type=int, default=2, help="+++ exit/re-entry cycles (default: 2)")
    parser.add_argument(
        "--plus-interval",
        type=float,
        default=0.35,
        help="seconds between '+' (automation-safe range: 0.25..0.9)",
    )
    parser.add_argument("--timeout", type=float, default=3.0)
    parser.add_argument("--app-id", type=parse_int, default=0x67720103)
    parser.add_argument("--channel", type=int, default=18)
    parser.add_argument("--skip-esc", action="store_true", help="do not test advertised ESC exit")
    parser.add_argument("--raw", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return 0

    if args.list_ports:
        records = common.port_records()
        if not records and common.list_ports is None:
            print("pyserial is required: py -m pip install -r TWELITE-Minimal\\requirements.txt")
            return 2
        if not records:
            print("No serial ports found. Connect TWELITE and retry.")
            return 1
        for record in records:
            print(f"{record.device}\t{common.port_description(record)}")
        return 0

    if not args.port:
        parser.error("--port is required; use --list-ports and choose the TWELITE device explicitly")
    if not 1 <= args.cycles <= 10:
        parser.error("--cycles must be 1..10")
    if not 0.25 <= args.plus_interval <= 0.9:
        parser.error("--plus-interval must be 0.25..0.9 seconds (inside the official 0.2..1.0 range)")
    if not 0.5 <= args.timeout <= 10.0:
        parser.error("--timeout must be 0.5..10 seconds")
    if not 0 <= args.app_id <= 0xFFFFFFFF:
        parser.error("--app-id must be 0..0xFFFFFFFF")
    if not 11 <= args.channel <= 26:
        parser.error("--channel must be 11..26")

    try:
        common.require_pyserial()
        ser = common.open_stick(args.port)
    except Exception as exc:
        print(f"ERROR: cannot open {args.port}: {exc}", file=sys.stderr)
        return 2

    tester = InteractiveTester(
        ser,
        profile=args.profile,
        expected_app_id=args.app_id,
        expected_channel=args.channel,
        cycles=args.cycles,
        plus_interval=args.plus_interval,
        timeout=args.timeout,
        test_escape=not args.skip_esc,
        raw=args.raw,
    )
    exit_code = 2
    try:
        print(f"OPEN {args.port} (115200 8N1); waiting for USB/reset settle")
        time.sleep(0.8)
        ok = tester.run()
        exit_code = 0 if ok else 1
    except KeyboardInterrupt:
        print(
            f"INTERRUPTED: final_state={tester.state.value}; "
            "hardware-reset TWELITE if state is UNKNOWN",
            file=sys.stderr,
        )
        exit_code = 130
    except Exception as exc:
        print(
            f"ERROR: {exc}; final_state={tester.state.value}; "
            "hardware-reset TWELITE if state is UNKNOWN",
            file=sys.stderr,
        )
        exit_code = 2
    finally:
        try:
            tester.cleanup()
        finally:
            try:
                ser.close()
            except Exception as exc:
                print(f"WARNING: serial close failed: {exc}", file=sys.stderr)
                if exit_code == 0:
                    exit_code = 2
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
