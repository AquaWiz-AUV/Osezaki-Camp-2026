/**
 * @file UmiBot.ino
 * @brief UmiBot Osezaki Camp 2026 firmware using the protocol_v36 TWELITE wireless protocol.
 *
 * SENSOR-LOCKOUT-DISABLED VARIANT:
 *   This sketch is a tethered recovery/test variant. It keeps the mission
 *   sequence running when the depth sensor is missing, stale, or reports a
 *   sensor-derived max-depth breach. Sensor error bits are still logged.
 *
 *   Retained hard lockout: valve conflict. Do not use this variant untethered.
 *
 * v4 DATA LOGGING:
 *   DATA.CSV is written every 0.5 s while RUNNING, including exhaust/injection
 *   valve-open phases. The depth/temperature samples during control are the
 *   primary sea-test output.
 *
 * UmiBot keeps the Triton-3 v4 communication, mission-control, SD logging,
 * optional LCD, LED, GPS, RTC, MS5837, and two-valve behavior. It does not have
 * a standalone TSYS01 water-temperature sensor. STATUS/Web telemetry reports
 * the MS5837 pressure-sensor temperature instead.
 *
 * CSV compatibility note:
 *   DATA.CSV/EVENT.CSV keep the Triton-3 column layout. The standalone
 *   water-temperature column remains NA on UmiBot; the MS5837 temperature is
 *   still logged in the existing press_c column.
 *
 * Operator control is moved from the OE13KIR infrared mode buttons to the v3.6
 * wireless ControlPlan protocol:
 *
 *   PC console -> TWELITE STICK -> TWELITE child UART -> Arduino Serial1
 *
 * Arduino no longer exposes A/B/C/D/E/F/G modes. The PC side converts any UI
 * preset into an explicit ControlPlan, then sends LOAD_PLAN, START_PLAN,
 * optional REQUEST_STATUS/NOP link checks, and STOP_SAFE.
 *
 * Triton-3 is assumed to lose wireless communication underwater. The mission
 * controller must not depend on periodic wireless reception while a plan is
 * running.
 *
 * Review/fix notes in this revision:
 *   - Valves are driven safe before I2C/LCD initialization.
 *   - Watchdog support is enabled on AVR when available.
 *   - Wire timeout support is enabled when the Arduino core exposes it.
 *   - In this variant, runtime depth-sensor loss is logged but does not lock
 *     out. Sensor-derived max-depth lockout is also bypassed.
 *   - DATA logging continues during valve-open control at 0.5 s intervals.
 *   - Control events are queued so valve/phase transitions do not synchronously
 *     block on event-file flushing.
 *   - GPS SoftwareSerial listening is disabled while a plan is running to avoid
 *     SoftwareSerial interrupt interference with Serial1 command reception.
 *   - Sensor updates are staggered, LCD clear() is avoided, GPS date fields are
 *     range-checked, and transient health bits are cleared on recovery.
 *
 * Hardware note:
 *   Software cannot guarantee fail-closed valves during reset/brownout without
 *   external pull-down/fail-safe driver design. Add hardware pull-downs and a
 *   valve power interlock if they are not already present.
 */

#include <Arduino.h>
#include <SoftwareSerial.h>
#include <SPI.h>
#include <Wire.h>
#include <SD.h>
#include <TinyGPS++.h>
#include <MS5837.h>
#include <TimeLib.h>
#include <RTC_RX8025NB.h>
#include <math.h>
#include <string.h>
#include <stdlib.h>

#ifndef TRITON_ENABLE_LCD
#define TRITON_ENABLE_LCD 1
#endif

#ifndef TRITON_ENABLE_DEPTH_FREEZE_DETECTOR
#define TRITON_ENABLE_DEPTH_FREEZE_DETECTOR 0
#endif

#if TRITON_ENABLE_LCD
#include <LiquidCrystal_I2C.h>
#endif

#if defined(__AVR__)
#include <avr/wdt.h>
#endif

#if defined(SERIAL_RX_BUFFER_SIZE) && SERIAL_RX_BUFFER_SIZE < 128
#warning "Triton-3: Serial1 RX buffer below 128 bytes. Increase core RX buffer or reduce TWELITE baud for robust STOP_SAFE reception."
#endif

// ============================================================
// Hardware configuration

namespace Pins {
const uint8_t SD_CHIP_SELECT = 10;
const uint8_t GPS_RX = 2;
const uint8_t GPS_TX = 3;
const uint8_t VALVE_INJECTION = 7;
const uint8_t VALVE_EXHAUST = 6;
const uint8_t LED_GREEN = 8;
const uint8_t LED_RED = 9;
}

namespace Timing {
const unsigned long SENSOR_UPDATE_MS = 500UL;
const unsigned long SENSOR_SLOT_MS = 125UL;
const unsigned long LCD_UPDATE_MS = 500UL;
const unsigned long SENSOR_STALE_MS = 5000UL;
const unsigned long DEFAULT_DATA_LOG_MS = 500UL;
const unsigned long EVENT_FLUSH_MS = 50UL;
const unsigned long I2C_TIMEOUT_US = 25000UL;
#if TRITON_ENABLE_DEPTH_FREEZE_DETECTOR
const unsigned long DEPTH_FREEZE_STALE_MS = 30000UL;
#endif
}

#if TRITON_ENABLE_LCD
namespace LCD_Config {
const uint8_t ADDRESS = 0x27;
const uint8_t COLUMNS = 16;
const uint8_t ROWS = 2;
}
#endif

constexpr uint32_t USB_BAUD = 115200;
constexpr uint32_t TWELITE_BAUD = 115200;
constexpr uint32_t GPS_BAUD = 9600;

// ============================================================
// Triton v3.6 protocol constants

constexpr uint8_t DEVICE_ID = 0x02;
constexpr uint8_t TWELITE_PARENT_ID = 0x00;
constexpr uint8_t T3_APP_UART_CMD = 0x31;
constexpr uint8_t APP_UART_EXTENDED_CMD = 0xA0;

constexpr uint8_t T3_HEADER = 0x24;
constexpr uint8_t T3_FOOTER = 0x3B;
constexpr uint8_t T3_PROTOCOL_VER = 0x02;
constexpr uint8_t T3_PACKET_CMD = 0x10;
constexpr uint8_t T3_PACKET_ACK = 0x11;
constexpr uint8_t T3_PACKET_STATUS = 0x12;

constexpr uint8_t CMD_NOP = 0x00;
constexpr uint8_t CMD_LOAD_PLAN = 0x01;
constexpr uint8_t CMD_START_PLAN = 0x02;
constexpr uint8_t CMD_STOP_SAFE = 0x03;
constexpr uint8_t CMD_REQUEST_STATUS = 0x04;
constexpr uint8_t CMD_NONE = 0xFF;

constexpr uint8_t FLAG_DEPTH_TRIGGER_ENABLE = 0x01;
constexpr uint8_t FLAG_MAX_DEPTH_ENABLE = 0x02;
constexpr uint8_t FLAG_COMM_TIMEOUT_ENABLE = 0x04;
constexpr uint8_t FLAG_ALLOW_INFINITE_REPEAT = 0x08;
constexpr uint8_t FLAG_REQUIRE_DEPTH_SENSOR = 0x10;
constexpr uint8_t FLAG_RESERVED_MASK = 0xE0;

constexpr uint8_t STATE_SAFE_IDLE = 0x00;
constexpr uint8_t STATE_PLAN_LOADED = 0x01;
constexpr uint8_t STATE_RUNNING = 0x02;
constexpr uint8_t STATE_COMPLETED = 0x03;
constexpr uint8_t STATE_ERROR_LOCKOUT = 0x04;

constexpr uint8_t PHASE_IDLE = 0x00;
constexpr uint8_t PHASE_PREPARE = 0x01;
constexpr uint8_t PHASE_EXHAUST_OPEN = 0x02;
constexpr uint8_t PHASE_DESCENT_COAST = 0x03;
constexpr uint8_t PHASE_BOTTOM_WAIT = 0x04;
constexpr uint8_t PHASE_INJECTION_OPEN = 0x05;
constexpr uint8_t PHASE_ASCENT_WAIT = 0x06;
constexpr uint8_t PHASE_COMPLETE = 0x07;
constexpr uint8_t PHASE_ERROR = 0x08;

constexpr uint8_t RESULT_OK = 0x00;
constexpr uint8_t RESULT_OK_STOPPED = 0x02;
constexpr uint8_t RESULT_OK_STOPPED_LOCKOUT = 0x03;
constexpr uint8_t RESULT_REJECT_BAD_CRC = 0x10;
constexpr uint8_t RESULT_REJECT_BAD_FORMAT = 0x11;
constexpr uint8_t RESULT_REJECT_BAD_PROTOCOL = 0x12;
constexpr uint8_t RESULT_REJECT_SEQ_MISMATCH = 0x14;
constexpr uint8_t RESULT_REJECT_BAD_SAFETY_KEY = 0x15;
constexpr uint8_t RESULT_REJECT_BAD_STATE = 0x16;
constexpr uint8_t RESULT_REJECT_PLAN_NOT_LOADED = 0x17;
constexpr uint8_t RESULT_REJECT_PLAN_MISMATCH = 0x18;
constexpr uint8_t RESULT_REJECT_PLAN_EXPIRED = 0x19;
constexpr uint8_t RESULT_REJECT_BAD_PARAM = 0x1A;
constexpr uint8_t RESULT_REJECT_SENSOR_REQUIRED = 0x1B;
constexpr uint8_t RESULT_REJECT_BUSY_RUNNING = 0x1C;
constexpr uint8_t RESULT_REJECT_UNKNOWN_COMMAND = 0x1D;

constexpr uint16_t ERR_BAD_CRC = 0x0001;
constexpr uint16_t ERR_SD_WRITE = 0x0002;
constexpr uint16_t ERR_TEMP_SENSOR = 0x0004;
constexpr uint16_t ERR_DEPTH_SENSOR = 0x0008;
constexpr uint16_t ERR_COMM_TIMEOUT = 0x0010;
constexpr uint16_t ERR_MAX_DEPTH = 0x0020;
constexpr uint16_t ERR_VALVE_CONFLICT = 0x0040;
constexpr uint16_t ERR_PLAN_EXPIRED = 0x0080;
constexpr uint16_t ERR_BAD_PARAM = 0x0100;
constexpr uint16_t ERR_ERROR_LOCKOUT = 0x0200;
constexpr uint16_t ERR_SENSOR_STALE = 0x0400;

constexpr uint16_t ERR_HEALTH_MASK = ERR_SD_WRITE |
                                     ERR_TEMP_SENSOR |
                                     ERR_DEPTH_SENSOR |
                                     ERR_COMM_TIMEOUT |
                                     ERR_MAX_DEPTH |
                                     ERR_VALVE_CONFLICT |
                                     ERR_ERROR_LOCKOUT |
                                     ERR_SENSOR_STALE;

constexpr uint8_t STATUS_GPS_VALID = 0x01;
constexpr uint8_t STATUS_SD_OK = 0x02;
constexpr uint8_t STATUS_TEMP_OK = 0x04;
constexpr uint8_t STATUS_DEPTH_OK = 0x08;
constexpr uint8_t STATUS_PLAN_VALID = 0x10;
constexpr uint8_t STATUS_PC_LINK_RECENT = 0x20;

