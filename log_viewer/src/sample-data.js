export const DATA_HEADER =
  "v,seq,ms,date,time,type,state,phase,plan,cycle,elapsed,remain,water_c,press_mbar,depth_m,max_m,press_c,lat,lng,alt,sat,gps,vinj,vexh,sd,last_seq,last_result,pc_age,err,msg";

export const EVENT_HEADER =
  "v,seq,ms,date,time,event,state,phase,wireless_seq,cmd,result,plan,crc,src,depth_m,threshold_m,water_c,vinj,vexh,msg";

const DATA_FIELDS = DATA_HEADER.split(",");
const EVENT_FIELDS = EVENT_HEADER.split(",");

const VERSION = "3.6";
const SAMPLE_MS = 500;
const CYCLE_MS = 340_000;
const CAPTURE_MS = CYCLE_MS * 2;
const PLAN_ID = 1;
// Use UTC arithmetic as a timezone-independent wall-clock formatter for 09:00 JST.
const START_UTC_MS = Date.UTC(2026, 6, 27, 9, 0, 0);

const PHASES = [
  { phase: 1, name: "PREP", start: 0, end: 5_000, vinj: 0, vexh: 0 },
  { phase: 2, name: "EXH", start: 5_000, end: 65_000, vinj: 0, vexh: 1 },
  { phase: 3, name: "DESC", start: 65_000, end: 80_000, vinj: 0, vexh: 0 },
  { phase: 4, name: "WAIT", start: 80_000, end: 200_000, vinj: 0, vexh: 0 },
  { phase: 5, name: "INJ", start: 200_000, end: 220_000, vinj: 1, vexh: 0 },
  { phase: 6, name: "ASC", start: 220_000, end: CYCLE_MS, vinj: 0, vexh: 0 }
];

