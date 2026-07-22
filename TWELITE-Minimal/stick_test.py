#!/usr/bin/env python3
"""TWELITE STICK <-> TR3 minimal PING/PONG and firmware diagnostic."""

from __future__ import annotations

import argparse
import re
import sys
import time
from dataclasses import dataclass
from typing import Any

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    serial = None  # type: ignore[assignment]
    list_ports = None  # type: ignore[assignment]


BAUD = 115200
APP_COMMAND = 0x01
ALL_CHILDREN = 0x78
PING_PREFIX = b"TR3?"
PONG_PREFIX = b"TR3!"


class FrameError(ValueError):
    pass


@dataclass(frozen=True)
class AppFrame:
    source: int
    command: int
    payload: bytes


def lrc8(data: bytes) -> int:
    return (-sum(data)) & 0xFF


def encode_frame(destination: int, command: int, payload: bytes) -> bytes:
    raw = bytes((destination & 0xFF, command & 0xFF)) + payload
    raw += bytes((lrc8(raw),))
    return b":" + raw.hex().upper().encode("ascii") + b"\r\n"


def decode_frame(line: bytes | str) -> AppFrame:
    if isinstance(line, bytes):
        try:
            text = line.decode("ascii")
        except UnicodeDecodeError as exc:
            raise FrameError("ASCIIではありません") from exc
    else:
        text = line

    text = text.strip()
    if not text.startswith(":"):
        raise FrameError("':'で始まっていません（App_Uart mode Aではない可能性）")
    hex_text = text[1:]
    if len(hex_text) % 2:
        raise FrameError("16進文字数が奇数です")
    try:
        raw = bytes.fromhex(hex_text)
    except ValueError as exc:
        raise FrameError("16進形式ではありません") from exc
    if len(raw) < 3:
        raise FrameError("フレームが短すぎます")
    if sum(raw) & 0xFF:
        raise FrameError("LRCエラー")
    return AppFrame(raw[0], raw[1], raw[2:-1])


def port_records() -> list[Any]:
    if list_ports is None:
        return []
    return sorted(
        (port for port in list_ports.comports() if port.device),
        key=lambda port: port.device,
    )


def available_ports() -> list[str]:
    return [port.device for port in port_records()]


def port_description(port: Any) -> str:
    parts = [getattr(port, "description", ""), getattr(port, "manufacturer", "")]
    text = " / ".join(part for part in parts if part and part != "n/a")
    vid = getattr(port, "vid", None)
    pid = getattr(port, "pid", None)
    if vid is not None and pid is not None:
        text += f" VID:PID={vid:04X}:{pid:04X}"
    return text.strip(" /") or "詳細不明"


def default_port() -> str | None:
    """Choose only a plausible USB serial device; never auto-select Bluetooth."""
    ranked: list[tuple[int, str]] = []
    for port in port_records():
        device = port.device
        details = " ".join((
            device,
            getattr(port, "description", "") or "",
            getattr(port, "manufacturer", "") or "",
            getattr(port, "hwid", "") or "",
        )).lower()
        if "bluetooth" in details or "debug-console" in details:
            continue
        score = 0
        if "twelite" in details or "mono wireless" in details:
            score += 100
        if "usbserial" in device.lower() or "ttyusb" in device.lower():
            score += 30
        if "usbmodem" in device.lower() or "ttyacm" in device.lower():
            score += 20
        if re.fullmatch(r"COM[0-9]+", device, flags=re.IGNORECASE):
            score += 20
        if "ftdi" in details:
            score += 10
        if score:
            ranked.append((score, device))
    return max(ranked, default=(0, ""))[1] or None


def require_pyserial() -> None:
    if serial is None:
        raise RuntimeError(
            "pyserial が必要です: python3 -m pip install -r TWELITE-Minimal/requirements.txt"
        )


def open_stick(path: str) -> Any:
    require_pyserial()
    return serial.Serial(
        port=path,
        baudrate=BAUD,
        bytesize=serial.EIGHTBITS,
        parity=serial.PARITY_NONE,
        stopbits=serial.STOPBITS_ONE,
        timeout=0.1,
        write_timeout=1.0,
        xonxoff=False,
        rtscts=False,
        dsrdtr=False,
    )