constexpr uint16_t SAFETY_KEY = 0xA55A;
constexpr uint8_t SAFETY_POLICY_STOP_SAFE_ONLY = 0x00;
constexpr uint32_t PLAN_LOADED_TIMEOUT_MS = 300000UL;
constexpr uint16_t DEPTH_MARGIN_CM = 200;
constexpr bool ALLOW_RUNNING_COMM_TIMEOUT = false;
constexpr bool SEND_PERIODIC_STATUS_WHILE_RUNNING = false;
constexpr bool SEND_AUTONOMOUS_STATUS_WHILE_NOT_RUNNING = true;
constexpr uint32_t AUTONOMOUS_STATUS_NOT_RUNNING_MS = 5000UL;
constexpr bool SENSOR_LOCKOUT_DISABLED_VARIANT = true;
constexpr bool ALLOW_LOAD_WITH_DEPTH_SENSOR_FAULT = true;
constexpr bool BYPASS_REQUIRED_DEPTH_SENSOR_LOCKOUT = true;
constexpr bool BYPASS_SENSOR_DERIVED_MAX_DEPTH_LOCKOUT = true;

constexpr size_t T3_RAW_CMD_LEN = 40;
constexpr size_t T3_RAW_ACK_LEN = 20;
constexpr size_t T3_RAW_STATUS_LEN = 40;
constexpr size_t T3_RAW_BUF_LEN = 96;
constexpr size_t APP_UART_LINE_BUF_LEN = 128;
constexpr uint8_t ACK_CACHE_SIZE = 8;
constexpr uint32_t ACK_CACHE_TTL_MS = 30000UL;
constexpr uint8_t EVENT_QUEUE_SIZE = 16;
#if TRITON_ENABLE_DEPTH_FREEZE_DETECTOR
constexpr uint8_t DEPTH_FREEZE_MIN_SAMPLES = 60;
#endif

const char* LOG_VERSION = "4";
const char* DATA_LOG_FILENAME = "DATA.CSV";
const char* EVENT_LOG_FILENAME = "EVENT.CSV";

// ============================================================
// Data structures

struct GPSData {
  double latitude = 0.0;
  double longitude = 0.0;
  double altitudeM = 0.0;
  uint8_t satellites = 0;
  bool locationValid = false;
  bool altitudeValid = false;
  bool timeValid = false;
};

struct SensorData {
  float waterTemperature = NAN;
  float pressureMbar = NAN;
  float depthM = NAN;
  float pressureTempC = NAN;
  float missionMaxDepthM = 0.0;
  bool tempValid = false;
  bool depthValid = false;
};

struct RTCData {
  int year = 2000;
  int month = 1;
  int day = 1;
  int hour = 0;
  int minute = 0;
  int second = 0;
};

struct ValveStatus {
  bool injectionValve = false;
  bool exhaustValve = false;
};

struct ControlPlan {
  uint8_t raw[28] = {0};
  uint8_t planFlags = 0;
  uint8_t maxRuntimeMin = 0;
  uint16_t planId = 0;
  uint16_t repeatCount = 0;
  uint16_t prepareS = 0;
  uint16_t exhaustOpenS = 0;
  uint16_t descentCoastS = 0;
  uint16_t bottomWaitS = 0;
  uint16_t injectionOpenS = 0;
  uint16_t ascentWaitS = 0;
  uint16_t depthTriggerCm = 0;
  uint16_t maxDepthCm = 0;
  uint16_t logInterval100ms = 5;
  uint16_t statusInterval100ms = 10;
  uint8_t commTimeoutS = 0;
  uint8_t safetyPolicy = 0;
};

struct AckCacheEntry {
  bool valid = false;
  uint16_t seq = 0;
  uint8_t command = 0;
  uint16_t planId = 0;
  uint16_t cmdCrc = 0;
  uint32_t createdMs = 0;
  uint8_t ack[T3_RAW_ACK_LEN] = {0};
};

struct ControlEventRecord {
  uint32_t seq = 0;
  uint32_t millisStamp = 0;
  RTCData rtc;
  const char* eventName = "";
  uint8_t state = STATE_SAFE_IDLE;
  uint8_t phase = PHASE_IDLE;
  bool hasWireless = false;
  uint16_t wirelessSeq = 0;
  uint8_t command = CMD_NONE;
  uint8_t result = RESULT_OK;
  uint16_t planId = 0;
  uint16_t planCrc = 0;
  uint8_t sourceId = 0;
  float depthM = NAN;
  bool depthValid = false;
  uint16_t thresholdCm = 0;
  float waterTemperature = NAN;
  bool tempValid = false;
  bool injectionValve = false;
  bool exhaustValve = false;
  const char* message = "";
};

// ============================================================
// Global objects

SoftwareSerial gpsSerial(Pins::GPS_RX, Pins::GPS_TX);
TinyGPSPlus gps;
MS5837 depthSensor;
RTC_RX8025NB rtc;
#if TRITON_ENABLE_LCD
LiquidCrystal_I2C lcd(LCD_Config::ADDRESS, LCD_Config::COLUMNS, LCD_Config::ROWS);
#endif

GPSData gpsData;
SensorData sensorData;
RTCData rtcData;
ValveStatus valveStatus;

ControlPlan loadedPlan;
ControlPlan runningPlan;
bool loadedPlanValid = false;
uint16_t loadedPlanCrc = 0;
uint32_t loadedAtMs = 0;
uint8_t controlState = STATE_SAFE_IDLE;
uint8_t phase = PHASE_IDLE;
uint32_t phaseStartedMs = 0;
uint32_t runningStartedMs = 0;
uint16_t cycleCount = 0;
uint16_t statusSeq = 0;
uint16_t lastCmdSeq = 0;
uint8_t lastCmdResult = RESULT_OK;
uint32_t lastPcSeenMs = 0;
bool pcSeen = false;
uint32_t lastStatusMs = 0;
uint16_t errorFlags = 0;
uint16_t observedMaxDepthCm = 0;
bool cycleDepthTriggered = false;
AckCacheEntry ackCache[ACK_CACHE_SIZE];
uint8_t ackCacheNext = 0;

ControlEventRecord eventQueue[EVENT_QUEUE_SIZE];
uint8_t eventQueueHead = 0;
uint8_t eventQueueTail = 0;
uint8_t eventQueueCount = 0;
uint32_t eventDropCount = 0;

char appLine[APP_UART_LINE_BUF_LEN + 1];
size_t appLineLen = 0;
bool appLineOverflow = false;

unsigned long currentMillis = 0;
unsigned long lastSensorMillis = 0;
unsigned long lastDataLogMillis = 0;
unsigned long lastLcdMillis = 0;
unsigned long lastDepthValidMillis = 0;
#if TRITON_ENABLE_DEPTH_FREEZE_DETECTOR
unsigned long lastDepthChangedMillis = 0;
#endif
unsigned long lastEventFlushMillis = 0;

uint8_t sensorUpdateSlot = 0;
uint32_t logSeq = 0;
bool sdReady = false;
bool sdWriteOk = false;
bool tempReady = false;
bool depthReady = false;
bool rtcSyncedFromGPS = false;
bool gpsListening = false;
#if TRITON_ENABLE_DEPTH_FREEZE_DETECTOR
bool depthSampleSeen = false;
bool depthFrozen = false;
uint8_t unchangedDepthSamples = 0;
int16_t lastDepthSampleCm = 0;
uint16_t lastPressureSampleMbar = 0;
#endif

// ============================================================
// Prototypes

void initializeLEDs();
void initializeValves();
void initializeWatchdog();
void serviceWatchdog();
void configureI2CBus();
bool wireTimeoutFlagged();
void clearWireTimeoutFlagIfAvailable();
bool initializeSD();
void ensureLogHeaders();
bool ensureLogHeader(const char* filename, void (*printer)(Print&));
bool initializeGPS();
void updateGpsListeningState();
bool initializeTempSensor();
bool initializeDepthSensor();
void initializeRTC();

void serviceSystem();
void readGPSStream();
void updateSensorSlot();
void updateAllSensorData();
void updateGPSData();
void updateRTCData();
void updateTempSensor();
void updateDepthSensor();
void syncRTCFromGPSIfReady();

uint16_t getU16BE(const uint8_t* p);
int16_t getI16BE(const uint8_t* p);
void putU16BE(uint8_t* p, uint16_t value);
uint16_t crc16CcittFalse(const uint8_t* data, size_t len);
int hexValue(char c);
void appendHex2(char* out, size_t& pos, uint8_t value);
bool decodeAppUart(const char* line, size_t lineLen, uint8_t* raw, size_t& rawLen);
void sendAppUart(uint8_t logicalId, uint8_t appCmd, const uint8_t* payload, size_t len);
bool parsePlanFields(const uint8_t* rawFields, ControlPlan& plan);
uint8_t validatePlan(const ControlPlan& plan);

bool planUsesDepthSensor(const ControlPlan& plan);
bool depthSensorOk();
bool telemetryTempOk();
float telemetryWaterTemperatureC();
int16_t depthCmFromMeters(float depthM);
int16_t currentDepthCm();
uint16_t nonNegativeDepthCm();
int16_t currentWaterTempCentiC();
uint16_t currentPressureMbar();
uint16_t activePlanId();
uint8_t valveBits();
uint8_t statusFlags();
uint16_t phaseDurationS();
uint8_t nextPhaseAfter(uint8_t current);
uint32_t phaseElapsedMs();
uint32_t phaseRemainingMs();
uint16_t activePlanCrc();
bool heavyIoAllowedNow();

void applyValves(bool injectionOn, bool exhaustOn, const char* cause);
void enterPhase(uint8_t nextPhase, const char* cause);
void stopSafe(const char* cause);
void completePlan();
void enterErrorLockout(uint16_t reasonFlag, const char* message);
void expireLoadedPlanIfNeeded();
void startRunningPlan();
void updateRunningState();
void sendStatusIfDue();

void buildStatus(uint8_t* out);
void sendStatus();
void buildAck(uint8_t* out, uint16_t seq, uint8_t command, uint8_t result, uint16_t detail);
void cacheAck(uint16_t seq, uint8_t command, uint16_t planId, uint16_t cmdCrc, const uint8_t* ack);
void sendAck(uint16_t seq, uint8_t command, uint8_t result, uint16_t detail, uint16_t planId, uint16_t cmdCrc, bool shouldCache);
bool handleDuplicate(uint16_t seq, uint8_t command, uint16_t planId, uint16_t cmdCrc, uint8_t sourceId);
void handleValidCmd(const uint8_t* cmdRaw, uint8_t sourceId);
void handleTritonRaw(const uint8_t* raw, size_t len, uint8_t sourceId);
void handleAppLine(const char* line, size_t lineLen);
void pollTwelite();
void readUsbSerial();

void logData();
void logControlEvent(const char* eventName,
                     bool hasWireless,
                     uint16_t wirelessSeq,
                     uint8_t command,
                     uint8_t result,
                     uint16_t planId,
                     uint16_t planCrc,
                     uint8_t sourceId,
                     uint16_t thresholdCm,
                     const char* message);
