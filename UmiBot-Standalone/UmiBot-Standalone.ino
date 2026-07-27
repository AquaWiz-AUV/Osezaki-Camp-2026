/**
 * @file UmiBot-Old.ino
 * @brief Autonomous old UmiBot firmware with Triton v3 CSV logs.
 *
 * This sketch is based on the old UmiBot/Triton-LiteRev2 hardware layout.
 * Infrared mode switching, EEPROM serial configuration, and wireless command
 * handling are intentionally removed. The mission starts automatically on boot
 * and uses the fixed timings requested from the Triton UI screenshot:
 *
 *   PREP 5 s -> EXH 60 s -> DESC 15 s -> WAIT 120 s -> INJ 20 s -> ASC 120 s
 *
 * Sensor faults are logged as Triton-compatible error bits but do not stop the
 * phase timer or valve sequence. Water temperature is sourced only from the
 * MS5837 depth sensor; no OneWire/Dallas temperature sensor is used.
 */

#include <Arduino.h>
#include <SoftwareSerial.h>
#include <SPI.h>
#include <Wire.h>
#include <SD.h>
#include <TinyGPS++.h>
#include <MS5837.h>
#include <RTC_RX8025NB.h>
#include <TimeLib.h>
#include <math.h>
#include <string.h>

#ifndef UMIBOT_OLD_ENABLE_LCD
#define UMIBOT_OLD_ENABLE_LCD 1
#endif

#if UMIBOT_OLD_ENABLE_LCD
#include <LiquidCrystal_I2C.h>
#endif

// ============================================================
// Old UmiBot hardware pins

namespace Pins {
const uint8_t SD_CHIP_SELECT = 10;
const uint8_t LED_GREEN = 9;
const uint8_t LED_RED = 8;
const uint8_t VALVE_INJECTION = 7; // old V1 supply
const uint8_t VALVE_EXHAUST = 6;   // old V2 exhaust
const uint8_t GPS_RX = 3;          // matches old SoftwareSerial(3, 2)
const uint8_t GPS_TX = 2;
}

namespace Timing {
/*
 * フェーズ時間の意味（単位はすべて秒）
 *
 * このプログラムは、通常は次の 6 フェーズを上から順番に実行します。
 * センサーデータの取得と保存はフェーズとは独立して続きます。
 * SENSOR_UPDATE_MS（デフォルト 500 ms）ごとにセンサーを更新し、
 * その直後に同じタイミングで最新値を 1 行記録します。
 * そのため、弁を開いている間も 0.5 秒ごとに記録を続けます。
 *
 * PREPARE_S（準備時間）
 *   1 サイクルの開始直後に、注入弁と排気弁を両方閉じたまま待つ時間です。
 *   この時間が終わると、排気弁を開くフェーズへ進みます。
 *
 * EXHAUST_OPEN_S（排気弁を開く時間）
 *   注入弁を閉じ、排気弁だけを開いて、機体を潜降させるために
 *   内部の空気を排出する時間です。終了時に排気弁を閉じます。
 *
 * DESCENT_COAST_S（潜降待ち時間）
 *   排気後に両方の弁を閉じ、機体がそのまま潜降するのを待つ時間です。
 *   この時間が終わると、下降後の待機フェーズへ進みます。
 *
 * BOTTOM_WAIT_S（下降後の待機時間）
 *   DESCENT_COAST_S の終了後、両方の弁を閉じたまま、注入開始まで
 *   待つ時間です。着底を検知してから数え始める時間ではありません。
 *   この固定時間が終わると、浮上のために注入弁を開きます。
 *
 * INJECTION_OPEN_S（注入弁を開く時間）
 *   排気弁を閉じ、注入弁だけを開いて、機体を浮上させるための
 *   気体を注入する時間です。終了時に注入弁を閉じます。
 *
 * ASCENT_WAIT_S（浮上待ち時間）
 *   注入後に両方の弁を閉じ、機体が浮上するのを待つ時間です。
 *   この時間が終わると 1 サイクル完了となり、次の準備時間へ戻ります。
 */
const uint16_t PREPARE_S = 5;         // デフォルト: 5 秒
const uint16_t EXHAUST_OPEN_S = 60;   // デフォルト: 60 秒
const uint16_t DESCENT_COAST_S = 15;  // デフォルト: 15 秒
const uint16_t BOTTOM_WAIT_S = 120;   // デフォルト: 120 秒
const uint16_t INJECTION_OPEN_S = 20; // デフォルト: 20 秒
const uint16_t ASCENT_WAIT_S = 120;   // デフォルト: 120 秒

const uint16_t STATUS_INTERVAL_100MS = 10;
const unsigned long SENSOR_UPDATE_MS = 500UL; // センサー更新・データ記録: 0.5 秒
const unsigned long LCD_UPDATE_MS = STATUS_INTERVAL_100MS * 100UL;
const unsigned long I2C_TIMEOUT_US = 25000UL;
}