def drain(ser: Any, seconds: float = 0.3) -> list[bytes]:
    lines: list[bytes] = []
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        line = ser.readline()
        if line:
            lines.append(line.rstrip(b"\r\n"))
    return lines


def read_until_idle(ser: Any, total_timeout: float, idle_timeout: float = 0.4) -> bytes:
    data = bytearray()
    deadline = time.monotonic() + total_timeout
    idle_deadline = deadline
    while time.monotonic() < deadline:
        chunk = ser.read(4096)
        if chunk:
            data.extend(chunk)
            idle_deadline = time.monotonic() + idle_timeout
        elif data and time.monotonic() >= idle_deadline:
            break
    return bytes(data)


def enter_interactive_mode(ser: Any) -> str:
    ser.reset_input_buffer()
    for _ in range(3):
        ser.write(b"+")
        ser.flush()
        time.sleep(0.35)
    time.sleep(0.2)
    ser.write(b"\r")
    ser.flush()
    return read_until_idle(ser, 3.0).decode("utf-8", errors="replace")


def exit_interactive_mode(ser: Any) -> None:
    for _ in range(3):
        ser.write(b"+")
        ser.flush()
        time.sleep(0.35)
    drain(ser, 0.5)


def first_match(text: str, patterns: tuple[str, ...]) -> str | None:
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            return match.group(1)
    return None


def print_expected_spec(profile: str, expected_app_id: int, expected_channel: int) -> None:
    logical_id = "121 (0x79) / 親機" if profile == "stick" else "1..100 または 120 (0x78) / 子機"
    print("\n[EXPECTED SPEC]")
    print("firmware=App_Uart, UART mode=A (ASCII format), UART=115200 8N1")
    print(f"Application ID=0x{expected_app_id:08X}, channel={expected_channel}, Logical ID={logical_id}")
    print("wire=':' + [宛先/送信元][command<0x80][payload][LRC8] + CRLF")
    print("この条件のApplication ID/channelが両機で一致したときだけ無線で届きます。")