void flushControlEventLogs(uint8_t maxRecords);
void printDataHeader(Print& out);
void printEventHeader(Print& out);
void printDataRecord(Print& out, uint32_t seq);
void printEventRecord(Print& out, const ControlEventRecord& record);
void printDate(Print& out);
void printTime(Print& out);
void printDateValue(Print& out, const RTCData& value);
void printTimeValue(Print& out, const RTCData& value);
void printFloatOrNA(Print& out, float value, uint8_t digits);
void printFloatIfValidOrNA(Print& out, bool valid, float value, uint8_t digits);
void printDoubleOrNA(Print& out, double value, uint8_t digits);
void printU16HexOrNA(Print& out, bool valid, uint16_t value);
void printSourceOrNA(Print& out, bool valid, uint8_t sourceId);
void printWirelessSeqOrNA(Print& out, bool valid, uint16_t seq);
bool sdStatusOk();

#if TRITON_ENABLE_LCD
void updateDisplay();
#endif
void setLEDStatus(bool success);
const char* stateToString(uint8_t state);
const char* phaseToString(uint8_t phaseValue);
bool isLeapYear(int year);

// ============================================================
// setup / loop

void setup() {
  currentMillis = millis();

  initializeLEDs();
  initializeValves();
  initializeWatchdog();
  serviceWatchdog();

  Serial.begin(USB_BAUD);
  Serial1.begin(TWELITE_BAUD);
  Wire.begin();
  configureI2CBus();

  phaseStartedMs = currentMillis;
  controlState = STATE_SAFE_IDLE;
  phase = PHASE_IDLE;
  applyValves(false, false, "BOOT_PRE_I2C");

#if TRITON_ENABLE_LCD
  lcd.init();
  serviceWatchdog();
  lcd.backlight();
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(F("UmiBot v4"));
  lcd.setCursor(0, 1);
  lcd.print(F("TWELITE boot"));
#endif

  initializeRTC();
  updateRTCData();
  serviceSystem();

  sdReady = initializeSD();
  ensureLogHeaders();
  serviceSystem();

  initializeGPS();
  tempReady = initializeTempSensor();
  serviceSystem();
  depthReady = initializeDepthSensor();

  currentMillis = millis();
  phaseStartedMs = currentMillis;
  controlState = STATE_SAFE_IDLE;
  phase = PHASE_IDLE;
  applyValves(false, false, "BOOT");

  logControlEvent("BOOT", false, 0, CMD_NONE, RESULT_OK, 0, 0, 0, 0, "system_start_safe_idle");
#if TRITON_ENABLE_LCD
  updateDisplay();
#endif
  serviceWatchdog();
}

void loop() {
  currentMillis = millis();
  serviceSystem();

  readUsbSerial();
  updateRunningState();
  updateGpsListeningState();

  if (gpsListening) {
    readGPSStream();
  }

  updateRunningState();
  syncRTCFromGPSIfReady();

  currentMillis = millis();
  if (currentMillis - lastSensorMillis >= Timing::SENSOR_SLOT_MS) {
    lastSensorMillis = currentMillis;
    updateSensorSlot();
    serviceSystem();
  }

  currentMillis = millis();
  updateRunningState();
  serviceSystem();
  sendStatusIfDue();

  uint32_t logIntervalMs = Timing::DEFAULT_DATA_LOG_MS;
  if (controlState == STATE_RUNNING) {
    logIntervalMs = Timing::DEFAULT_DATA_LOG_MS;
  } else if (loadedPlanValid) {
    logIntervalMs = static_cast<uint32_t>(loadedPlan.logInterval100ms) * 100UL;
  }
  if (logIntervalMs < 500UL) logIntervalMs = 500UL;

  currentMillis = millis();
  updateRunningState();
  if (currentMillis - lastDataLogMillis >= logIntervalMs) {
    lastDataLogMillis = currentMillis;
    logData();
    serviceSystem();
  }

  currentMillis = millis();
  updateRunningState();
  if (currentMillis - lastEventFlushMillis >= Timing::EVENT_FLUSH_MS) {
    lastEventFlushMillis = currentMillis;
    if (heavyIoAllowedNow()) {
      flushControlEventLogs(1);
      serviceSystem();
    }
  }

#if TRITON_ENABLE_LCD
  currentMillis = millis();
  updateRunningState();
  if (currentMillis - lastLcdMillis >= Timing::LCD_UPDATE_MS) {
    lastLcdMillis = currentMillis;
    if (heavyIoAllowedNow()) {
      updateDisplay();
    }
  }
#endif

  setLEDStatus(true);
  serviceWatchdog();
}

// ============================================================
// Initialization

void initializeLEDs() {
  pinMode(Pins::LED_GREEN, OUTPUT);
  pinMode(Pins::LED_RED, OUTPUT);
  digitalWrite(Pins::LED_GREEN, LOW);
  digitalWrite(Pins::LED_RED, LOW);
}

void initializeValves() {
  pinMode(Pins::VALVE_INJECTION, OUTPUT);
  pinMode(Pins::VALVE_EXHAUST, OUTPUT);
  digitalWrite(Pins::VALVE_INJECTION, LOW);
  digitalWrite(Pins::VALVE_EXHAUST, LOW);
  valveStatus.injectionValve = false;
  valveStatus.exhaustValve = false;
}

void initializeWatchdog() {
#if defined(__AVR__) && defined(WDTO_8S)
  wdt_enable(WDTO_8S);
#elif defined(__AVR__) && defined(WDTO_4S)
  wdt_enable(WDTO_4S);
#endif
}

void serviceWatchdog() {
#if defined(__AVR__)
  wdt_reset();
#endif
}

void configureI2CBus() {
#if defined(WIRE_HAS_TIMEOUT)
  Wire.setWireTimeout(Timing::I2C_TIMEOUT_US, true);
  Wire.clearWireTimeoutFlag();
#endif
}

bool wireTimeoutFlagged() {
#if defined(WIRE_HAS_TIMEOUT)
  return Wire.getWireTimeoutFlag();
#else
  return false;
#endif
}

void clearWireTimeoutFlagIfAvailable() {
#if defined(WIRE_HAS_TIMEOUT)
  Wire.clearWireTimeoutFlag();
#endif
}

bool initializeSD() {
  pinMode(SS, OUTPUT);
  if (!SD.begin(Pins::SD_CHIP_SELECT)) {
    Serial.println(F("SD init failed"));
    errorFlags |= ERR_SD_WRITE;
    sdWriteOk = false;
    setLEDStatus(false);
    return false;
  }

  Serial.println(F("SD init OK"));
  sdWriteOk = true;
  errorFlags &= ~ERR_SD_WRITE;
  setLEDStatus(true);
  return true;
}

void ensureLogHeaders() {
  if (!sdReady) return;
  ensureLogHeader(DATA_LOG_FILENAME, printDataHeader);
  ensureLogHeader(EVENT_LOG_FILENAME, printEventHeader);
}

bool ensureLogHeader(const char* filename, void (*printer)(Print&)) {
  if (SD.exists(filename)) return true;
  File f = SD.open(filename, FILE_WRITE);
  if (!f) {
    errorFlags |= ERR_SD_WRITE;
    sdWriteOk = false;
    setLEDStatus(false);
    return false;
  }
  printer(f);
  f.println();
  f.close();
  sdWriteOk = true;
  errorFlags &= ~ERR_SD_WRITE;
  return true;
}

bool initializeGPS() {
  gpsSerial.begin(GPS_BAUD);
  gpsSerial.listen();
  gpsListening = true;
  Serial.println(F("GPS init OK"));
  return true;
}

void updateGpsListeningState() {
  bool shouldListen = controlState != STATE_RUNNING;
  if (shouldListen && !gpsListening) {
    gpsSerial.listen();
    gpsListening = true;
  } else if (!shouldListen && gpsListening) {
    gpsSerial.stopListening();
    gpsListening = false;
  }
}

bool initializeTempSensor() {
  sensorData.waterTemperature = NAN;
  sensorData.tempValid = false;
  errorFlags &= ~ERR_TEMP_SENSOR;
  Serial.println(F("TSYS01 not installed; MS5837 temperature is used for STATUS"));
  return false;
}

bool initializeDepthSensor() {
  clearWireTimeoutFlagIfAvailable();
  if (!depthSensor.init() || wireTimeoutFlagged()) {
    Serial.println(F("MS5837 init failed"));
    errorFlags |= ERR_DEPTH_SENSOR;
    clearWireTimeoutFlagIfAvailable();
    setLEDStatus(false);
    return false;
  }
  depthSensor.setModel(MS5837::MS5837_30BA);
  depthSensor.setFluidDensity(997);
  Serial.println(F("MS5837 init OK"));
  errorFlags &= ~ERR_DEPTH_SENSOR;
  return true;
}

void initializeRTC() {
  const bool SET_RTC_ON_BOOT = false;
  if (SET_RTC_ON_BOOT) {
    rtc.setDateTime(2025, 7, 24, 16, 51, 0);
  }
  Serial.println(F("RTC init done"));
}

// ============================================================
// Sensor updates

void serviceSystem() {
  serviceWatchdog();
  pollTwelite();
}

void readGPSStream() {
  if (!gpsListening) return;
  while (gpsSerial.available()) {
    gps.encode(gpsSerial.read());
  }
}

void updateSensorSlot() {
  switch (sensorUpdateSlot++ & 0x03) {
    case 0:
      updateGPSData();
      updateRTCData();
      break;
    case 1:
      updateTempSensor();
      break;
    case 2:
      updateGPSData();
      updateRTCData();
      break;
    default:
      updateDepthSensor();
      break;
  }
}

void updateAllSensorData() {
  updateGPSData();
  updateRTCData();
  serviceSystem();
  updateTempSensor();
  serviceSystem();
  updateDepthSensor();
}

void updateGPSData() {
  if (gps.location.isValid()) {
    gpsData.latitude = gps.location.lat();
    gpsData.longitude = gps.location.lng();
    gpsData.locationValid = true;
  }

  if (gps.altitude.isValid()) {
    gpsData.altitudeM = gps.altitude.meters();
    gpsData.altitudeValid = true;
  }

  if (gps.satellites.isValid()) {
    gpsData.satellites = gps.satellites.value();
  }

  gpsData.timeValid = gps.time.isValid() && gps.date.isValid();
}

void updateRTCData() {
  tmElements_t tm = rtc.read();
  rtcData.year = tmYearToCalendar(tm.Year);
  rtcData.month = tm.Month;
  rtcData.day = tm.Day;
  rtcData.hour = tm.Hour;
  rtcData.minute = tm.Minute;
  rtcData.second = tm.Second;
}

void updateTempSensor() {
  sensorData.waterTemperature = NAN;
  sensorData.tempValid = false;
  errorFlags &= ~ERR_TEMP_SENSOR;
}