// ============================================================
// Triton v3-compatible constants

constexpr const char* LOG_VERSION = "3.6";
constexpr const char* DATA_LOG_FILENAME = "DATA.CSV";
constexpr const char* EVENT_LOG_FILENAME = "EVENT.CSV";

constexpr uint16_t PLAN_ID = 1;
constexpr uint16_t PLAN_REPEAT_COUNT = 0xFFFF; // デフォルト: 無制限に繰り返す

// 深度トリガーの単位は cm です。0 のときは無効で、通常の時間どおりに進みます。
// 例: 1000 にすると、潜降中に深度 10 m へ達した時点で、残りの潜降・待機時間を
// 待たずに INJECTION_OPEN フェーズへ進み、浮上動作を開始します。
constexpr uint16_t PLAN_DEPTH_TRIGGER_CM = 0;

constexpr uint8_t STATE_SAFE_IDLE = 0x00;
constexpr uint8_t STATE_RUNNING = 0x02;
constexpr uint8_t STATE_COMPLETED = 0x03;

constexpr uint8_t PHASE_IDLE = 0x00;
constexpr uint8_t PHASE_PREPARE = 0x01;
constexpr uint8_t PHASE_EXHAUST_OPEN = 0x02;
constexpr uint8_t PHASE_DESCENT_COAST = 0x03;
constexpr uint8_t PHASE_BOTTOM_WAIT = 0x04;
constexpr uint8_t PHASE_INJECTION_OPEN = 0x05;
constexpr uint8_t PHASE_ASCENT_WAIT = 0x06;
constexpr uint8_t PHASE_COMPLETE = 0x07;

constexpr uint16_t ERR_SD_WRITE = 0x0002;
constexpr uint16_t ERR_TEMP_SENSOR = 0x0004;
constexpr uint16_t ERR_DEPTH_SENSOR = 0x0008;
constexpr uint16_t ERR_SENSOR_STALE = 0x0400;

constexpr uint32_t USB_BAUD = 115200;
constexpr uint32_t GPS_BAUD = 9600;
constexpr float FLUID_DENSITY = 997.0f;

// ============================================================
// Runtime data

struct RTCData {
  uint16_t year = 2026;
  uint8_t month = 6;
  uint8_t day = 20;
  uint8_t hour = 0;
  uint8_t minute = 0;
  uint8_t second = 0;
};

struct SensorData {
  bool waterTempValid = false;
  bool depthValid = false;
  float waterTemperature = NAN;
  float pressureMbar = NAN;
  float depthM = NAN;
  float maxDepthM = 0.0f;
  float pressureTempC = NAN;
};

struct GPSData {
  bool locationValid = false;
  bool altitudeValid = false;
  bool timeValid = false;
  double latitude = NAN;
  double longitude = NAN;
  double altitudeM = NAN;
  uint8_t satellites = 0;
};

struct ValveStatus {
  bool injectionValve = false;
  bool exhaustValve = false;
};

