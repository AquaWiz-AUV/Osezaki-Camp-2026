import test from "node:test";
import assert from "node:assert/strict";

import {
  DATA_COLUMNS,
  EVENT_COLUMNS,
  createSession,
  downsampleSeries,
  groupParsedFiles,
  parseLogText
} from "../src/log-core.js";
import {
  DATA_HEADER,
  EVENT_HEADER,
  createDemo
} from "../src/sample-data.js";

const BASE_DATA = {
  v: "3.6",
  seq: 3,
  ms: 500,
  date: "2026-07-27",
  time: "09:00:00",
  type: "DATA",
  state: 2,
  phase: 1,
  plan: 1,
  cycle: 0,
  elapsed: 0,
  remain: 5,
  water_c: 22.5,
  press_mbar: 1013.2,
  depth_m: 0,
  max_m: 0,
  press_c: 22.5,
  lat: "NA",
  lng: "NA",
  alt: "NA",
  sat: 0,
  gps: 0,
  vinj: 0,
  vexh: 0,
  sd: 1,
  last_seq: 0,
  last_result: 0,
  pc_age: 255,
  err: 0,
  msg: "periodic"
};

const BASE_EVENT = {
  v: "3.6",
  seq: 0,
  ms: 20,
  date: "2026-07-27",
  time: "09:00:00",
  event: "BOOT",
  state: 0,
  phase: 0,
  wireless_seq: "NA",
  cmd: "NA",
  result: "NA",
  plan: "NA",
  crc: "NA",
  src: "NA",
  depth_m: 0,
  threshold_m: "NA",
  water_c: 22.5,
  vinj: 0,
  vexh: 0,
  msg: "system_start_autonomous_old"
};

function csvCell(value) {
  const text = value === null || value === undefined ? "NA" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvRow(columns, values) {
  return columns.map((column) => csvCell(values[column])).join(",");
}

function issueCodes(value) {
  return new Set((value.issues || []).map((issue) => issue.code));
}

function assertNoCriticalOrWarning(session) {
  const actionable = session.issues.filter((issue) => issue.severity === "critical" || issue.severity === "warning");
  assert.deepEqual(actionable, []);
  assert.equal(session.summary.severityCounts.critical, 0);
  assert.equal(session.summary.severityCounts.warning, 0);
}

function parseDemo(vehicle, adversarial = false) {
  const demo = createDemo(vehicle, adversarial);
  const data = parseLogText(demo.dataText, `${vehicle}/DATA.CSV`);
  const event = parseLogText(demo.eventText, `${vehicle}/EVENT.CSV`);
  const session = createSession({ name: demo.name, data, event, vehicleHint: vehicle });
  return { demo, data, event, session };
}

test("firmware headers are exact and retain all 30 DATA / 20 EVENT columns", () => {
  assert.equal(DATA_COLUMNS.length, 30);
  assert.equal(EVENT_COLUMNS.length, 20);
  assert.deepEqual(DATA_HEADER.split(","), DATA_COLUMNS);
  assert.deepEqual(EVENT_HEADER.split(","), EVENT_COLUMNS);
  assert.equal(new Set(DATA_COLUMNS).size, 30);
  assert.equal(new Set(EVENT_COLUMNS).size, 20);
});

test("CSV tokenizer accepts UTF-8 BOM, CRLF, quoted commas, quotes, and embedded newlines", () => {
  const message = "operator, note\ncontinued \"normally\"";
  const row = csvRow(EVENT_COLUMNS, { ...BASE_EVENT, msg: message });
  const parsed = parseLogText(`\uFEFF${EVENT_HEADER}\r\n${row}\r\n`, "quoted/EVENT.CSV");

  assert.equal(parsed.kind, "EVENT");
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].msg, message);
  assert.equal(parsed.rows[0]._line, 2);
  assert.deepEqual(parsed.issues, []);
});