void updateDepthSensor() {
  if (!depthReady) {
    sensorData.depthValid = false;
#if TRITON_ENABLE_DEPTH_FREEZE_DETECTOR
    depthFrozen = false;
#endif
    errorFlags |= ERR_DEPTH_SENSOR;
    return;
  }

  clearWireTimeoutFlagIfAvailable();
  depthSensor.read();
  if (wireTimeoutFlagged()) {
    sensorData.depthValid = false;
#if TRITON_ENABLE_DEPTH_FREEZE_DETECTOR
    depthFrozen = false;
#endif
    errorFlags |= ERR_DEPTH_SENSOR | ERR_SENSOR_STALE;
    clearWireTimeoutFlagIfAvailable();
    return;
  }

  sensorData.pressureMbar = depthSensor.pressure();
  sensorData.depthM = depthSensor.depth();
  sensorData.pressureTempC = depthSensor.temperature();
  bool rawValid = !isnan(sensorData.depthM) &&
                  !isnan(sensorData.pressureMbar) &&
                  sensorData.depthM >= -1.0f &&
                  sensorData.depthM <= 100.0f &&
                  sensorData.pressureMbar >= 0.0f &&
                  sensorData.pressureMbar <= 65534.0f;

  if (!rawValid) {
    sensorData.depthValid = false;
#if TRITON_ENABLE_DEPTH_FREEZE_DETECTOR
    depthFrozen = false;
#endif
    errorFlags |= ERR_DEPTH_SENSOR;
    return;
  }

#if TRITON_ENABLE_DEPTH_FREEZE_DETECTOR
  int16_t sampleCm = depthCmFromMeters(sensorData.depthM);
  uint16_t samplePressure = static_cast<uint16_t>(sensorData.pressureMbar + 0.5f);

  if (!depthSampleSeen || sampleCm != lastDepthSampleCm || samplePressure != lastPressureSampleMbar) {
    depthSampleSeen = true;
    unchangedDepthSamples = 0;
    lastDepthChangedMillis = currentMillis;
    lastDepthSampleCm = sampleCm;
    lastPressureSampleMbar = samplePressure;
    depthFrozen = false;
  } else if (unchangedDepthSamples < 255) {
    unchangedDepthSamples++;
  }

  if (depthSampleSeen && unchangedDepthSamples >= DEPTH_FREEZE_MIN_SAMPLES &&
      currentMillis - lastDepthChangedMillis >= Timing::DEPTH_FREEZE_STALE_MS) {
    sensorData.depthValid = false;
    depthFrozen = true;
    errorFlags |= ERR_SENSOR_STALE;
    return;
  }
#endif

  sensorData.depthValid = true;
  lastDepthValidMillis = currentMillis;
  errorFlags &= static_cast<uint16_t>(~(ERR_DEPTH_SENSOR | ERR_SENSOR_STALE));

  if (sensorData.depthM > sensorData.missionMaxDepthM) {
    sensorData.missionMaxDepthM = sensorData.depthM;
  }
  uint16_t depthCm = nonNegativeDepthCm();
  if (depthCm > observedMaxDepthCm) {
    observedMaxDepthCm = depthCm;
  }
}

void syncRTCFromGPSIfReady() {
  if (rtcSyncedFromGPS) return;
  if (!gps.date.isValid() || !gps.time.isValid()) return;
  if (gps.date.year() < 2024) return;

  int year = gps.date.year();
  int month = gps.date.month();
  int day = gps.date.day();
  int hour = gps.time.hour() + 9;
  int minute = gps.time.minute();
  int second = gps.time.second();

  if (month < 1 || month > 12 || day < 1 || day > 31 ||
      hour < 0 || hour > 32 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return;
  }

  const int daysInMonthNormal[12] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  int maxDay = daysInMonthNormal[month - 1];
  if (month == 2 && isLeapYear(year)) maxDay = 29;
  if (day > maxDay) return;

  if (hour >= 24) {
    hour -= 24;
    day++;
  }

  maxDay = daysInMonthNormal[month - 1];
  if (month == 2 && isLeapYear(year)) maxDay = 29;

  if (day > maxDay) {
    day = 1;
    month++;
  }
  if (month > 12) {
    month = 1;
    year++;
  }

  rtc.setDateTime(year, month, day, hour, minute, second);
  rtcSyncedFromGPS = true;
  updateRTCData();
  logControlEvent("RTC_SYNC_GPS", false, 0, CMD_NONE, RESULT_OK, activePlanId(), activePlanCrc(), 0, 0, "rtc_synced_jst");
}

// ============================================================
// Protocol helpers

uint16_t getU16BE(const uint8_t* p) {
  return (static_cast<uint16_t>(p[0]) << 8) | p[1];
}

int16_t getI16BE(const uint8_t* p) {
  return static_cast<int16_t>(getU16BE(p));
}

void putU16BE(uint8_t* p, uint16_t value) {
  p[0] = static_cast<uint8_t>((value >> 8) & 0xFF);
  p[1] = static_cast<uint8_t>(value & 0xFF);
}

uint16_t crc16CcittFalse(const uint8_t* data, size_t len) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < len; ++i) {
    crc ^= static_cast<uint16_t>(data[i]) << 8;
    for (uint8_t bit = 0; bit < 8; ++bit) {
      crc = (crc & 0x8000) ? static_cast<uint16_t>((crc << 1) ^ 0x1021)
                           : static_cast<uint16_t>(crc << 1);
    }
  }
  return crc;
}

int hexValue(char c) {
  if ('0' <= c && c <= '9') return c - '0';
  if ('A' <= c && c <= 'F') return c - 'A' + 10;
  if ('a' <= c && c <= 'f') return c - 'a' + 10;
  return -1;
}

void appendHex2(char* out, size_t& pos, uint8_t value) {
  static const char hex[] = "0123456789ABCDEF";
  out[pos++] = hex[(value >> 4) & 0x0F];
  out[pos++] = hex[value & 0x0F];
}

bool decodeAppUart(const char* line, size_t lineLen, uint8_t* raw, size_t& rawLen) {
  rawLen = 0;
  if (lineLen < 7 || line[0] != ':') {
    return false;
  }
  size_t hexLen = lineLen - 1;
  if ((hexLen & 1U) != 0) {
    return false;
  }
  size_t byteLen = hexLen / 2;
  if (byteLen < 3 || byteLen > T3_RAW_BUF_LEN) {
    return false;
  }
  for (size_t i = 0; i < byteLen; ++i) {
    int hi = hexValue(line[1 + i * 2]);
    int lo = hexValue(line[2 + i * 2]);
    if (hi < 0 || lo < 0) {
      return false;
    }
    raw[i] = static_cast<uint8_t>((hi << 4) | lo);
  }
  uint8_t sum = 0;
  for (size_t i = 0; i < byteLen; ++i) {
    sum = static_cast<uint8_t>(sum + raw[i]);
  }
  if (sum != 0) {
    return false;
  }
  rawLen = byteLen;
  return true;
}

void sendAppUart(uint8_t logicalId, uint8_t appCmd, const uint8_t* payload, size_t len) {
  if (len + 3 > T3_RAW_BUF_LEN) {
    return;
  }

  char line[1 + 2 * T3_RAW_BUF_LEN + 2];
  size_t pos = 0;
  uint8_t sum = 0;
  line[pos++] = ':';
  appendHex2(line, pos, logicalId);
  sum = static_cast<uint8_t>(sum + logicalId);
  appendHex2(line, pos, appCmd);
  sum = static_cast<uint8_t>(sum + appCmd);
  for (size_t i = 0; i < len; ++i) {
    appendHex2(line, pos, payload[i]);
    sum = static_cast<uint8_t>(sum + payload[i]);
  }
  appendHex2(line, pos, static_cast<uint8_t>(0 - sum));
  line[pos++] = '\r';
  line[pos++] = '\n';
  Serial1.write(reinterpret_cast<const uint8_t*>(line), pos);
}

bool parsePlanFields(const uint8_t* rawFields, ControlPlan& plan) {
  memcpy(plan.raw, rawFields, sizeof(plan.raw));
  plan.planFlags = rawFields[0];
  plan.maxRuntimeMin = rawFields[1];
  plan.planId = getU16BE(rawFields + 2);
  plan.repeatCount = getU16BE(rawFields + 4);
  plan.prepareS = getU16BE(rawFields + 6);
  plan.exhaustOpenS = getU16BE(rawFields + 8);
  plan.descentCoastS = getU16BE(rawFields + 10);
  plan.bottomWaitS = getU16BE(rawFields + 12);
  plan.injectionOpenS = getU16BE(rawFields + 14);
  plan.ascentWaitS = getU16BE(rawFields + 16);
  plan.depthTriggerCm = getU16BE(rawFields + 18);
  plan.maxDepthCm = getU16BE(rawFields + 20);
  plan.logInterval100ms = getU16BE(rawFields + 22);
  plan.statusInterval100ms = getU16BE(rawFields + 24);
  plan.commTimeoutS = rawFields[26];
  plan.safetyPolicy = rawFields[27];
  return true;
}

uint8_t validatePlan(const ControlPlan& plan) {
  if ((plan.planFlags & FLAG_RESERVED_MASK) != 0) return RESULT_REJECT_BAD_PARAM;
  if (plan.planId == 0) return RESULT_REJECT_BAD_PARAM;
  if (plan.repeatCount == 0) return RESULT_REJECT_BAD_PARAM;
  if (plan.prepareS > 3600 || plan.exhaustOpenS > 600 || plan.descentCoastS > 3600 ||
      plan.bottomWaitS > 3600 || plan.injectionOpenS == 0 || plan.injectionOpenS > 600 ||
      plan.ascentWaitS > 3600) {
    return RESULT_REJECT_BAD_PARAM;
  }
  if (plan.depthTriggerCm > 6000 || plan.maxDepthCm > 8000) return RESULT_REJECT_BAD_PARAM;
  if (plan.logInterval100ms < 5 || plan.logInterval100ms > 600) return RESULT_REJECT_BAD_PARAM;
  if (plan.statusInterval100ms < 5 || plan.statusInterval100ms > 600) return RESULT_REJECT_BAD_PARAM;
  if (plan.safetyPolicy != SAFETY_POLICY_STOP_SAFE_ONLY) return RESULT_REJECT_BAD_PARAM;
  if ((plan.planFlags & FLAG_DEPTH_TRIGGER_ENABLE) && plan.depthTriggerCm == 0) return RESULT_REJECT_BAD_PARAM;
  if ((plan.planFlags & FLAG_MAX_DEPTH_ENABLE) && plan.maxDepthCm == 0) return RESULT_REJECT_BAD_PARAM;
  if (plan.planFlags & FLAG_COMM_TIMEOUT_ENABLE) {
    if (!ALLOW_RUNNING_COMM_TIMEOUT || plan.commTimeoutS == 0) return RESULT_REJECT_BAD_PARAM;
  }
  if (plan.repeatCount == 0xFFFF && ((plan.planFlags & FLAG_ALLOW_INFINITE_REPEAT) == 0 || plan.maxRuntimeMin == 0)) {
    return RESULT_REJECT_BAD_PARAM;
  }
  if (!ALLOW_LOAD_WITH_DEPTH_SENSOR_FAULT && planUsesDepthSensor(plan) && !depthSensorOk()) {
    return RESULT_REJECT_SENSOR_REQUIRED;
  }
  if ((plan.planFlags & FLAG_DEPTH_TRIGGER_ENABLE) && (plan.planFlags & FLAG_MAX_DEPTH_ENABLE) &&
      plan.maxDepthCm < static_cast<uint16_t>(plan.depthTriggerCm + DEPTH_MARGIN_CM)) {
    return RESULT_REJECT_BAD_PARAM;
  }
  return RESULT_OK;
}

// ============================================================
// Control-state helpers