SoftwareSerial gpsSerial(Pins::GPS_RX, Pins::GPS_TX);
TinyGPSPlus gps;
MS5837 depthSensor;
RTC_RX8025NB rtc;

#if UMIBOT_OLD_ENABLE_LCD
LiquidCrystal_I2C lcd(0x27, 16, 2);
#endif

RTCData rtcData;
SensorData sensorData;
GPSData gpsData;
ValveStatus valveStatus;

bool sdReady = false;
bool depthReady = false;
bool rtcSyncedFromGPS = false;

uint8_t controlState = STATE_SAFE_IDLE;
uint8_t phase = PHASE_IDLE;
uint16_t errorFlags = 0;
uint16_t cycleCount = 0;
uint32_t sequenceNumber = 0;
bool cycleDepthTriggered = false;

unsigned long currentMillis = 0;
unsigned long phaseStartedMs = 0;
unsigned long lastSensorMs = 0;
unsigned long lastLcdMs = 0;

// ============================================================
// Forward declarations

void configureI2CBus();
bool wireTimeoutFlagged();
void clearWireTimeoutFlagIfAvailable();
void initializePins();
void initializeLCD();
void initializeRTC();
void initializeSD();
void initializeSensors();
void ensureLogHeaders();
void updateRTCData();
void serviceGPS();
void updateGPSData();
void syncRTCFromGPSIfReady();
void updateSensors();
void updateDepthSensor();
void startPlan();
void updateRunningState();
uint16_t phaseDurationS();
uint8_t nextPhaseAfter(uint8_t currentPhase);
uint32_t phaseElapsedMs();
uint32_t phaseRemainingMs();
void enterPhase(uint8_t nextPhase);
void completePlan(const char* cause);
void applyValves(bool injectionOn, bool exhaustOn);
void logData();
void logEvent(const char* eventName, uint16_t planId, uint16_t thresholdCm, const char* message);
void printDataHeader(Print& out);
void printEventHeader(Print& out);
void printDataRecord(Print& out, uint32_t seq);
void printEventRecord(Print& out, uint32_t seq, const char* eventName, uint16_t planId, uint16_t thresholdCm, const char* message);
void printDate(Print& out);
void printTime(Print& out);
void printDateValue(Print& out, const RTCData& value);
void printTimeValue(Print& out, const RTCData& value);
void printFloatIfValidOrNA(Print& out, bool valid, float value, uint8_t digits);
void printDoubleIfValidOrNA(Print& out, bool valid, double value, uint8_t digits);
const char* phaseToString(uint8_t value);
const char* stateToString(uint8_t value);
void updateLEDs();
void updateDisplay();

// ============================================================
// setup / loop

void setup() {
  currentMillis = millis();

  initializePins();
  Serial.begin(USB_BAUD);
  Wire.begin();
  configureI2CBus();
  gpsSerial.begin(GPS_BAUD);
  gpsSerial.listen();

  initializeLCD();
  initializeRTC();
  updateRTCData();
  initializeSD();
  ensureLogHeaders();
  initializeSensors();
  updateSensors();

  logEvent("BOOT", 0, 0, "system_start_autonomous_old");
  startPlan();
  updateDisplay();
}

void loop() {
  currentMillis = millis();

  serviceGPS();
  syncRTCFromGPSIfReady();

  if (currentMillis - lastSensorMs >= Timing::SENSOR_UPDATE_MS) {
    lastSensorMs = currentMillis;
    updateRTCData();
    updateSensors();
    // 今更新したセンサー値を、同じタイミングでそのまま記録する。
    logData();
  }

  updateRunningState();

  if (currentMillis - lastLcdMs >= Timing::LCD_UPDATE_MS) {
    lastLcdMs = currentMillis;
    updateDisplay();
  }

  updateLEDs();
}

// ============================================================
// Initialization

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