test("normal Triton sample has no critical/warning diagnostics and keeps dual-temperature semantics", () => {
  const { data, event, session } = parseDemo("triton");

  assert.equal(data.header.length, 30);
  assert.equal(event.header.length, 20);
  assert.equal(session.vehicle, "triton");
  assert.equal(session.inference.suggested, "triton");
  assert.ok(session.dataRows.some((row) => Number.isFinite(row.water_c) && Number.isFinite(row.press_c) && row.water_c !== row.press_c));
  assertNoCriticalOrWarning(session);
});

test("normal UmiBot sample has no critical/warning diagnostics and uses one MS5837 temperature", () => {
  const { session } = parseDemo("umibot");
  const comparable = session.dataRows.filter((row) => Number.isFinite(row.water_c) && Number.isFinite(row.press_c));

  assert.equal(session.vehicle, "umibot");
  assert.equal(session.inference.suggested, "umibot");
  assert.ok(comparable.length > 1_000);
  assert.ok(comparable.every((row) => row.water_c === row.press_c));
  assert.ok(session.dataRows.every((row) => row.last_seq === 0 && row.last_result === 0 && row.pc_age === 255));
  assert.ok(session.eventRows.every((row) => row.wireless_seq === null && row.cmd === null && row.result === null));
  assertNoCriticalOrWarning(session);
});

test("adversarial UmiBot fixture exposes schema, safety, range, unknown-bit, and temperature diagnostics", () => {
  const { data, session } = parseDemo("umibot", true);
  const codes = issueCodes(session);

  assert.equal(data.quarantined, 1);
  for (const code of [
    "column_count",
    "valve_conflict",
    "range_depth_m",
    "range_press_mbar",
    "range_lat",
    "range_lng",
    "unknown_error_bits",
    "umibot_temperature_mismatch"
  ]) {
    assert.ok(codes.has(code), `missing diagnostic: ${code}`);
  }
  assert.ok(session.summary.severityCounts.critical > 0);
  assert.ok(session.summary.severityCounts.warning > 0);
});

test("adversarial Triton fixture preserves the healthy MS5837 series and inert security probe text", () => {
  const { data, session } = parseDemo("triton", true);
  const codes = issueCodes(session);
  const isolatedTsysFault = session.dataRows.find((row) =>
    row.msg === "tsys01_unavailable" && row.water_c === null && Number.isFinite(row.press_c)
  );
  const securityProbe = session.eventRows.find((row) => row.event === "SECURITY_PROBE");

  assert.equal(data.quarantined, 1);
  assert.ok(codes.has("column_count"));
  assert.ok(codes.has("valve_conflict"));
  assert.ok(codes.has("range_depth_m"));
  assert.ok(isolatedTsysFault, "TSYS01 fault must not erase the independent pressure-sensor temperature");
  assert.match(securityProbe.msg, /^<img src=x onerror=/);
});