bool planUsesDepthSensor(const ControlPlan& plan) {
  return (plan.planFlags & (FLAG_DEPTH_TRIGGER_ENABLE | FLAG_MAX_DEPTH_ENABLE | FLAG_REQUIRE_DEPTH_SENSOR)) != 0;
}

bool depthSensorOk() {
  bool ok = depthReady && sensorData.depthValid &&
            (currentMillis - lastDepthValidMillis <= Timing::SENSOR_STALE_MS);
#if TRITON_ENABLE_DEPTH_FREEZE_DETECTOR
  ok = ok && !depthFrozen;
#endif
  return ok;
}

int16_t depthCmFromMeters(float depthM) {
  float cmFloat = depthM * 100.0f;
  int32_t cm = static_cast<int32_t>(cmFloat >= 0.0f ? cmFloat + 0.5f : cmFloat - 0.5f);
  if (cm < -32767L) return -32767;
  if (cm > 32767L) return 32767;
  return static_cast<int16_t>(cm);
}

int16_t currentDepthCm() {
  if (!depthSensorOk()) return static_cast<int16_t>(0x8000);
  return depthCmFromMeters(sensorData.depthM);
}

uint16_t nonNegativeDepthCm() {
  int16_t cm = currentDepthCm();
  if (cm < 0) return 0;
  return static_cast<uint16_t>(cm);
}

bool telemetryTempOk() {
  return depthSensorOk() &&
         !isnan(sensorData.pressureTempC) &&
         sensorData.pressureTempC > -10.0f &&
         sensorData.pressureTempC < 60.0f;
}

float telemetryWaterTemperatureC() {
  return sensorData.pressureTempC;
}

int16_t currentWaterTempCentiC() {
  if (!telemetryTempOk()) return static_cast<int16_t>(0x8000);
  float centiFloat = telemetryWaterTemperatureC() * 100.0f;
  int32_t centi = static_cast<int32_t>(centiFloat >= 0.0f ? centiFloat + 0.5f : centiFloat - 0.5f);
  if (centi < -32767L) return -32767;
  if (centi > 32767L) return 32767;
  return static_cast<int16_t>(centi);
}

uint16_t currentPressureMbar() {
  if (!depthSensorOk() || isnan(sensorData.pressureMbar) || sensorData.pressureMbar < 0.0f || sensorData.pressureMbar > 65534.0f) {
    return 0xFFFF;
  }
  return static_cast<uint16_t>(sensorData.pressureMbar + 0.5f);
}

uint16_t activePlanId() {
  if (controlState == STATE_RUNNING || controlState == STATE_COMPLETED) return runningPlan.planId;
  if (loadedPlanValid) return loadedPlan.planId;
  return 0;
}

uint8_t valveBits() {
  return (valveStatus.injectionValve ? 0x01 : 0x00) | (valveStatus.exhaustValve ? 0x02 : 0x00);
}

uint8_t statusFlags() {
  uint8_t flags = 0;
  if (gpsData.locationValid) flags |= STATUS_GPS_VALID;
  if (sdStatusOk()) flags |= STATUS_SD_OK;
  if (telemetryTempOk()) flags |= STATUS_TEMP_OK;
  if (depthSensorOk()) flags |= STATUS_DEPTH_OK;
  if (loadedPlanValid || controlState == STATE_RUNNING || controlState == STATE_COMPLETED) flags |= STATUS_PLAN_VALID;

  if (controlState != STATE_RUNNING && pcSeen && currentMillis - lastPcSeenMs < 30000UL) {
    flags |= STATUS_PC_LINK_RECENT;
  }
  return flags;
}

uint16_t phaseDurationS() {
  switch (phase) {
    case PHASE_PREPARE: return runningPlan.prepareS;
    case PHASE_EXHAUST_OPEN: return runningPlan.exhaustOpenS;
    case PHASE_DESCENT_COAST: return runningPlan.descentCoastS;
    case PHASE_BOTTOM_WAIT: return runningPlan.bottomWaitS;
    case PHASE_INJECTION_OPEN: return runningPlan.injectionOpenS;
    case PHASE_ASCENT_WAIT: return runningPlan.ascentWaitS;
    default: return 0;
  }
}

uint8_t nextPhaseAfter(uint8_t current) {
  switch (current) {
    case PHASE_PREPARE: return PHASE_EXHAUST_OPEN;
    case PHASE_EXHAUST_OPEN: return PHASE_DESCENT_COAST;
    case PHASE_DESCENT_COAST: return PHASE_BOTTOM_WAIT;
    case PHASE_BOTTOM_WAIT: return PHASE_INJECTION_OPEN;
    case PHASE_INJECTION_OPEN: return PHASE_ASCENT_WAIT;
    default: return PHASE_COMPLETE;
  }
}

uint32_t phaseElapsedMs() {
  return currentMillis - phaseStartedMs;
}

uint32_t phaseRemainingMs() {
  uint32_t durationMs = static_cast<uint32_t>(phaseDurationS()) * 1000UL;
  uint32_t elapsedMs = phaseElapsedMs();
  if (durationMs == 0 || elapsedMs >= durationMs) return 0;
  return durationMs - elapsedMs;
}

uint16_t activePlanCrc() {
  if (controlState == STATE_RUNNING || controlState == STATE_COMPLETED) {
    return crc16CcittFalse(runningPlan.raw, sizeof(runningPlan.raw));
  }
  if (loadedPlanValid) return loadedPlanCrc;
  return 0;
}

bool heavyIoAllowedNow() {
  if (controlState != STATE_RUNNING) return true;
  return valveBits() == 0;
}

void applyValves(bool injectionOn, bool exhaustOn, const char* cause) {
  currentMillis = millis();
  serviceWatchdog();

  if (injectionOn && exhaustOn) {
    digitalWrite(Pins::VALVE_INJECTION, LOW);
    digitalWrite(Pins::VALVE_EXHAUST, LOW);
    valveStatus.injectionValve = false;
    valveStatus.exhaustValve = false;
    controlState = STATE_ERROR_LOCKOUT;
    phase = PHASE_ERROR;
    phaseStartedMs = currentMillis;
    errorFlags |= ERR_VALVE_CONFLICT | ERR_ERROR_LOCKOUT;
    logControlEvent("VALVE_CONFLICT", false, 0, CMD_NONE, RESULT_OK, activePlanId(), activePlanCrc(), 0, 0, cause);
    return;
  }

  if (valveStatus.injectionValve && !injectionOn) {
    digitalWrite(Pins::VALVE_INJECTION, LOW);
    valveStatus.injectionValve = false;
    logControlEvent("VALVE_OFF", false, 0, CMD_NONE, RESULT_OK, activePlanId(), activePlanCrc(), 0, 0, "injection");
  }
  if (valveStatus.exhaustValve && !exhaustOn) {
    digitalWrite(Pins::VALVE_EXHAUST, LOW);
    valveStatus.exhaustValve = false;
    logControlEvent("VALVE_OFF", false, 0, CMD_NONE, RESULT_OK, activePlanId(), activePlanCrc(), 0, 0, "exhaust");
  }
  if (!valveStatus.injectionValve && injectionOn) {
    digitalWrite(Pins::VALVE_INJECTION, HIGH);
    valveStatus.injectionValve = true;
    logControlEvent("VALVE_ON", false, 0, CMD_NONE, RESULT_OK, activePlanId(), activePlanCrc(), 0, 0, "injection");
  }
  if (!valveStatus.exhaustValve && exhaustOn) {
    digitalWrite(Pins::VALVE_EXHAUST, HIGH);
    valveStatus.exhaustValve = true;
    logControlEvent("VALVE_ON", false, 0, CMD_NONE, RESULT_OK, activePlanId(), activePlanCrc(), 0, 0, "exhaust");
  }
}

void enterPhase(uint8_t nextPhase, const char* cause) {
  currentMillis = millis();
  phase = nextPhase;
  phaseStartedMs = currentMillis;
  if (phase == PHASE_PREPARE) {
    cycleDepthTriggered = false;
  }
  if (phase == PHASE_EXHAUST_OPEN) {
    applyValves(false, runningPlan.exhaustOpenS > 0, cause);
  } else if (phase == PHASE_INJECTION_OPEN) {
    applyValves(true, false, cause);
  } else {
    applyValves(false, false, cause);
  }
  logControlEvent("PHASE_CHANGE", false, 0, CMD_NONE, RESULT_OK, activePlanId(), activePlanCrc(), 0,
                  runningPlan.depthTriggerCm, phaseToString(phase));
}

void stopSafe(const char* cause) {
  currentMillis = millis();
  applyValves(false, false, cause);
  if (controlState != STATE_ERROR_LOCKOUT) {
    controlState = STATE_SAFE_IDLE;
  } else {
    errorFlags |= ERR_ERROR_LOCKOUT;
  }
  phase = PHASE_IDLE;
  phaseStartedMs = currentMillis;
  loadedPlanValid = false;
  cycleCount = 0;
}

void completePlan() {
  currentMillis = millis();
  applyValves(false, false, "COMPLETE");
  controlState = STATE_COMPLETED;
  phase = PHASE_COMPLETE;
  phaseStartedMs = currentMillis;
  loadedPlanValid = false;
  logControlEvent("PLAN_COMPLETE", false, 0, CMD_NONE, RESULT_OK, activePlanId(), activePlanCrc(), 0, 0, "complete");
}

void enterErrorLockout(uint16_t reasonFlag, const char* message) {
  currentMillis = millis();
  applyValves(false, false, message);
  controlState = STATE_ERROR_LOCKOUT;
  phase = PHASE_ERROR;
  phaseStartedMs = currentMillis;
  loadedPlanValid = false;
  errorFlags |= reasonFlag | ERR_ERROR_LOCKOUT;
  logControlEvent("ERROR_LOCKOUT", false, 0, CMD_NONE, RESULT_OK, activePlanId(), activePlanCrc(), 0, 0, message);
}

void expireLoadedPlanIfNeeded() {
  if (controlState == STATE_PLAN_LOADED && loadedPlanValid &&
      currentMillis - loadedAtMs > PLAN_LOADED_TIMEOUT_MS) {
    uint16_t expiredPlanId = loadedPlan.planId;
    uint16_t expiredPlanCrc = loadedPlanCrc;
    loadedPlanValid = false;
    controlState = STATE_SAFE_IDLE;
    phase = PHASE_IDLE;
    phaseStartedMs = currentMillis;
    applyValves(false, false, "PLAN_EXPIRED");
    errorFlags |= ERR_PLAN_EXPIRED;
    logControlEvent("PLAN_EXPIRED", false, 0, CMD_NONE, RESULT_REJECT_PLAN_EXPIRED, expiredPlanId, expiredPlanCrc, 0, 0, "loaded_plan_timeout");
  }
}

void startRunningPlan() {
  runningPlan = loadedPlan;
  controlState = STATE_RUNNING;
  cycleCount = 0;
  observedMaxDepthCm = 0;
  sensorData.missionMaxDepthM = 0.0f;
  runningStartedMs = currentMillis;
  cycleDepthTriggered = false;
  enterPhase(PHASE_PREPARE, "START_PLAN");
}