void initializePins() {
  pinMode(Pins::LED_GREEN, OUTPUT);
  pinMode(Pins::LED_RED, OUTPUT);
  pinMode(Pins::VALVE_INJECTION, OUTPUT);
  pinMode(Pins::VALVE_EXHAUST, OUTPUT);
  pinMode(Pins::SD_CHIP_SELECT, OUTPUT);
  pinMode(SS, OUTPUT);

  digitalWrite(Pins::VALVE_INJECTION, LOW);
  digitalWrite(Pins::VALVE_EXHAUST, LOW);
  digitalWrite(Pins::LED_GREEN, LOW);
  digitalWrite(Pins::LED_RED, HIGH);
}

void initializeLCD() {
#if UMIBOT_OLD_ENABLE_LCD
  lcd.init();
  lcd.backlight();
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(F("UmiBot Old"));
  lcd.setCursor(0, 1);
  lcd.print(F("Auto start"));
#endif
}

void initializeRTC() {
  updateRTCData();
  bool valid = rtcData.year >= 2024 && rtcData.year <= 2099 &&
               rtcData.month >= 1 && rtcData.month <= 12 &&
               rtcData.day >= 1 && rtcData.day <= 31 &&
               rtcData.hour <= 23 && rtcData.minute <= 59 && rtcData.second <= 59;
  if (!valid) {
    rtc.setDateTime(2026, 6, 20, 0, 0, 0);
    updateRTCData();
  }
}

void initializeSD() {
  sdReady = SD.begin(Pins::SD_CHIP_SELECT);
  if (!sdReady) {
    errorFlags |= ERR_SD_WRITE;
    Serial.println(F("SD init failed"));
  } else {
    errorFlags &= static_cast<uint16_t>(~ERR_SD_WRITE);
    Serial.println(F("SD init OK"));
  }
}

void initializeSensors() {
  errorFlags &= static_cast<uint16_t>(~ERR_TEMP_SENSOR);
  clearWireTimeoutFlagIfAvailable();
  depthReady = depthSensor.init() && !wireTimeoutFlagged();
  clearWireTimeoutFlagIfAvailable();
  if (depthReady) {
    depthSensor.setModel(MS5837::MS5837_30BA);
    depthSensor.setFluidDensity(FLUID_DENSITY);
    errorFlags &= static_cast<uint16_t>(~ERR_DEPTH_SENSOR);
  } else {
    errorFlags |= ERR_DEPTH_SENSOR;
  }
}

void ensureLogHeaders() {
  if (!sdReady) return;

  bool dataNeedsHeader = !SD.exists(DATA_LOG_FILENAME);
  File dataFile = SD.open(DATA_LOG_FILENAME, FILE_WRITE);
  if (dataFile) {
    if (dataNeedsHeader || dataFile.size() == 0) {
      printDataHeader(dataFile);
      dataFile.println();
    }
    dataFile.close();
  } else {
    errorFlags |= ERR_SD_WRITE;
  }

  bool eventNeedsHeader = !SD.exists(EVENT_LOG_FILENAME);
  File eventFile = SD.open(EVENT_LOG_FILENAME, FILE_WRITE);
  if (eventFile) {
    if (eventNeedsHeader || eventFile.size() == 0) {
      printEventHeader(eventFile);
      eventFile.println();
    }
    eventFile.close();
  } else {
    errorFlags |= ERR_SD_WRITE;
  }
}

// ============================================================
// Sensor/GPS/RTC updates

void updateRTCData() {
  tmElements_t tm = rtc.read();
  rtcData.year = tmYearToCalendar(tm.Year);
  rtcData.month = tm.Month;
  rtcData.day = tm.Day;
  rtcData.hour = tm.Hour;
  rtcData.minute = tm.Minute;
  rtcData.second = tm.Second;
}

void serviceGPS() {
  while (gpsSerial.available() > 0) {
    char c = static_cast<char>(gpsSerial.read());
    if (gps.encode(c)) {
      updateGPSData();
    }
  }
  updateGPSData();
}