test("malformed input is rejected, quarantined, or reduced to a safe null value", async (t) => {
  await t.test("unclosed quoted record is quarantined", () => {
    const first18 = EVENT_COLUMNS.slice(0, 18).map((column) => csvCell(BASE_EVENT[column]));
    const parsed = parseLogText(`${EVENT_HEADER}\r\n${first18.join(",")},"0,unterminated`, "unclosed/EVENT.CSV");
    const codes = issueCodes(parsed);
    assert.ok(codes.has("unclosed_quote"));
    assert.ok(codes.has("column_count"));
    assert.equal(parsed.quarantined, 1);
    assert.equal(parsed.rows.length, 0);
  });

  await t.test("NUL input is rejected as binary", () => {
    const parsed = parseLogText(`${DATA_HEADER}\n${csvRow(DATA_COLUMNS, BASE_DATA)}\u0000`, "nul/DATA.CSV");
    assert.ok(issueCodes(parsed).has("binary_input"));
    assert.equal(parsed.rows.length, 0);
  });

  await t.test("non-finite numeric spelling never reaches charts", () => {
    const row = csvRow(DATA_COLUMNS, { ...BASE_DATA, depth_m: "Infinity" });
    const parsed = parseLogText(`${DATA_HEADER}\n${row}\n`, "nonfinite/DATA.CSV");
    assert.ok(issueCodes(parsed).has("invalid_number"));
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0].depth_m, null);
    assert.deepEqual(parsed.rows[0]._invalidFields, ["depth_m"]);
  });

  await t.test("a repeated header in the body is quarantined", () => {
    const row = csvRow(DATA_COLUMNS, BASE_DATA);
    const parsed = parseLogText(`${DATA_HEADER}\n${row}\n${DATA_HEADER}\n`, "joined/DATA.CSV");
    assert.ok(issueCodes(parsed).has("repeated_header"));
    assert.equal(parsed.quarantined, 1);
    assert.equal(parsed.rows.length, 1);
  });

  await t.test("duplicate column names make the schema critical", () => {
    const duplicate = [...DATA_COLUMNS];
    duplicate[duplicate.length - 1] = "err";
    const parsed = parseLogText(`${duplicate.join(",")}\n`, "duplicate/DATA.CSV");
    assert.ok(issueCodes(parsed).has("duplicate_column"));
    assert.ok(parsed.issues.some((issue) => issue.code === "duplicate_column" && issue.severity === "critical"));
  });
});

test("DATA-only and EVENT-only sessions explain their reduced fidelity", () => {
  const demo = createDemo("triton");
  const data = parseLogText(demo.dataText, "only-data/DATA.CSV");
  const event = parseLogText(demo.eventText, "only-event/EVENT.CSV");
  const dataOnly = createSession({ name: "DATA only", data, vehicleHint: "triton" });
  const eventOnly = createSession({ name: "EVENT only", event, vehicleHint: "triton" });

  assert.ok(issueCodes(dataOnly).has("missing_event"));
  assert.ok(!issueCodes(dataOnly).has("missing_data"));
  assert.equal(dataOnly.summary.dataRows, data.rows.length);
  assert.ok(issueCodes(eventOnly).has("missing_data"));
  assert.ok(!issueCodes(eventOnly).has("missing_event"));
  assert.equal(eventOnly.summary.eventRows, event.rows.length);
});

test("ambiguous bare files are kept separate instead of being guessed into pairs", () => {
  const first = parseLogText(createDemo("triton").dataText, "DATA.CSV");
  const second = parseLogText(createDemo("umibot").dataText, "DATA.CSV");
  const sessions = groupParsedFiles([
    { name: "DATA.CSV", path: "DATA.CSV", parsed: first },
    { name: "DATA.CSV", path: "DATA.CSV", parsed: second }
  ]);

  assert.equal(sessions.length, 2);
  assert.ok(sessions.every((session) => issueCodes(session).has("ambiguous_pair")));
  assert.ok(sessions.every((session) => issueCodes(session).has("missing_event")));
});

test("reboot boundaries split epochs and produce a monotonic display timeline", () => {
  const rows = [
    { ...BASE_EVENT, seq: 0, ms: 100, event: "BOOT", state: 0, phase: 0, msg: "boot_one" },
    { ...BASE_EVENT, seq: 1, ms: 200, event: "PHASE_CHANGE", state: 2, phase: 1, plan: 1, msg: "PREP" },
    { ...BASE_EVENT, seq: 0, ms: 50, event: "BOOT", state: 0, phase: 0, msg: "boot_two" },
    { ...BASE_EVENT, seq: 1, ms: 60, event: "START_PLAN", state: 2, phase: 0, plan: 1, msg: "auto_start" }
  ];
  const text = `${EVENT_HEADER}\n${rows.map((row) => csvRow(EVENT_COLUMNS, row)).join("\n")}\n`;
  const event = parseLogText(text, "reboot/EVENT.CSV");
  const session = createSession({ name: "reboot", event, vehicleHint: "umibot" });
  const times = session.eventRows.map((row) => row._timelineMs);

  assert.equal(session.epochCount, 2);
  assert.deepEqual([...new Set(session.eventRows.map((row) => row._epoch))], [0, 1]);
  assert.ok(issueCodes(session).has("boot_boundary"));
  assert.ok(times.every((value, index) => index === 0 || value >= times[index - 1]));
  assert.ok(Math.min(...session.eventRows.filter((row) => row._epoch === 1).map((row) => row._timelineMs)) >
    Math.max(...session.eventRows.filter((row) => row._epoch === 0).map((row) => row._timelineMs)));
});