void updateRunningState() {
  currentMillis = millis();
  expireLoadedPlanIfNeeded();
  if (controlState != STATE_RUNNING) {
    return;
  }

  if (!BYPASS_REQUIRED_DEPTH_SENSOR_LOCKOUT && planUsesDepthSensor(runningPlan) && !depthSensorOk()) {
    enterErrorLockout(ERR_SENSOR_STALE | ERR_DEPTH_SENSOR, "required_depth_sensor_stale");
    return;
  }

  if (ALLOW_RUNNING_COMM_TIMEOUT &&
      (runningPlan.planFlags & FLAG_COMM_TIMEOUT_ENABLE) && runningPlan.commTimeoutS > 0 &&
      pcSeen && currentMillis - lastPcSeenMs > static_cast<uint32_t>(runningPlan.commTimeoutS) * 1000UL) {
    uint16_t stoppedPlanId = activePlanId();
    uint16_t stoppedPlanCrc = activePlanCrc();
    errorFlags |= ERR_COMM_TIMEOUT;
    stopSafe("COMM_TIMEOUT");
    logControlEvent("COMM_TIMEOUT", false, 0, CMD_NONE, RESULT_OK_STOPPED, stoppedPlanId, stoppedPlanCrc, 0, 0, "stop_safe");
    return;
  }

  if (!BYPASS_SENSOR_DERIVED_MAX_DEPTH_LOCKOUT &&
      (runningPlan.planFlags & FLAG_MAX_DEPTH_ENABLE) &&
      runningPlan.maxDepthCm > 0 && nonNegativeDepthCm() >= runningPlan.maxDepthCm) {
    enterErrorLockout(ERR_MAX_DEPTH, "max_depth_reached");
    return;
  }

  if (runningPlan.maxRuntimeMin > 0 &&
      currentMillis - runningStartedMs >= static_cast<uint32_t>(runningPlan.maxRuntimeMin) * 60000UL) {
    completePlan();
    return;
  }

  if ((runningPlan.planFlags & FLAG_DEPTH_TRIGGER_ENABLE) && !cycleDepthTriggered &&
      (phase == PHASE_EXHAUST_OPEN || phase == PHASE_DESCENT_COAST || phase == PHASE_BOTTOM_WAIT) &&
      runningPlan.depthTriggerCm > 0 &&
      nonNegativeDepthCm() >= runningPlan.depthTriggerCm) {
    cycleDepthTriggered = true;
    logControlEvent("DEPTH_TRIGGER", false, 0, CMD_NONE, RESULT_OK, activePlanId(), activePlanCrc(), 0,
                    runningPlan.depthTriggerCm, "threshold_reached");
    enterPhase(PHASE_INJECTION_OPEN, "DEPTH_TRIGGER");
  }

  uint8_t guard = 0;
  while (controlState == STATE_RUNNING && guard++ < 8) {
    currentMillis = millis();
    uint16_t duration = phaseDurationS();
    uint32_t elapsedMs = currentMillis - phaseStartedMs;
    if (elapsedMs < static_cast<uint32_t>(duration) * 1000UL) {
      break;
    }
    uint8_t next = nextPhaseAfter(phase);
    if (next == PHASE_COMPLETE) {
      cycleCount++;
      if (runningPlan.repeatCount == 0xFFFF || cycleCount < runningPlan.repeatCount) {
        enterPhase(PHASE_PREPARE, "NEXT_CYCLE");
      } else {
        completePlan();
        break;
      }
    } else {
      enterPhase(next, "TIMER");
    }
    serviceWatchdog();
  }
}

void sendStatusIfDue() {
  if (controlState == STATE_RUNNING && !SEND_PERIODIC_STATUS_WHILE_RUNNING) {
    return;
  }
  if (controlState != STATE_RUNNING && !SEND_AUTONOMOUS_STATUS_WHILE_NOT_RUNNING) {
    return;
  }

  uint32_t intervalMs = AUTONOMOUS_STATUS_NOT_RUNNING_MS;
  if (controlState == STATE_RUNNING) {
    intervalMs = static_cast<uint32_t>(runningPlan.statusInterval100ms) * 100UL;
  }
  if (intervalMs == 0) intervalMs = 1000UL;
  if (currentMillis - lastStatusMs >= intervalMs) {
    sendStatus();
    lastStatusMs = currentMillis;
  }
}

// ============================================================
// ACK / STATUS / command handling

void buildStatus(uint8_t* out) {
  memset(out, 0, T3_RAW_STATUS_LEN);
  out[0] = T3_HEADER;
  out[1] = T3_PROTOCOL_VER;
  out[2] = T3_PACKET_STATUS;
  putU16BE(out + 3, statusSeq++);
  out[5] = DEVICE_ID;
  out[6] = controlState;
  out[7] = phase;
  out[8] = valveBits();
  out[9] = statusFlags();
  putU16BE(out + 10, activePlanId());
  putU16BE(out + 12, cycleCount);
  uint32_t elapsed32 = phaseElapsedMs() / 1000UL;
  uint16_t elapsed = elapsed32 > 65535UL ? 65535 : static_cast<uint16_t>(elapsed32);
  uint16_t duration = phaseDurationS();
  putU16BE(out + 14, elapsed);
  putU16BE(out + 16, elapsed >= duration ? 0 : static_cast<uint16_t>(duration - elapsed));
  putU16BE(out + 18, static_cast<uint16_t>(currentDepthCm()));
  putU16BE(out + 20, observedMaxDepthCm);
  putU16BE(out + 22, static_cast<uint16_t>(currentWaterTempCentiC()));
  putU16BE(out + 24, currentPressureMbar());
  out[26] = gpsData.satellites;
  out[27] = lastCmdResult;
  putU16BE(out + 28, lastCmdSeq);
  putU16BE(out + 30, 0xFFFF);
  putU16BE(out + 32, errorFlags);
  uint32_t ageS = !pcSeen ? 255UL : (currentMillis - lastPcSeenMs) / 1000UL;
  out[34] = ageS > 255 ? 255 : static_cast<uint8_t>(ageS);
  out[35] = 0xFF;
  out[36] = 0;
  putU16BE(out + 37, crc16CcittFalse(out, 37));
  out[39] = T3_FOOTER;
}

void sendStatus() {
  uint8_t status[T3_RAW_STATUS_LEN];
  buildStatus(status);
  sendAppUart(TWELITE_PARENT_ID, T3_APP_UART_CMD, status, sizeof(status));
}

void buildAck(uint8_t* out, uint16_t seq, uint8_t command, uint8_t result, uint16_t detail) {
  memset(out, 0, T3_RAW_ACK_LEN);
  out[0] = T3_HEADER;
  out[1] = T3_PROTOCOL_VER;
  out[2] = T3_PACKET_ACK;
  putU16BE(out + 3, seq);
  out[5] = DEVICE_ID;
  out[6] = command;
  out[7] = result;
  out[8] = controlState;
  out[9] = phase;
  putU16BE(out + 10, activePlanId());
  putU16BE(out + 12, detail);
  out[14] = valveBits();
  out[15] = static_cast<uint8_t>(errorFlags & 0xFF);
  out[16] = 0;
  putU16BE(out + 17, crc16CcittFalse(out, 17));
  out[19] = T3_FOOTER;
}

void cacheAck(uint16_t seq, uint8_t command, uint16_t planId, uint16_t cmdCrc, const uint8_t* ack) {
  AckCacheEntry& entry = ackCache[ackCacheNext++ % ACK_CACHE_SIZE];
  entry.valid = true;
  entry.seq = seq;
  entry.command = command;
  entry.planId = planId;
  entry.cmdCrc = cmdCrc;
  entry.createdMs = currentMillis;
  memcpy(entry.ack, ack, T3_RAW_ACK_LEN);
}

void sendAck(uint16_t seq, uint8_t command, uint8_t result, uint16_t detail, uint16_t planId, uint16_t cmdCrc, bool shouldCache) {
  uint8_t ack[T3_RAW_ACK_LEN];
  lastCmdSeq = seq;
  lastCmdResult = result;
  buildAck(ack, seq, command, result, detail);
  sendAppUart(TWELITE_PARENT_ID, T3_APP_UART_CMD, ack, sizeof(ack));
  if (shouldCache) {
    cacheAck(seq, command, planId, cmdCrc, ack);
  }
}

bool handleDuplicate(uint16_t seq, uint8_t command, uint16_t planId, uint16_t cmdCrc, uint8_t sourceId) {
  if (command == CMD_STOP_SAFE) {
    return false;
  }
  for (uint8_t i = 0; i < ACK_CACHE_SIZE; ++i) {
    AckCacheEntry& entry = ackCache[i];
    if (!entry.valid || entry.seq != seq) continue;
    if (currentMillis - entry.createdMs > ACK_CACHE_TTL_MS) {
      entry.valid = false;
      continue;
    }
    if (entry.command == command && entry.planId == planId && entry.cmdCrc == cmdCrc) {
      sendAppUart(TWELITE_PARENT_ID, T3_APP_UART_CMD, entry.ack, T3_RAW_ACK_LEN);
      logControlEvent("DUPLICATE_ACK", true, seq, command, entry.ack[7], planId, activePlanCrc(), sourceId, 0, "cached_ack");
    } else {
      sendAck(seq, command, RESULT_REJECT_SEQ_MISMATCH, 0, planId, cmdCrc, false);
      logControlEvent("CMD_REJECT", true, seq, command, RESULT_REJECT_SEQ_MISMATCH, planId, activePlanCrc(), sourceId, 0, "seq_mismatch");
    }
    return true;
  }
  return false;
}