function normaliseVehicle(vehicle) {
  const value = String(vehicle || "").trim().toLowerCase();
  if (value === "triton" || value === "triton-3" || value === "triton3") return "triton";
  if (value === "umibot" || value === "umi-bot" || value === "umi") return "umibot";
  throw new TypeError(`Unknown sample vehicle: ${vehicle}`);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(value) {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function interpolate(from, to, progress) {
  return from + (to - from) * smoothstep(progress);
}

function fixed(value, digits) {
  return Number(value).toFixed(digits);
}

function dateTimeAt(ms) {
  const iso = new Date(START_UTC_MS + ms).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
}

function phaseAt(ms) {
  if (ms >= CAPTURE_MS) {
    return { state: 3, cycle: 2, phase: 7, phaseName: "DONE", elapsed: 0, remain: 0, vinj: 0, vexh: 0 };
  }
  const cycle = Math.floor(ms / CYCLE_MS);
  const localMs = ms % CYCLE_MS;
  const phase = PHASES.find((candidate) => localMs >= candidate.start && localMs < candidate.end) || PHASES[0];
  return {
    state: 2,
    cycle,
    phase: phase.phase,
    phaseName: phase.name,
    elapsed: Math.floor((localMs - phase.start) / 1_000),
    remain: Math.floor((phase.end - localMs) / 1_000),
    vinj: phase.vinj,
    vexh: phase.vexh
  };
}

function depthAt(ms) {
  const cycle = Math.min(1, Math.floor(ms / CYCLE_MS));
  const localMs = ms >= CAPTURE_MS ? CYCLE_MS : ms - cycle * CYCLE_MS;
  const target = cycle === 0 ? 12.2 : 11.45;
  const seconds = localMs / 1_000;
  let depth;

  if (seconds < 5) {
    depth = 0.08 + 0.01 * Math.sin(seconds * 1.7);
  } else if (seconds < 65) {
    depth = interpolate(0.08, 1.55, (seconds - 5) / 60);
  } else if (seconds < 80) {
    depth = interpolate(1.55, 7.4, (seconds - 65) / 15);
  } else if (seconds < 125) {
    depth = interpolate(7.4, target, (seconds - 80) / 45);
  } else if (seconds < 200) {
    depth = target + 0.13 * Math.sin((seconds - 125) / 7.5) + 0.04 * Math.sin(seconds / 2.1);
  } else if (seconds < 220) {
    depth = interpolate(target, 9.35, (seconds - 200) / 20);
  } else {
    depth = interpolate(9.35, 0.1, (seconds - 220) / 120);
  }

  return Math.max(-0.05, depth);
}

function gpsAt(ms) {
  if (ms < 3_000) {
    return { lat: "NA", lng: "NA", alt: "NA", sat: 0, gps: 0 };
  }

  const cycle = Math.min(1, Math.floor(ms / CYCLE_MS));
  const cycleStart = cycle * CYCLE_MS;
  const localMs = ms - cycleStart;
  let lastFixMs;
  if (localMs <= 10_000 || localMs >= 334_000) lastFixMs = ms;
  else lastFixMs = cycleStart + 10_000;

  const driftSeconds = lastFixMs / 1_000;
  const lat = 35.01762 + driftSeconds * 0.00000012 + Math.sin(driftSeconds / 37) * 0.000002;
  const lng = 138.79294 + driftSeconds * 0.00000018 + Math.cos(driftSeconds / 41) * 0.000002;
  const fresh = lastFixMs === ms;
  return {
    lat: fixed(lat, 6),
    lng: fixed(lng, 6),
    alt: fixed(3.2 + Math.sin(driftSeconds / 25) * 0.3, 1),
    sat: fresh ? 9 : 2,
    gps: 1
  };
}

function sensorAt(vehicle, ms) {
  const depth = depthAt(ms);
  const seconds = ms / 1_000;
  const pressure = 1013.25 + depth * 100.7 + Math.sin(seconds / 9) * 0.45;
  const ambientWater = 21.7 - depth * 0.31 + Math.sin(seconds / 31) * 0.08;
  const pressureTemp = ambientWater + 0.28 + Math.sin(seconds / 17) * 0.04;
  return {
    depth: fixed(depth, 2),
    pressure: fixed(pressure, 2),
    water: fixed(vehicle === "umibot" ? pressureTemp : ambientWater, 2),
    pressureTemp: fixed(pressureTemp, 2)
  };
}

function makeDataRows(vehicle, adversarial) {
  const rows = [];
  let maxDepth = 0;

  for (let ms = SAMPLE_MS; ms <= CAPTURE_MS; ms += SAMPLE_MS) {
    const mission = phaseAt(ms);
    const sensor = sensorAt(vehicle, ms);
    const gps = gpsAt(ms);
    maxDepth = Math.max(maxDepth, Number(sensor.depth));
    const clock = dateTimeAt(ms);
    const row = {
      v: VERSION,
      seq: null,
      ms,
      date: clock.date,
      time: clock.time,
      type: "DATA",
      state: mission.state,
      phase: mission.phase,
      plan: PLAN_ID,
      cycle: mission.cycle,
      elapsed: mission.elapsed,
      remain: mission.remain,
      water_c: sensor.water,
      press_mbar: sensor.pressure,
      depth_m: sensor.depth,
      max_m: fixed(maxDepth, 2),
      press_c: sensor.pressureTemp,
      lat: gps.lat,
      lng: gps.lng,
      alt: gps.alt,
      sat: gps.sat,
      gps: gps.gps,
      vinj: mission.vinj,
      vexh: mission.vexh,
      sd: 1,
      last_seq: 0,
      last_result: 0,
      pc_age: 255,
      err: 0,
      msg: "periodic"
    };

    if (adversarial) applyDataFault(vehicle, row, ms);
    rows.push(row);
  }

  return rows;
}

function applyDataFault(vehicle, row, ms) {
  if (ms >= 90_000 && ms <= 91_500) {
    row.vinj = 1;
    row.vexh = 1;
    row.err = 0x0040;
    row.msg = "valve_conflict_probe";
  }

  if (ms >= 145_000 && ms <= 150_000) {
    if (vehicle === "triton") {
      row.water_c = "NA";
      row.err |= 0x0004;
      row.msg = "tsys01_unavailable";
    } else {
      row.water_c = "NA";
      row.press_mbar = "NA";
      row.depth_m = "NA";
      row.press_c = "NA";
      row.err |= 0x0408;
      row.msg = "ms5837_timeout";
    }
  }

  if (ms >= 260_000 && ms <= 262_000) {
    row.sd = 0;
    row.err |= 0x0002;
    row.msg = "sd_recovery_marker";
  }

  if (ms === 300_000) {
    row.water_c = "-99.00";
    row.press_mbar = "99999.00";
    row.depth_m = "999.99";
    row.max_m = "999.99";
    row.press_c = "120.00";
    row.lat = "91.250000";
    row.lng = "181.500000";
    row.alt = "99999.0";
    row.sat = 255;
    row.gps = 1;
    row.err |= 0x8008;
    row.msg = "range_validation_probe";
  }

  if (ms === 555_000) {
    row.err |= 0x8000;
    row.msg = "unknown_error_bit_0x8000";
  }

  if (ms === 556_000) {
    row.msg = "'=HYPERLINK(\"https://invalid.example\",\"inert probe\")";
  }
}

function eventSnapshot(vehicle, ms, event, state, phase, vinj, vexh, message, plan = PLAN_ID) {
  const sensor = sensorAt(vehicle, ms);
  const clock = dateTimeAt(ms);
  return {
    v: VERSION,
    seq: null,
    ms,
    date: clock.date,
    time: clock.time,
    event,
    state,
    phase,
    wireless_seq: "NA",
    cmd: "NA",
    result: "NA",
    plan: plan === null ? "NA" : plan,
    crc: "NA",
    src: "NA",
    depth_m: sensor.depth,
    threshold_m: "NA",
    water_c: sensor.water,
    vinj,
    vexh,
    msg: message
  };
}

function makeEventRows(vehicle, adversarial) {
  const rows = [];
  const push = (...args) => rows.push(eventSnapshot(vehicle, ...args));

  push(0, "BOOT", 0, 0, 0, 0, vehicle === "triton" ? "system_start_autonomous" : "system_start_autonomous_old", vehicle === "triton" ? PLAN_ID : null);
  push(0, "START_PLAN", 2, 0, 0, 0, "auto_start");
  push(0, "PHASE_CHANGE", 2, 1, 0, 0, "PREP");
  push(3_000, "RTC_SYNC_GPS", 2, 1, 0, 0, "rtc_synced_jst");

  for (let cycle = 0; cycle < 2; cycle += 1) {
    const start = cycle * CYCLE_MS;
    push(start + 5_000, "VALVE_ON", 2, 2, 0, 1, "exhaust");
    push(start + 5_000, "PHASE_CHANGE", 2, 2, 0, 1, "EXH");
    push(start + 65_000, "VALVE_OFF", 2, 3, 0, 0, "exhaust");
    push(start + 65_000, "PHASE_CHANGE", 2, 3, 0, 0, "DESC");
    push(start + 80_000, "PHASE_CHANGE", 2, 4, 0, 0, "WAIT");
    push(start + 200_000, "VALVE_ON", 2, 5, 1, 0, "injection");
    push(start + 200_000, "PHASE_CHANGE", 2, 5, 1, 0, "INJ");
    push(start + 220_000, "VALVE_OFF", 2, 6, 0, 0, "injection");
    push(start + 220_000, "PHASE_CHANGE", 2, 6, 0, 0, "ASC");
    if (cycle === 0) push(start + CYCLE_MS, "PHASE_CHANGE", 2, 1, 0, 0, "PREP");
    else push(start + CYCLE_MS, "PLAN_COMPLETE", 3, 7, 0, 0, "repeat_complete");
  }

  if (adversarial) {
    rows.push(eventSnapshot(vehicle, 90_000, "VALVE_CONFLICT", 2, 4, 1, 1, "both_valves_reported_open"));
    rows.push(eventSnapshot(vehicle, 555_000, "ALIEN_EVENT", 2, 4, 0, 0, "unknown_event_probe"));
    rows.push(
      eventSnapshot(
        vehicle,
        556_000,
        "SECURITY_PROBE",
        2,
        4,
        0,
        0,
        "<img src=x onerror=alert(\"inert-fixture\")> formula_probe:=1+1"
      )
    );
  }

  return rows;
}

function assignSharedSequence(dataRows, eventRows, adversarial) {
  const combined = [];
  let stableOrder = 0;
  eventRows.forEach((row) => combined.push({ row, kindOrder: 0, stableOrder: stableOrder++ }));
  dataRows.forEach((row) => combined.push({ row, kindOrder: 1, stableOrder: stableOrder++ }));
  combined.sort((a, b) => a.row.ms - b.row.ms || a.kindOrder - b.kindOrder || a.stableOrder - b.stableOrder);
  combined.forEach((entry, seq) => {
    entry.row.seq = seq;
  });

  if (adversarial) {
    const duplicateIndex = dataRows.findIndex((row) => row.ms === 310_000);
    if (duplicateIndex > 0) dataRows[duplicateIndex].seq = dataRows[duplicateIndex - 1].seq;
  }
}

function csvCell(value) {
  const text = value === null || value === undefined ? "NA" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function serialise(header, fields, rows) {
  const lines = [header];
  for (const row of rows) lines.push(fields.map((field) => csvCell(row[field])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

export function createDemo(vehicle, adversarial = false) {
  const canonicalVehicle = normaliseVehicle(vehicle);
  const withFaults = Boolean(adversarial);
  const dataRows = makeDataRows(canonicalVehicle, withFaults);
  const eventRows = makeEventRows(canonicalVehicle, withFaults);
  assignSharedSequence(dataRows, eventRows, withFaults);

  let dataText = serialise(DATA_HEADER, DATA_FIELDS, dataRows);
  const eventText = serialise(EVENT_HEADER, EVENT_FIELDS, eventRows);
  if (withFaults) {
    // Deliberately short final record: valid CSV syntax, invalid DATA schema.
    dataText += "3.6,999999,680500,2026-07-27,09:11:20,DATA,2\r\n";
  }

  return {
    name: `${canonicalVehicle}-${withFaults ? "adversarial" : "normal"}-two-cycle`,
    dataText,
    eventText,
    vehicle: canonicalVehicle
  };
}