def diagnose_firmware(
    ser: Any,
    expected_app_id: int,
    expected_channel: int,
    profile: str,
) -> bool:
    print_expected_spec(profile, expected_app_id, expected_channel)
    print("\n[FIRMWARE] 読み取り専用診断（設定は保存・変更しません）")
    menu = enter_interactive_mode(ser)
    interactive_detected = bool(re.search(
        r"CONFIG|APPSEL|APP SELECT|Application ID|Device ID|UART mode",
        menu,
        flags=re.IGNORECASE,
    ))
    try:
        if not interactive_detected:
            print("NG: インタラクティブモードの設定画面を確認できません")
            print("    ポート/115200bps/ドライバ/ファームを確認し、TWELITEをリセットしてください。")
            return False

        clean = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", menu)
        header = next((line.strip() for line in clean.splitlines() if "CONFIG" in line.upper()), "不明")
        print(f"検出: {header}")

        if re.search(r"APP[_ ]?UART|TWE UART APP|UART APP", clean, re.IGNORECASE):
            firmware = "App_Uart"
        elif re.search(r"APP[_ ]?WINGS", clean, re.IGNORECASE):
            firmware = "App_Wings"
        elif re.search(r"APPSEL|APP SELECT", clean, re.IGNORECASE):
            firmware = "Unified/AppSel"
        else:
            firmware = "不明"

        version_text = first_match(clean, (
            r"(?:^|[/ ])v([0-9]+(?:[-._][0-9]+){1,2})",
            r"APP[_ ]?(?:UART|WINGS)[^\n]*?v([0-9]+(?:[-._][0-9]+){1,2})",
        ))
        serial_id_text = first_match(clean, (
            r"SID\s*=\s*(?:0x)?([0-9a-f]{8})",
        ))
        app_id_text = first_match(clean, (
            r"\ba\s*:\s*\(\s*(0x[0-9a-f]+)",
            r"Application ID\s*\(\s*(0x[0-9a-f]+)",
        ))
        channel_text = first_match(clean, (
            r"\bc\s*:\s*\(\s*([0-9]+)",
            r"Channels?\s*\(\s*([0-9]+)",
        ))
        device_decimal_text = first_match(clean, (
            r"\bi\s*:\s*\(\s*([0-9]+)",
            r"Device ID\s*\(\s*([0-9]+)",
        ))
        device_hex_text = first_match(clean, (r"LID\s*=\s*0x([0-9a-f]+)",))
        mode_text = first_match(clean, (
            r"\bm\s*:\s*\(\s*([A-E])",
            r"UART mode\s*\(\s*([A-E])",
        ))
        baud_text = first_match(clean, (
            r"\bb\s*:\s*\(\s*([0-9]+)",
            r"UART baud[^\n]*\(\s*([0-9]+)",
        ))
        uart_option_text = first_match(clean, (
            r"\bb\s*:\s*\(\s*[0-9]+\s*,\s*([78][NOE][12])",
            r"\bB\s*:\s*\(\s*([78][NOE][12])",
            r"UART option[^\n]*\(\s*([78][NOE][12])",
        ))
        role_text = first_match(clean, (
            r"\br\s*:\s*\(\s*(0x[0-9a-f]+|[0-9]+)",
            r"Role[^\n]*\(\s*(0x[0-9a-f]+|[0-9]+)",
        ))
        option_bits_text = first_match(clean, (
            r"\bo\s*:\s*\(\s*(0x[0-9a-f]+)",
            r"option bits[^\n]*\(\s*(0x[0-9a-f]+)",
        ))
        encryption_text = first_match(clean, (
            r"(?-i:\bC)\s*:\s*\(\s*([01])",
            r"crypt (?:mode|ion)[^\n]*\(\s*([01])",
            r"Encryption[^\n]*\(\s*([01])",
        ))

        checks: list[tuple[str, bool | None, str]] = []
        firmware_detail = firmware + (f" v{version_text}" if version_text else " (版数読取不能)")
        if firmware == "App_Wings":
            firmware_detail += "。v1.3以降は簡易形式対応ですが、この最小試験はApp_Uartへ統一"
        elif firmware == "Unified/AppSel":
            firmware_detail += "。App_Uartを選択してください"
        checks.append(("firmware", firmware == "App_Uart", firmware_detail))
        checks.append(("Serial ID", None,
                       f"0x{serial_id_text.upper()}" if serial_id_text else "読取不能"))
        checks.append(("interactive/effective baud", True,
                       f"{BAUD} bpsで設定画面を読めたため実効UARTは正常"))

        if app_id_text:
            actual = int(app_id_text, 0)
            checks.append(("Application ID", actual == expected_app_id,
                           f"0x{actual:08X} (期待 0x{expected_app_id:08X})"))
        else:
            checks.append(("Application ID", False, "読取不能"))

        if channel_text:
            actual = int(channel_text, 10)
            checks.append(("channel", actual == expected_channel,
                           f"{actual} (期待 {expected_channel})"))
        else:
            checks.append(("channel", False, "読取不能"))

        if device_decimal_text or device_hex_text:
            actual = (int(device_decimal_text, 10) if device_decimal_text
                      else int(device_hex_text or "0", 16))
            if profile == "stick":
                logical_ok = actual == 121
                logical_expected = "親機 121"
            else:
                logical_ok = 1 <= actual <= 100 or actual == 120
                logical_expected = "子機 1..100 または120"
            checks.append(("Logical ID/topology", logical_ok,
                           f"{actual} (期待 {logical_expected})"))
        else:
            checks.append(("Logical ID/topology", False, "読取不能"))

        if mode_text:
            checks.append(("UART mode", mode_text.upper() == "A",
                           f"{mode_text.upper()} (期待 A=ASCII format)"))
        else:
            checks.append(("UART mode", False, "読取不能"))

        if baud_text:
            actual = int(baud_text, 10)
            checks.append(("stored alternate baud", None,
                           f"{actual} (BPS/optionで強制時のみ適用。実効値は上記{BAUD})"))
        else:
            checks.append(("stored alternate baud", None, "読取不能"))

        if uart_option_text:
            checks.append(("UART framing", uart_option_text.upper() == "8N1",
                           f"{uart_option_text.upper()} (期待 8N1)"))
        else:
            checks.append(("UART framing", None, "表示なし（実行側は8N1で接続）"))

        if role_text:
            actual = int(role_text, 0)
            checks.append(("network role", actual == 0,
                           f"{actual} (通常の親/子は0。LayerTreeは使わない)"))
        else:
            checks.append(("network role", None, "読取不能"))

        if encryption_text:
            actual = int(encryption_text, 10)
            checks.append(("encryption", actual == 0,
                           f"{actual} (この最小試験は0=無効)"))
        else:
            checks.append(("encryption", None, "読取不能"))

        if option_bits_text:
            actual = int(option_bits_text, 0)
            suppress_response = bool(actual & 0x00001000)
            checks.append(("TX response option", not suppress_response,
                           f"0x{actual:08X} (bit 0x00001000は0にしてDBA1診断を有効化)"))
        else:
            checks.append(("option bits", None, "読取不能"))

        for name, ok, detail in checks:
            status = "INFO" if ok is None else ("OK" if ok else "NG")
            print(f"{status}: {name}: {detail}")
        required_ok = all(ok is not False for _, ok, _ in checks)
        print(f"{'SPEC PASS' if required_ok else 'SPEC FAIL'}: {profile} profile")
        return required_ok
    finally:
        # +++ is a toggle. Send it only when entry was positively detected;
        # otherwise a second +++ could enter interactive mode instead of exiting.
        if interactive_detected:
            exit_interactive_mode(ser)