void updateGPSData() {
  if (gps.location.isValid()) {
    gpsData.locationValid = true;
    gpsData.latitude = gps.location.lat();
    gpsData.longitude = gps.location.lng();
  }
  if (gps.altitude.isValid()) {
    gpsData.altitudeValid = true;
    gpsData.altitudeM = gps.altitude.meters();
  }
  if (gps.satellites.isValid()) {
    gpsData.satellites = gps.satellites.value();
  }
  gpsData.timeValid = gps.time.isValid() && gps.date.isValid();
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
      minute < 0 || minute > 59 || second < 0 || second > 59) {
    return;
  }

  if (hour >= 24) {
    hour -= 24;
    day++;
  }

  const int daysInMonthNormal[12] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  int maxDay = daysInMonthNormal[month - 1];
  bool leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
  if (month == 2 && leap) maxDay = 29;
  if (day > maxDay) {
    day = 1;
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }

  rtc.setDateTime(year, month, day, hour, minute, second);
  rtcSyncedFromGPS = true;
  updateRTCData();
  logEvent("RTC_SYNC_GPS", PLAN_ID, 0, "rtc_synced_jst");
}

void updateSensors() {
  updateDepthSensor();
}

void updateDepthSensor() {
  if (!depthReady) {
    sensorData.depthValid = false;
    sensorData.waterTempValid = false;
    errorFlags |= ERR_DEPTH_SENSOR;
    errorFlags &= static_cast<uint16_t>(~ERR_TEMP_SENSOR);
    return;
  }

  clearWireTimeoutFlagIfAvailable();
  depthSensor.read();
  if (wireTimeoutFlagged()) {
    sensorData.depthValid = false;
    sensorData.waterTempValid = false;
    errorFlags |= ERR_DEPTH_SENSOR | ERR_SENSOR_STALE;
    errorFlags &= static_cast<uint16_t>(~ERR_TEMP_SENSOR);
    clearWireTimeoutFlagIfAvailable();
    return;
  }

  float pressureMbar = depthSensor.pressure();
  float depthM = depthSensor.depth();
  float pressureTempC = depthSensor.temperature();
  bool valid = !isnan(pressureMbar) && !isnan(depthM) && !isnan(pressureTempC) &&
               pressureMbar >= 0.0f && pressureMbar <= 65534.0f &&
               depthM >= -5.0f && depthM <= 300.0f &&
               pressureTempC >= -10.0f && pressureTempC <= 80.0f;

  if (!valid) {
    sensorData.depthValid = false;
    sensorData.waterTempValid = false;
    errorFlags |= ERR_DEPTH_SENSOR;
    errorFlags &= static_cast<uint16_t>(~ERR_TEMP_SENSOR);
    return;
  }

  sensorData.pressureMbar = pressureMbar;
  sensorData.depthM = depthM;
  sensorData.pressureTempC = pressureTempC;
  sensorData.waterTemperature = pressureTempC;
  sensorData.depthValid = true;
  sensorData.waterTempValid = true;
  if (depthM > sensorData.maxDepthM) {
    sensorData.maxDepthM = depthM;
  }
  errorFlags &= static_cast<uint16_t>(~(ERR_TEMP_SENSOR | ERR_DEPTH_SENSOR | ERR_SENSOR_STALE));
}

// ============================================================
// Mission control

void startPlan() {
  currentMillis = millis();
  controlState = STATE_RUNNING;
  cycleCount = 0;
  phaseStartedMs = currentMillis;
  cycleDepthTriggered = false;
  logEvent("START_PLAN", PLAN_ID, PLAN_DEPTH_TRIGGER_CM, "auto_start");
  enterPhase(PHASE_PREPARE);
}

