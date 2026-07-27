/*
 * TR3 <-> TWELITE UART minimal link test
 *
 * Board: Arduino Nano Every (TR3 controller)
 * TWELITE UART: App_Uart, ASCII format mode (A), 115200 8N1
 *
 * The PC sends:  "TR3?" + uint16 sequence
 * This sketch replies: "TR3!" + the same sequence
 *
 * No sensors, SD card, LCD, valves, or mission logic are used.
 */

#include <Arduino.h>

namespace Config {
constexpr uint32_t USB_BAUD = 115200;
constexpr uint32_t TWELITE_BAUD = 115200;
constexpr uint8_t APP_COMMAND = 0x01;
constexpr uint8_t PARENT_DESTINATION = 0x00;
constexpr size_t LINE_BUFFER_SIZE = 192;
constexpr unsigned long REPORT_INTERVAL_MS = 5000UL;
}

char lineBuffer[Config::LINE_BUFFER_SIZE];
size_t lineLength = 0;
bool lineOverflow = false;

uint32_t pingCount = 0;
uint32_t pongCount = 0;
uint32_t tweliteTxOkCount = 0;
uint32_t tweliteTxNgCount = 0;
uint32_t badLineCount = 0;
unsigned long lastReportMs = 0;

int hexNibble(char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'A' && value <= 'F') return value - 'A' + 10;
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  return -1;
}

void writeHexByte(Print& out, uint8_t value) {
  static const char HEX_DIGITS[] = "0123456789ABCDEF";
  out.write(HEX_DIGITS[(value >> 4) & 0x0F]);
  out.write(HEX_DIGITS[value & 0x0F]);
}

void sendAppUart(uint8_t destination, uint8_t command,
                 const uint8_t* payload, size_t payloadLength) {
  uint8_t sum = static_cast<uint8_t>(destination + command);

  Serial1.write(':');
  writeHexByte(Serial1, destination);
  writeHexByte(Serial1, command);
  for (size_t i = 0; i < payloadLength; ++i) {
    writeHexByte(Serial1, payload[i]);
    sum = static_cast<uint8_t>(sum + payload[i]);
  }
  writeHexByte(Serial1, static_cast<uint8_t>(0U - sum));
  Serial1.print("\r\n");
}

bool decodeAppUart(const char* line, size_t length,
                   uint8_t* bytes, size_t capacity, size_t& byteLength) {
  byteLength = 0;
  if (length < 7 || line[0] != ':') return false;

  const size_t hexLength = length - 1;
  if ((hexLength & 1U) != 0) return false;

  byteLength = hexLength / 2;
  if (byteLength < 3 || byteLength > capacity) return false;

  uint8_t sum = 0;
  for (size_t i = 0; i < byteLength; ++i) {
    const int high = hexNibble(line[1 + i * 2]);
    const int low = hexNibble(line[2 + i * 2]);
    if (high < 0 || low < 0) return false;
    bytes[i] = static_cast<uint8_t>((high << 4) | low);
    sum = static_cast<uint8_t>(sum + bytes[i]);
  }
  return sum == 0;
}

void printRawLine(const char* label, const char* line, size_t length) {
  Serial.print(label);
  Serial.write(reinterpret_cast<const uint8_t*>(line), length);
  Serial.println();
}

void handleLine(const char* line, size_t length) {
  uint8_t bytes[96];
  size_t byteLength = 0;
  if (!decodeAppUart(line, length, bytes, sizeof(bytes), byteLength)) {
    ++badLineCount;
    printRawLine("TWELITE_BAD ", line, length);
    return;
  }

  const uint8_t source = bytes[0];
  const uint8_t command = bytes[1];
  const uint8_t* payload = bytes + 2;
  const size_t payloadLength = byteLength - 3;  // exclude source, command, LRC

  // Local App_Uart transmission result: :DB A1 response_id result LRC
  if (source == 0xDB && command == 0xA1 && payloadLength >= 2) {
    if (payload[1] == 1) {
      ++tweliteTxOkCount;
      Serial.println(F("TWELITE_TX OK"));
    } else {
      ++tweliteTxNgCount;
      Serial.println(F("TWELITE_TX NG"));
    }
    return;
  }

  static const uint8_t PING_PREFIX[] = {'T', 'R', '3', '?'};
  if (command != Config::APP_COMMAND || payloadLength != 6 ||
      memcmp(payload, PING_PREFIX, sizeof(PING_PREFIX)) != 0) {
    printRawLine("TWELITE_IGNORED ", line, length);
    return;
  }

  const uint16_t sequence =
      (static_cast<uint16_t>(payload[4]) << 8) | payload[5];
  ++pingCount;
  Serial.print(F("PING seq="));
  Serial.print(sequence);
  Serial.print(F(" source=0x"));
  if (source < 0x10) Serial.print('0');
  Serial.println(source, HEX);

  const uint8_t pong[] = {
      'T', 'R', '3', '!',
      static_cast<uint8_t>(sequence >> 8),
      static_cast<uint8_t>(sequence & 0xFF),
  };
  sendAppUart(Config::PARENT_DESTINATION, Config::APP_COMMAND,
              pong, sizeof(pong));
  ++pongCount;
  Serial.print(F("PONG seq="));
  Serial.println(sequence);
}

void pollTwelite() {
  while (Serial1.available() > 0) {
    const char value = static_cast<char>(Serial1.read());
    if (value == '\r') continue;
    if (value == '\n') {
      if (!lineOverflow && lineLength > 0) {
        handleLine(lineBuffer, lineLength);
      } else if (lineOverflow) {
        ++badLineCount;
        Serial.println(F("TWELITE_BAD line_too_long"));
      }
      lineLength = 0;
      lineOverflow = false;
    } else if (!lineOverflow) {
      if (lineLength < sizeof(lineBuffer)) {
        lineBuffer[lineLength++] = value;
      } else {
        lineOverflow = true;
      }
    }
  }
}

void printReport() {
  Serial.print(F("SUMMARY ping="));
  Serial.print(pingCount);
  Serial.print(F(" pong_uart="));
  Serial.print(pongCount);
  Serial.print(F(" twelite_tx_ok="));
  Serial.print(tweliteTxOkCount);
  Serial.print(F(" twelite_tx_ng="));
  Serial.print(tweliteTxNgCount);
  Serial.print(F(" bad_line="));
  Serial.println(badLineCount);
}

void setup() {
  Serial.begin(Config::USB_BAUD);
  Serial1.begin(Config::TWELITE_BAUD);

  Serial.println(F("TR3_TWELITE_TEST READY"));
  Serial.println(F("Serial1=115200 8N1 / App_Uart mode A / command=0x01"));
  Serial.println(F("Waiting for PING..."));
}

void loop() {
  pollTwelite();

  const unsigned long now = millis();
  if (now - lastReportMs >= Config::REPORT_INTERVAL_MS) {
    lastReportMs = now;
    printReport();
  }
}