void handleValidCmd(const uint8_t* cmdRaw, uint8_t sourceId) {
  currentMillis = millis();
  serviceWatchdog();

  uint16_t seq = getU16BE(cmdRaw + 3);
  uint8_t command = cmdRaw[6];
  uint16_t safetyKey = getU16BE(cmdRaw + 35);
  uint16_t cmdCrc = getU16BE(cmdRaw + 37);
  ControlPlan receivedPlan;
  parsePlanFields(cmdRaw + 7, receivedPlan);
  uint16_t planId = receivedPlan.planId;

  if (command <= CMD_REQUEST_STATUS) {
    lastPcSeenMs = currentMillis;
    pcSeen = true;
  }

  if (handleDuplicate(seq, command, planId, cmdCrc, sourceId)) {
    return;
  }

  if (command == CMD_STOP_SAFE) {
    bool wasLockout = controlState == STATE_ERROR_LOCKOUT;
    uint16_t stoppedPlanId = activePlanId();
    uint16_t stoppedPlanCrc = activePlanCrc();
    stopSafe("STOP_SAFE");
    uint8_t result = wasLockout ? RESULT_OK_STOPPED_LOCKOUT : RESULT_OK_STOPPED;
    sendAck(seq, command, result, 0, planId, cmdCrc, true);
    logControlEvent("STOP_SAFE", true, seq, command, result, stoppedPlanId, stoppedPlanCrc, sourceId, 0, "stopped");
    return;
  }

  expireLoadedPlanIfNeeded();

  if (command == CMD_NOP) {
    sendAck(seq, command, RESULT_OK, 0, planId, cmdCrc, true);
    logControlEvent("NOP", true, seq, command, RESULT_OK, activePlanId(), activePlanCrc(), sourceId, 0, "link_check");
    return;
  }

  if (command == CMD_REQUEST_STATUS) {
    sendAck(seq, command, RESULT_OK, 0, planId, cmdCrc, true);
    sendStatus();
    logControlEvent("REQUEST_STATUS", true, seq, command, RESULT_OK, activePlanId(), activePlanCrc(), sourceId, 0, "status_sent");
    return;
  }

  if (command == CMD_LOAD_PLAN) {
    if (controlState == STATE_RUNNING) {
      sendAck(seq, command, RESULT_REJECT_BUSY_RUNNING, 0, planId, cmdCrc, true);
      logControlEvent("LOAD_PLAN", true, seq, command, RESULT_REJECT_BUSY_RUNNING, planId, activePlanCrc(), sourceId,
                      receivedPlan.depthTriggerCm, "busy_running");
      return;
    }
    if (controlState != STATE_SAFE_IDLE && controlState != STATE_PLAN_LOADED && controlState != STATE_COMPLETED) {
      sendAck(seq, command, RESULT_REJECT_BAD_STATE, 0, planId, cmdCrc, true);
      logControlEvent("LOAD_PLAN", true, seq, command, RESULT_REJECT_BAD_STATE, planId, activePlanCrc(), sourceId,
                      receivedPlan.depthTriggerCm, "bad_state");
      return;
    }
    if (safetyKey != SAFETY_KEY) {
      sendAck(seq, command, RESULT_REJECT_BAD_SAFETY_KEY, 0, planId, cmdCrc, true);
      logControlEvent("LOAD_PLAN", true, seq, command, RESULT_REJECT_BAD_SAFETY_KEY, planId, activePlanCrc(), sourceId,
                      receivedPlan.depthTriggerCm, "bad_safety_key");
      return;
    }
    uint8_t validation = validatePlan(receivedPlan);
    if (validation != RESULT_OK) {
      uint16_t detail = (validation == RESULT_REJECT_SENSOR_REQUIRED) ? 0x0001 : 0;
      sendAck(seq, command, validation, detail, planId, cmdCrc, true);
      logControlEvent("LOAD_PLAN", true, seq, command, validation, planId, activePlanCrc(), sourceId,
                      receivedPlan.depthTriggerCm, "validation_failed");
      return;
    }
    loadedPlan = receivedPlan;
    loadedPlanValid = true;
    loadedPlanCrc = crc16CcittFalse(cmdRaw + 7, 28);
    loadedAtMs = currentMillis;
    controlState = STATE_PLAN_LOADED;
    phase = PHASE_IDLE;
    phaseStartedMs = currentMillis;
    applyValves(false, false, "LOAD_PLAN");
    sendAck(seq, command, RESULT_OK, loadedPlanCrc, planId, cmdCrc, true);
    logControlEvent("LOAD_PLAN", true, seq, command, RESULT_OK, planId, loadedPlanCrc, sourceId,
                    loadedPlan.depthTriggerCm, "loaded");
    return;
  }

  if (command == CMD_START_PLAN) {
    if (safetyKey != SAFETY_KEY) {
      sendAck(seq, command, RESULT_REJECT_BAD_SAFETY_KEY, 0, planId, cmdCrc, true);
      logControlEvent("START_PLAN", true, seq, command, RESULT_REJECT_BAD_SAFETY_KEY, planId, activePlanCrc(), sourceId,
                      receivedPlan.depthTriggerCm, "bad_safety_key");
      return;
    }
    if (!loadedPlanValid || controlState != STATE_PLAN_LOADED) {
      sendAck(seq, command, RESULT_REJECT_PLAN_NOT_LOADED, 0, planId, cmdCrc, true);
      logControlEvent("START_PLAN", true, seq, command, RESULT_REJECT_PLAN_NOT_LOADED, planId, activePlanCrc(), sourceId,
                      receivedPlan.depthTriggerCm, "plan_not_loaded");
      return;
    }
    if (currentMillis - loadedAtMs > PLAN_LOADED_TIMEOUT_MS) {
      loadedPlanValid = false;
      controlState = STATE_SAFE_IDLE;
      phase = PHASE_IDLE;
      phaseStartedMs = currentMillis;
      errorFlags |= ERR_PLAN_EXPIRED;
      sendAck(seq, command, RESULT_REJECT_PLAN_EXPIRED, 0, planId, cmdCrc, true);
      logControlEvent("START_PLAN", true, seq, command, RESULT_REJECT_PLAN_EXPIRED, planId, loadedPlanCrc, sourceId,
                      receivedPlan.depthTriggerCm, "plan_expired");
      return;
    }
    if (memcmp(cmdRaw + 7, loadedPlan.raw, 28) != 0) {
      sendAck(seq, command, RESULT_REJECT_PLAN_MISMATCH, loadedPlanCrc, planId, cmdCrc, true);
      logControlEvent("START_PLAN", true, seq, command, RESULT_REJECT_PLAN_MISMATCH, planId, loadedPlanCrc, sourceId,
                      receivedPlan.depthTriggerCm, "plan_mismatch");
      return;
    }
    uint8_t validation = validatePlan(receivedPlan);
    if (validation != RESULT_OK) {
      uint16_t detail = (validation == RESULT_REJECT_SENSOR_REQUIRED) ? 0x0001 : 0;
      sendAck(seq, command, validation, detail, planId, cmdCrc, true);
      logControlEvent("START_PLAN", true, seq, command, validation, planId, loadedPlanCrc, sourceId,
                      receivedPlan.depthTriggerCm, "validation_failed");
      return;
    }
    startRunningPlan();
    sendAck(seq, command, RESULT_OK, loadedPlanCrc, planId, cmdCrc, true);
    logControlEvent("START_PLAN", true, seq, command, RESULT_OK, planId, loadedPlanCrc, sourceId,
                    runningPlan.depthTriggerCm, "started");
    return;
  }

  sendAck(seq, command, RESULT_REJECT_UNKNOWN_COMMAND, 0, planId, cmdCrc, true);
  logControlEvent("CMD_REJECT", true, seq, command, RESULT_REJECT_UNKNOWN_COMMAND, planId, activePlanCrc(), sourceId, 0, "unknown_command");
}

void handleTritonRaw(const uint8_t* raw, size_t len, uint8_t sourceId) {
  currentMillis = millis();
  if (len != T3_RAW_CMD_LEN) {
    return;
  }
  if (raw[0] != T3_HEADER || raw[39] != T3_FOOTER) {
    return;
  }
  if (raw[1] != T3_PROTOCOL_VER || raw[2] != T3_PACKET_CMD) {
    return;
  }
  if (raw[5] != DEVICE_ID) {
    return;
  }

  uint16_t seq = getU16BE(raw + 3);
  uint8_t command = raw[6];
  uint16_t planId = getU16BE(raw + 9);
  uint16_t receivedCrc = getU16BE(raw + 37);
  uint16_t actualCrc = crc16CcittFalse(raw, 37);
  if (receivedCrc != actualCrc) {
    sendAck(seq, command, RESULT_REJECT_BAD_CRC, 0, planId, receivedCrc, false);
    logControlEvent("CMD_REJECT", true, seq, command, RESULT_REJECT_BAD_CRC, planId, activePlanCrc(), sourceId, 0, "bad_crc");
    return;
  }

  handleValidCmd(raw, sourceId);
}

void handleAppLine(const char* line, size_t lineLen) {
  uint8_t raw[T3_RAW_BUF_LEN];
  size_t rawLen = 0;
  if (!decodeAppUart(line, lineLen, raw, rawLen)) {
    return;
  }
  if (rawLen < 3) {
    return;
  }

  uint8_t sourceId = raw[0];
  uint8_t appCmd = raw[1];
  const uint8_t* payload = raw + 2;
  size_t payloadLen = rawLen - 3;

  if (appCmd == APP_UART_EXTENDED_CMD) {
    if (payloadLen < 12) {
      return;
    }
    uint16_t dataLen = (static_cast<uint16_t>(payload[10]) << 8) | payload[11];
    if (payloadLen < static_cast<size_t>(12 + dataLen)) {
      return;
    }
    appCmd = payload[0];
    payload = payload + 12;
    payloadLen = dataLen;
  }

  if (appCmd != T3_APP_UART_CMD) {
    return;
  }
  handleTritonRaw(payload, payloadLen, sourceId);
}

void pollTwelite() {
  while (Serial1.available() > 0) {
    char c = static_cast<char>(Serial1.read());
    if (c == '\r') continue;
    if (c == '\n') {
      if (!appLineOverflow) {
        appLine[appLineLen] = '\0';
        handleAppLine(appLine, appLineLen);
      }
      appLineLen = 0;
      appLineOverflow = false;
    } else if (appLineOverflow) {
      continue;
    } else if (appLineLen < APP_UART_LINE_BUF_LEN) {
      appLine[appLineLen++] = c;
    } else {
      appLineOverflow = true;
    }
  }
}

void readUsbSerial() {
  while (Serial.available() > 0) {
    char c = static_cast<char>(Serial.read());
    if (c == 's' || c == 'S') {
      Serial.print(F("state="));
      Serial.print(stateToString(controlState));
      Serial.print(F(" phase="));
      Serial.print(phaseToString(phase));
      Serial.print(F(" plan="));
      Serial.print(activePlanId());
      Serial.print(F(" valves=0x"));
      Serial.print(valveBits(), HEX);
      Serial.print(F(" errors=0x"));
      Serial.println(errorFlags, HEX);
    } else if (c == 'x' || c == 'X') {
      uint16_t stoppedPlanId = activePlanId();
      uint16_t stoppedPlanCrc = activePlanCrc();
      stopSafe("USB_STOP_SAFE");
      logControlEvent("USB_STOP_SAFE", false, 0, CMD_NONE, RESULT_OK_STOPPED, stoppedPlanId, stoppedPlanCrc, 0, 0, "local_stop");
      Serial.println(F("STOP_SAFE local"));
    } else if (c == 'E') {
      enterErrorLockout(ERR_VALVE_CONFLICT, "usb_forced_lockout");
      Serial.println(F("debug forced ERROR_LOCKOUT"));
    } else if (c == 'C') {
      applyValves(false, false, "USB_CLEAR");
      controlState = STATE_SAFE_IDLE;
      phase = PHASE_IDLE;
      phaseStartedMs = millis();
      loadedPlanValid = false;
      errorFlags = 0;
      cycleCount = 0;
      logControlEvent("USB_CLEAR", false, 0, CMD_NONE, RESULT_OK, 0, 0, 0, 0, "maintenance_clear");
      Serial.println(F("debug clear error via USB"));
    }
  }
}

// ============================================================
// Logging

void logData() {
  uint32_t seq = logSeq++;
  File f;
  bool fileOpen = false;
  if (sdReady) {
    f = SD.open(DATA_LOG_FILENAME, FILE_WRITE);
    if (f) {
      sdWriteOk = true;
      errorFlags &= ~ERR_SD_WRITE;
      fileOpen = true;
    } else {
      errorFlags |= ERR_SD_WRITE;
      sdWriteOk = false;
      setLEDStatus(false);
    }
  }

  printDataRecord(Serial, seq);
  Serial.println();
  serviceWatchdog();

  if (!fileOpen) return;
  printDataRecord(f, seq);
  f.println();
  f.close();
  sdWriteOk = true;
  errorFlags &= ~ERR_SD_WRITE;
  setLEDStatus(true);
}