def run_ping_test(ser: Any, destination: int, count: int, timeout: float) -> bool:
    print("\n[PING] TWELITE無線往復テスト")
    ser.reset_input_buffer()
    tx_ok = 0
    tx_ng = 0
    pong_sequences: set[int] = set()
    bad_lines = 0
    other_lines = 0

    for sequence in range(1, count + 1):
        packet = encode_frame(destination, APP_COMMAND, PING_PREFIX + sequence.to_bytes(2, "big"))
        print(f"TX PING seq={sequence}: {packet.decode().strip()}")
        ser.write(packet)
        ser.flush()

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and sequence not in pong_sequences:
            line = ser.readline().rstrip(b"\r\n")
            if not line:
                continue
            printable = line.decode("ascii", errors="replace")
            try:
                frame = decode_frame(line)
            except FrameError as exc:
                bad_lines += 1
                print(f"RX BAD: {printable} ({exc})")
                continue

            if frame.source == 0xDB and frame.command == 0xA1 and len(frame.payload) >= 2:
                if frame.payload[1] == 1:
                    tx_ok += 1
                    print("STICK TX OK（UARTフレームを受理）")
                else:
                    tx_ng += 1
                    print("STICK TX NG（スティック内で送信失敗）")
                continue

            valid_child_source = 1 <= frame.source <= 100 or frame.source == 0x78
            if (valid_child_source and frame.command == APP_COMMAND and len(frame.payload) == 6
                    and frame.payload[:4] == PONG_PREFIX):
                pong_sequence = int.from_bytes(frame.payload[4:6], "big")
                if pong_sequence == sequence:
                    pong_sequences.add(pong_sequence)
                    print(f"RX PONG seq={pong_sequence} source=0x{frame.source:02X}")
                else:
                    other_lines += 1
                    print(f"RX STALE PONG seq={pong_sequence} (期待 {sequence})")
            else:
                other_lines += 1
                print(f"RX OTHER: {printable}")

    print("\n[RESULT]")
    print(f"STICK_TX_OK={tx_ok} STICK_TX_NG={tx_ng} "
          f"PONG={len(pong_sequences)}/{count} BAD_LINE={bad_lines} OTHER={other_lines}")

    if len(pong_sequences) == count:
        print("PASS: PC -> STICK -> 無線 -> TR3 -> 無線 -> STICK -> PC が動作しています。")
        return True
    if pong_sequences:
        print(f"DEGRADED: {count}回中{len(pong_sequences)}回だけ成功。通信が不安定です。")
        print("          電源、アンテナ距離、配線、チャネル干渉を確認してください。")
        return False
    if tx_ok:
        print("FAIL: スティックは送信を受理しましたがTR3からPONGがありません。")
        print("      両機のApp_Uart/Application ID/channel/mode AとTR3 UART配線を確認してください。")
    elif bad_lines:
        print("FAIL: 応答形式が違います。App_UartのASCII format mode Aを確認してください。")
    else:
        print("FAIL: スティック応答がありません。ポート、115200bps、ファームウェアを確認してください。")
    return False