test("uint32 millis wrap is unwrapped without creating a false reboot", () => {
  const rows = [
    { ...BASE_EVENT, seq: 100, ms: 4_294_967_000, event: "PHASE_CHANGE", state: 2, phase: 4, plan: 1, msg: "WAIT" },
    { ...BASE_EVENT, seq: 101, ms: 100, event: "PHASE_CHANGE", state: 2, phase: 5, plan: 1, vinj: 1, msg: "INJ" }
  ];
  const text = `${EVENT_HEADER}\n${rows.map((row) => csvRow(EVENT_COLUMNS, row)).join("\n")}\n`;
  const event = parseLogText(text, "wrap/EVENT.CSV");
  const session = createSession({ name: "wrap", event, vehicleHint: "umibot" });

  assert.equal(session.epochCount, 1);
  assert.ok(issueCodes(session).has("millis_wrap"));
  assert.equal(session.eventRows[0]._timelineMs, 0);
  assert.equal(session.eventRows[1]._timelineMs, 396);
});

test("CSV without a device identifier remains unknown until the operator selects a vehicle", () => {
  const demo = createDemo("umibot");
  const data = parseLogText(demo.dataText, "unknown/DATA.CSV");
  const event = parseLogText(demo.eventText, "unknown/EVENT.CSV");
  const session = createSession({ name: "unknown vehicle", data, event });

  assert.equal(session.vehicle, "unknown");
  assert.equal(session.inference.suggested, "umibot");
  assert.equal(session.inference.confidence, "hint");
  assert.ok(issueCodes(session).has("vehicle_required"));
});

test("downsampling is bounded and returns time-ordered finite points", () => {
  const rows = Array.from({ length: 20_000 }, (_, index) => ({
    _timelineMs: index * 500,
    depth_m: 10 + Math.sin(index / 17) * 3
  }));
  const sampled = downsampleSeries(rows, "depth_m", 321);

  assert.ok(sampled.length > 0);
  assert.ok(sampled.length <= 321);
  assert.ok(sampled.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
  assert.ok(sampled.every((point, index) => index === 0 || point.x >= sampled[index - 1].x));
});

test("200k-row summary is incremental and does not overflow Math.apply argument limits", () => {
  const rowCount = 200_000;
  const rows = Array.from({ length: rowCount }, (_, index) => ({
    v: "3.6",
    seq: index,
    ms: index * 500,
    state: 2,
    phase: 4,
    cycle: Math.floor(index / 1_000),
    vinj: 0,
    vexh: 0,
    sd: 1,
    gps: 0,
    depth_m: (index % 100) / 10,
    max_m: 9.9,
    water_c: 20,
    press_c: 20,
    press_mbar: 1013,
    lat: null,
    lng: null,
    _order: index,
    _source: "large/DATA.CSV",
    _line: index + 2
  }));

  const session = createSession({
    name: "200k rows",
    data: { kind: "DATA", rows, issues: [] },
    vehicleHint: "umibot"
  });

  assert.equal(session.summary.dataRows, rowCount);
  assert.equal(session.summary.maxDepth, 9.9);
  assert.deepEqual(session.summary.temperature, { min: 20, max: 20, average: 20 });
  assert.equal(session.summary.severityCounts.critical, 0);
});