void updateRunningState() {
  if (controlState != STATE_RUNNING) return;
  currentMillis = millis();

  if (PLAN_DEPTH_TRIGGER_CM > 0 &&
      !cycleDepthTriggered &&
      sensorData.depthValid &&
      (phase == PHASE_EXHAUST_OPEN ||
       phase == PHASE_DESCENT_COAST ||
       phase == PHASE_BOTTOM_WAIT) &&
      sensorData.depthM * 100.0f >= PLAN_DEPTH_TRIGGER_CM) {
    cycleDepthTriggered = true;
    enterPhase(PHASE_INJECTION_OPEN);
    logEvent("DEPTH_TRIGGER", PLAN_ID, PLAN_DEPTH_TRIGGER_CM,
             "target_depth_reached");
  }

  uint8_t guard = 0;
  while (controlState == STATE_RUNNING && guard++ < 8) {
    currentMillis = millis();
    uint32_t durationMs = static_cast<uint32_t>(phaseDurationS()) * 1000UL;
    if (durationMs > 0 && currentMillis - phaseStartedMs < durationMs) {
      break;
    }

    uint8_t next = nextPhaseAfter(phase);
    if (next == PHASE_COMPLETE) {
      cycleCount++;
      if (PLAN_REPEAT_COUNT == 0xFFFF || cycleCount < PLAN_REPEAT_COUNT) {
        enterPhase(PHASE_PREPARE);
      } else {
        completePlan("repeat_complete");
        break;
      }
    } else {
      enterPhase(next);
    }
  }
}

uint16_t phaseDurationS() {
  switch (phase) {
    case PHASE_PREPARE: return Timing::PREPARE_S;
    case PHASE_EXHAUST_OPEN: return Timing::EXHAUST_OPEN_S;
    case PHASE_DESCENT_COAST: return Timing::DESCENT_COAST_S;
    case PHASE_BOTTOM_WAIT: return Timing::BOTTOM_WAIT_S;
    case PHASE_INJECTION_OPEN: return Timing::INJECTION_OPEN_S;
    case PHASE_ASCENT_WAIT: return Timing::ASCENT_WAIT_S;
    default: return 0;
  }
}