void logControlEvent(const char* eventName,
                     bool hasWireless,
                     uint16_t wirelessSeq,
                     uint8_t command,
                     uint8_t result,
                     uint16_t planId,
                     uint16_t planCrc,
                     uint8_t sourceId,
                     uint16_t thresholdCm,
                     const char* message) {
  currentMillis = millis();

  if (eventQueueCount >= EVENT_QUEUE_SIZE) {
    eventQueueTail = static_cast<uint8_t>((eventQueueTail + 1) % EVENT_QUEUE_SIZE);
    eventQueueCount--;
    eventDropCount++;
  }

  ControlEventRecord& record = eventQueue[eventQueueHead];
  record.seq = logSeq++;
  record.millisStamp = currentMillis;
  record.rtc = rtcData;
  record.eventName = eventName;
  record.state = controlState;
  record.phase = phase;
  record.hasWireless = hasWireless;
  record.wirelessSeq = wirelessSeq;
  record.command = command;
  record.result = result;
  record.planId = planId;
  record.planCrc = planCrc;
  record.sourceId = sourceId;
  record.depthM = sensorData.depthM;
  record.depthValid = depthSensorOk();
  record.thresholdCm = thresholdCm;
  record.waterTemperature = sensorData.waterTemperature;
  record.tempValid = sensorData.tempValid;
  record.injectionValve = valveStatus.injectionValve;
  record.exhaustValve = valveStatus.exhaustValve;
  record.message = message;

  eventQueueHead = static_cast<uint8_t>((eventQueueHead + 1) % EVENT_QUEUE_SIZE);
  eventQueueCount++;
}

void flushControlEventLogs(uint8_t maxRecords) {
  uint8_t flushed = 0;
  while (eventQueueCount > 0 && flushed < maxRecords) {
    if (!heavyIoAllowedNow()) return;

    ControlEventRecord record = eventQueue[eventQueueTail];
    eventQueueTail = static_cast<uint8_t>((eventQueueTail + 1) % EVENT_QUEUE_SIZE);
    eventQueueCount--;
    flushed++;

    File f;
    bool fileOpen = false;
    if (sdReady) {
      f = SD.open(EVENT_LOG_FILENAME, FILE_WRITE);
      if (f) {
        sdWriteOk = true;
        errorFlags &= ~ERR_SD_WRITE;
        fileOpen = true;
      } else {
        errorFlags |= ERR_SD_WRITE;
        sdWriteOk = false;
        setLEDStatus(false);
      }
    }

    printEventRecord(Serial, record);
    Serial.println();
    serviceWatchdog();

    if (!fileOpen) continue;
    printEventRecord(f, record);
    f.println();
    f.close();
    sdWriteOk = true;
    errorFlags &= ~ERR_SD_WRITE;
    setLEDStatus(true);
    serviceWatchdog();
  }
}

void printDataHeader(Print& out) {
  out.print(F("v,seq,ms,date,time,type,state,phase,plan,cycle,elapsed,remain,water_c,press_mbar,depth_m,max_m,press_c,lat,lng,alt,sat,gps,vinj,vexh,sd,last_seq,last_result,pc_age,err,msg"));
}

void printEventHeader(Print& out) {
  out.print(F("v,seq,ms,date,time,event,state,phase,wireless_seq,cmd,result,plan,crc,src,depth_m,threshold_m,water_c,vinj,vexh,msg"));
}

void printDataRecord(Print& out, uint32_t seq) {
  out.print(LOG_VERSION); out.print(',');
  out.print(seq); out.print(',');
  out.print(currentMillis); out.print(',');
  printDate(out); out.print(',');
  printTime(out); out.print(',');
  out.print(F("DATA,"));
  out.print(controlState); out.print(',');
  out.print(phase); out.print(',');
  out.print(activePlanId()); out.print(',');
  out.print(cycleCount); out.print(',');
  out.print(phaseElapsedMs() / 1000UL); out.print(',');
  out.print(phaseRemainingMs() / 1000UL); out.print(',');
  printFloatIfValidOrNA(out, sensorData.tempValid, sensorData.waterTemperature, 2); out.print(',');
  printFloatIfValidOrNA(out, depthSensorOk(), sensorData.pressureMbar, 2); out.print(',');
  printFloatIfValidOrNA(out, depthSensorOk(), sensorData.depthM, 2); out.print(',');
  out.print(static_cast<float>(observedMaxDepthCm) / 100.0f, 2); out.print(',');
  printFloatIfValidOrNA(out, depthSensorOk(), sensorData.pressureTempC, 2); out.print(',');
  if (gpsData.locationValid) printDoubleOrNA(out, gpsData.latitude, 6); else out.print(F("NA"));
  out.print(',');
  if (gpsData.locationValid) printDoubleOrNA(out, gpsData.longitude, 6); else out.print(F("NA"));
  out.print(',');
  if (gpsData.altitudeValid) printDoubleOrNA(out, gpsData.altitudeM, 1); else out.print(F("NA"));
  out.print(',');
  out.print(gpsData.satellites); out.print(',');
  out.print(gpsData.locationValid ? 1 : 0); out.print(',');
  out.print(valveStatus.injectionValve ? 1 : 0); out.print(',');
  out.print(valveStatus.exhaustValve ? 1 : 0); out.print(',');
  out.print(sdStatusOk() ? 1 : 0); out.print(',');
  out.print(lastCmdSeq); out.print(',');
  out.print(lastCmdResult); out.print(',');
  uint32_t ageS = !pcSeen ? 255UL : (currentMillis - lastPcSeenMs) / 1000UL;
  out.print(ageS > 255 ? 255 : ageS); out.print(',');
  out.print(errorFlags); out.print(',');
  out.print(F("periodic"));
}

void printEventRecord(Print& out, const ControlEventRecord& record) {
  out.print(LOG_VERSION); out.print(',');
  out.print(record.seq); out.print(',');
  out.print(record.millisStamp); out.print(',');
  printDateValue(out, record.rtc); out.print(',');
  printTimeValue(out, record.rtc); out.print(',');
  out.print(record.eventName); out.print(',');
  out.print(record.state); out.print(',');
  out.print(record.phase); out.print(',');
  printWirelessSeqOrNA(out, record.hasWireless, record.wirelessSeq); out.print(',');
  if (record.command == CMD_NONE) out.print(F("NA")); else out.print(record.command);
  out.print(',');
  if (record.command == CMD_NONE) out.print(F("NA")); else out.print(record.result);
  out.print(',');
  if (record.planId == 0) out.print(F("NA")); else out.print(record.planId);
  out.print(',');
  printU16HexOrNA(out, record.planCrc != 0, record.planCrc); out.print(',');
  printSourceOrNA(out, record.hasWireless, record.sourceId); out.print(',');
  printFloatIfValidOrNA(out, record.depthValid, record.depthM, 2); out.print(',');
  if (record.thresholdCm == 0) out.print(F("NA")); else out.print(static_cast<float>(record.thresholdCm) / 100.0f, 2);
  out.print(',');
  printFloatIfValidOrNA(out, record.tempValid, record.waterTemperature, 2); out.print(',');
  out.print(record.injectionValve ? 1 : 0); out.print(',');
  out.print(record.exhaustValve ? 1 : 0); out.print(',');
  out.print(record.message);
}

void printDate(Print& out) {
  printDateValue(out, rtcData);
}

void printTime(Print& out) {
  printTimeValue(out, rtcData);
}

void printDateValue(Print& out, const RTCData& value) {
  char buf[12];
  snprintf(buf, sizeof(buf), "%04d-%02d-%02d", value.year, value.month, value.day);
  out.print(buf);
}

void printTimeValue(Print& out, const RTCData& value) {
  char buf[10];
  snprintf(buf, sizeof(buf), "%02d:%02d:%02d", value.hour, value.minute, value.second);
  out.print(buf);
}

void printFloatOrNA(Print& out, float value, uint8_t digits) {
  if (isnan(value)) {
    out.print(F("NA"));
  } else {
    out.print(value, digits);
  }
}

void printFloatIfValidOrNA(Print& out, bool valid, float value, uint8_t digits) {
  if (!valid) {
    out.print(F("NA"));
    return;
  }
  printFloatOrNA(out, value, digits);
}

void printDoubleOrNA(Print& out, double value, uint8_t digits) {
  if (isnan(value)) {
    out.print(F("NA"));
  } else {
    out.print(value, digits);
  }
}

void printU16HexOrNA(Print& out, bool valid, uint16_t value) {
  if (!valid) {
    out.print(F("NA"));
    return;
  }
  char buf[7];
  snprintf(buf, sizeof(buf), "0x%04X", value);
  out.print(buf);
}

void printSourceOrNA(Print& out, bool valid, uint8_t sourceId) {
  if (!valid) {
    out.print(F("NA"));
    return;
  }
  char buf[5];
  snprintf(buf, sizeof(buf), "0x%02X", sourceId);
  out.print(buf);
}

void printWirelessSeqOrNA(Print& out, bool valid, uint16_t seq) {
  if (!valid) {
    out.print(F("NA"));
    return;
  }
  out.print(seq);
}

bool sdStatusOk() {
  return sdReady && sdWriteOk;
}

// ============================================================
// Display and utility

#if TRITON_ENABLE_LCD
void updateDisplay() {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(stateToString(controlState));
  lcd.print(' ');
  lcd.print(phaseToString(phase));

  uint32_t remainSec = phaseRemainingMs() / 1000UL;
  if (remainSec > 0) {
    lcd.print(' ');
    lcd.print(remainSec);
    lcd.print('s');
  }

  lcd.setCursor(0, 1);
  lcd.print(F("T:"));
  if (telemetryTempOk()) {
    lcd.print(telemetryWaterTemperatureC(), 1);
  } else {
    lcd.print(F("NA"));
  }
  lcd.print(F(" D:"));
  if (depthSensorOk()) {
    lcd.print(sensorData.depthM, 1);
  } else {
    lcd.print(F("NA"));
  }
}
#endif

void setLEDStatus(bool success) {
  bool healthy = success && ((errorFlags & ERR_HEALTH_MASK) == 0);
  digitalWrite(Pins::LED_GREEN, healthy ? HIGH : LOW);
  digitalWrite(Pins::LED_RED, healthy ? LOW : HIGH);
}

const char* stateToString(uint8_t state) {
  switch (state) {
    case STATE_SAFE_IDLE: return "SAFE";
    case STATE_PLAN_LOADED: return "LOADED";
    case STATE_RUNNING: return "RUN";
    case STATE_COMPLETED: return "DONE";
    case STATE_ERROR_LOCKOUT: return "LOCK";
    default: return "?";
  }
}

const char* phaseToString(uint8_t phaseValue) {
  switch (phaseValue) {
    case PHASE_IDLE: return "IDLE";
    case PHASE_PREPARE: return "PREP";
    case PHASE_EXHAUST_OPEN: return "EXH";
    case PHASE_DESCENT_COAST: return "DESC";
    case PHASE_BOTTOM_WAIT: return "WAIT";
    case PHASE_INJECTION_OPEN: return "INJ";
    case PHASE_ASCENT_WAIT: return "ASC";
    case PHASE_COMPLETE: return "DONE";
    case PHASE_ERROR: return "ERR";
    default: return "?";
  }
}

bool isLeapYear(int year) {
  return (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
}