def self_test() -> None:
    official_example = encode_frame(0x78, 0x01, bytes.fromhex("112233AABBCC"))
    assert official_example == b":7801112233AABBCCF0\r\n"
    decoded = decode_frame(encode_frame(0x00, APP_COMMAND, PONG_PREFIX + b"\x12\x34"))
    assert decoded == AppFrame(0x00, APP_COMMAND, PONG_PREFIX + b"\x12\x34")
    try:
        decode_frame(b":000100")
    except FrameError:
        pass
    else:
        raise AssertionError("bad LRC was accepted")
    print("SELF TEST PASS: App_Uart ASCII/LRC/PING-PONG codec")


def parse_int(value: str) -> int:
    return int(value, 0)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="TWELITE STICKとTR3の最小PING/PONG・ファーム診断"
    )
    parser.add_argument("--port", default=None, help="例: /dev/cu.usbserial-XXXX または COM3")
    parser.add_argument("--list-ports", action="store_true", help="シリアルポート一覧を表示")
    parser.add_argument("--show-spec", action="store_true", help="期待する根本仕様だけを表示")
    parser.add_argument("--self-test", action="store_true", help="ハードなしでフレーム処理を検証")
    parser.add_argument("--diagnose", action="store_true", help="先にTWELITE設定を読み取り診断")
    parser.add_argument("--diagnose-only", action="store_true", help="TWELITE設定診断だけ行う")
    parser.add_argument("--profile", choices=("stick", "client"), default="stick",
                        help="診断対象。stick=PC親機、client=TR3子機（TWELITE R直結時）")
    parser.add_argument("--destination", type=parse_int, default=ALL_CHILDREN,
                        help="TR3側TWELITE宛先。初期値 0x78（全子機）")
    parser.add_argument("--count", type=int, default=5, help="PING回数（初期値5）")
    parser.add_argument("--timeout", type=float, default=2.0, help="各PONG待ち秒数")
    parser.add_argument("--app-id", type=parse_int, default=0x67720103,
                        help="期待するApp_Uart Application ID")
    parser.add_argument("--channel", type=int, default=18, help="期待する無線チャネル")
    args = parser.parse_args()

    if not (1 <= args.destination <= 100 or args.destination == ALL_CHILDREN):
        parser.error("--destination は子機1..100または全子機0x78")
    if not 0 <= args.app_id <= 0xFFFFFFFF:
        parser.error("--app-id は32-bit値 0..0xFFFFFFFF")
    if not 11 <= args.channel <= 26:
        parser.error("--channel は11..26")
    if not 1 <= args.count <= 100:
        parser.error("--count は1..100")
    if not 0.1 <= args.timeout <= 30:
        parser.error("--timeout は0.1..30秒")

    if args.show_spec:
        print_expected_spec(args.profile, args.app_id, args.channel)
        return 0

    if args.self_test:
        self_test()
        return 0

    if args.list_ports:
        records = port_records()
        if not records and list_ports is None:
            print("pyserial が未導入です。")
            return 2
        if records:
            for record in records:
                print(f"{record.device}\t{port_description(record)}")
        else:
            print("シリアルポートがありません。")
        return 0

    if args.profile == "client" and not args.diagnose_only:
        parser.error("--profile client はTWELITE R等へ直結し、--diagnose-only と一緒に使います")

    try:
        require_pyserial()
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    port = args.port or default_port()
    if not port:
        print("ERROR: TWELITE STICKが見つかりません。--port を指定してください。", file=sys.stderr)
        return 2

    print(f"OPEN {port} ({BAUD} 8N1)")
    try:
        ser = open_stick(port)
    except Exception as exc:
        print(f"ERROR: ポートを開けません: {exc}", file=sys.stderr)
        return 2

    try:
        firmware_ok = True
        if args.diagnose or args.diagnose_only:
            firmware_ok = diagnose_firmware(ser, args.app_id, args.channel, args.profile)
        if args.diagnose_only:
            return 0 if firmware_ok else 1
        # Give the app a short moment after leaving interactive mode.
        time.sleep(0.5)
        ping_ok = run_ping_test(ser, args.destination, args.count, args.timeout)
        if ping_ok and not firmware_ok:
            print("OVERALL FAIL: PINGは通りましたが、期待する標準設定にNGがあります。")
        return 0 if ping_ok and firmware_ok else 1
    finally:
        ser.close()


if __name__ == "__main__":
    raise SystemExit(main())