uint8_t nextPhaseAfter(uint8_t currentPhase) {
  switch (currentPhase) {
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

void enterPhase(uint8_t nextPhase) {
  currentMillis = millis();
  phase = nextPhase;
  phaseStartedMs = currentMillis;
  if (phase == PHASE_PREPARE) cycleDepthTriggered = false;

  if (phase == PHASE_EXHAUST_OPEN) {
    applyValves(false, true);
  } else if (phase == PHASE_INJECTION_OPEN) {
    applyValves(true, false);
  } else {
    applyValves(false, false);
  }

  logEvent("PHASE_CHANGE", PLAN_ID, PLAN_DEPTH_TRIGGER_CM, phaseToString(phase));
}

void completePlan(const char* cause) {
  applyValves(false, false);
  controlState = STATE_COMPLETED;
  phase = PHASE_COMPLETE;
  phaseStartedMs = millis();
  logEvent("PLAN_COMPLETE", PLAN_ID, PLAN_DEPTH_TRIGGER_CM, cause);
}

void applyValves(bool injectionOn, bool exhaustOn) {
  if (valveStatus.injectionValve && !injectionOn) {
    digitalWrite(Pins::VALVE_INJECTION, LOW);
    valveStatus.injectionValve = false;
    logEvent("VALVE_OFF", PLAN_ID, PLAN_DEPTH_TRIGGER_CM, "injection");
  }
  if (valveStatus.exhaustValve && !exhaustOn) {
    digitalWrite(Pins::VALVE_EXHAUST, LOW);
    valveStatus.exhaustValve = false;
    logEvent("VALVE_OFF", PLAN_ID, PLAN_DEPTH_TRIGGER_CM, "exhaust");
  }
  if (!valveStatus.injectionValve && injectionOn) {
    digitalWrite(Pins::VALVE_INJECTION, HIGH);
    valveStatus.injectionValve = true;
    logEvent("VALVE_ON", PLAN_ID, PLAN_DEPTH_TRIGGER_CM, "injection");
  }
  if (!valveStatus.exhaustValve && exhaustOn) {
    digitalWrite(Pins::VALVE_EXHAUST, HIGH);
    valveStatus.exhaustValve = true;
    logEvent("VALVE_ON", PLAN_ID, PLAN_DEPTH_TRIGGER_CM, "exhaust");
  }
}

// ============================================================
// Logging

void logData() {
  uint32_t seq = sequenceNumber++;
  printDataRecord(Serial, seq);
  Serial.println();

  if (!sdReady) {
    errorFlags |= ERR_SD_WRITE;
    return;
  }

  File f = SD.open(DATA_LOG_FILENAME, FILE_WRITE);
  if (!f) {
    errorFlags |= ERR_SD_WRITE;
    return;
  }
  // 起動時のヘッダー作成に失敗していても、次の成功時にここで復旧する。
  if (f.size() == 0) {
    printDataHeader(f);
    f.println();
  }
  printDataRecord(f, seq);
  f.println();
  f.close();
  errorFlags &= static_cast<uint16_t>(~ERR_SD_WRITE);
}

void logEvent(const char* eventName, uint16_t planId, uint16_t thresholdCm, const char* message) {
  uint32_t seq = sequenceNumber++;
  printEventRecord(Serial, seq, eventName, planId, thresholdCm, message);
  Serial.println();

  if (!sdReady) {
    errorFlags |= ERR_SD_WRITE;
    return;
  }

  File f = SD.open(EVENT_LOG_FILENAME, FILE_WRITE);
  if (!f) {
    errorFlags |= ERR_SD_WRITE;
    return;
  }
  if (f.size() == 0) {
    printEventHeader(f);
    f.println();
  }
  printEventRecord(f, seq, eventName, planId, thresholdCm, message);
  f.println();
  f.close();
  errorFlags &= static_cast<uint16_t>(~ERR_SD_WRITE);
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
  out.print(PLAN_ID); out.print(',');
  out.print(cycleCount); out.print(',');
  out.print(phaseElapsedMs() / 1000UL); out.print(',');
  out.print(phaseRemainingMs() / 1000UL); out.print(',');
  printFloatIfValidOrNA(out, sensorData.waterTempValid, sensorData.waterTemperature, 2); out.print(',');
  printFloatIfValidOrNA(out, sensorData.depthValid, sensorData.pressureMbar, 2); out.print(',');
  printFloatIfValidOrNA(out, sensorData.depthValid, sensorData.depthM, 2); out.print(',');
  out.print(sensorData.maxDepthM, 2); out.print(',');
  printFloatIfValidOrNA(out, sensorData.depthValid, sensorData.pressureTempC, 2); out.print(',');
  printDoubleIfValidOrNA(out, gpsData.locationValid, gpsData.latitude, 6); out.print(',');
  printDoubleIfValidOrNA(out, gpsData.locationValid, gpsData.longitude, 6); out.print(',');
  printDoubleIfValidOrNA(out, gpsData.altitudeValid, gpsData.altitudeM, 1); out.print(',');
  out.print(gpsData.satellites); out.print(',');
  out.print(gpsData.locationValid ? 1 : 0); out.print(',');
  out.print(valveStatus.injectionValve ? 1 : 0); out.print(',');
  out.print(valveStatus.exhaustValve ? 1 : 0); out.print(',');
  out.print(sdReady ? 1 : 0); out.print(',');
  out.print(0); out.print(',');
  out.print(0); out.print(',');
  out.print(255); out.print(',');
  out.print(errorFlags); out.print(',');
  out.print(F("periodic"));
}

void printEventRecord(Print& out, uint32_t seq, const char* eventName, uint16_t planId, uint16_t thresholdCm, const char* message) {
  out.print(LOG_VERSION); out.print(',');
  out.print(seq); out.print(',');
  out.print(currentMillis); out.print(',');
  printDate(out); out.print(',');
  printTime(out); out.print(',');
  out.print(eventName); out.print(',');
  out.print(controlState); out.print(',');
  out.print(phase); out.print(',');
  out.print(F("NA,NA,NA,"));
  if (planId == 0) out.print(F("NA")); else out.print(planId);
  out.print(',');
  out.print(F("NA,NA,"));
  printFloatIfValidOrNA(out, sensorData.depthValid, sensorData.depthM, 2); out.print(',');
  if (thresholdCm == 0) out.print(F("NA")); else out.print(static_cast<float>(thresholdCm) / 100.0f, 2);
  out.print(',');
  printFloatIfValidOrNA(out, sensorData.waterTempValid, sensorData.waterTemperature, 2); out.print(',');
  out.print(valveStatus.injectionValve ? 1 : 0); out.print(',');
  out.print(valveStatus.exhaustValve ? 1 : 0); out.print(',');
  out.print(message);
}

void printDate(Print& out) {
  printDateValue(out, rtcData);
}

void printTime(Print& out) {
  printTimeValue(out, rtcData);
}

void printDateValue(Print& out, const RTCData& value) {
  char buf[12];
  snprintf(buf, sizeof(buf), "%04u-%02u-%02u", value.year, value.month, value.day);
  out.print(buf);
}

void printTimeValue(Print& out, const RTCData& value) {
  char buf[10];
  snprintf(buf, sizeof(buf), "%02u:%02u:%02u", value.hour, value.minute, value.second);
  out.print(buf);
}

void printFloatIfValidOrNA(Print& out, bool valid, float value, uint8_t digits) {
  if (!valid || isnan(value)) {
    out.print(F("NA"));
    return;
  }
  out.print(value, digits);
}

void printDoubleIfValidOrNA(Print& out, bool valid, double value, uint8_t digits) {
  if (!valid || isnan(value)) {
    out.print(F("NA"));
    return;
  }
  out.print(value, digits);
}

// ============================================================
// UI helpers

void updateLEDs() {
  bool sequenceRunning = controlState == STATE_RUNNING;
  bool hasWarning = (errorFlags &
                     (ERR_SD_WRITE | ERR_TEMP_SENSOR |
                      ERR_DEPTH_SENSOR | ERR_SENSOR_STALE)) != 0;

  digitalWrite(Pins::LED_GREEN, sequenceRunning ? HIGH : LOW);
  digitalWrite(Pins::LED_RED, hasWarning || !sequenceRunning ? HIGH : LOW);
}

void updateDisplay() {
#if UMIBOT_OLD_ENABLE_LCD
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(stateToString(controlState));
  lcd.print('/');
  lcd.print(phaseToString(phase));
  lcd.print(F(" C"));
  lcd.print(cycleCount);
  lcd.setCursor(0, 1);
  if (sensorData.depthValid) {
    lcd.print(sensorData.depthM, 1);
    lcd.print(F("m "));
  } else {
    lcd.print(F("depth NA "));
  }
  lcd.print(F("E"));
  lcd.print(errorFlags, HEX);
#endif
}

const char* stateToString(uint8_t value) {
  switch (value) {
    case STATE_SAFE_IDLE: return "SAFE";
    case STATE_RUNNING: return "RUN";
    case STATE_COMPLETED: return "DONE";
    default: return "UNK";
  }
}

const char* phaseToString(uint8_t value) {
  switch (value) {
    case PHASE_IDLE: return "IDLE";
    case PHASE_PREPARE: return "PREP";
    case PHASE_EXHAUST_OPEN: return "EXH";
    case PHASE_DESCENT_COAST: return "DESC";
    case PHASE_BOTTOM_WAIT: return "WAIT";
    case PHASE_INJECTION_OPEN: return "INJ";
    case PHASE_ASCENT_WAIT: return "ASC";
    case PHASE_COMPLETE: return "DONE";
    default: return "UNK";
  }
}
