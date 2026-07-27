const UINT32_RANGE = 4_294_967_296;

export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_ROWS = 250_000;
export const MAX_CELL_CHARS = 8_192;

export const DATA_COLUMNS = [
  "v", "seq", "ms", "date", "time", "type", "state", "phase", "plan", "cycle",
  "elapsed", "remain", "water_c", "press_mbar", "depth_m", "max_m", "press_c", "lat",
  "lng", "alt", "sat", "gps", "vinj", "vexh", "sd", "last_seq", "last_result", "pc_age",
  "err", "msg"
];

export const EVENT_COLUMNS = [
  "v", "seq", "ms", "date", "time", "event", "state", "phase", "wireless_seq", "cmd",
  "result", "plan", "crc", "src", "depth_m", "threshold_m", "water_c", "vinj", "vexh", "msg"
];

export const STATE_LABELS = {
  0: "待機",
  2: "実行中",
  3: "完了"
};

export const PHASE_LABELS = {
  0: "IDLE",
  1: "PREP",
  2: "EXH",
  3: "DESC",
  4: "WAIT",
  5: "INJ",
  6: "ASC",
  7: "DONE"
};

export const ERROR_BITS = [
  { bit: 0x0002, code: "SD_WRITE", label: "SD書き込み異常" },
  { bit: 0x0004, code: "TEMP_SENSOR", label: "水温センサー異常" },
  { bit: 0x0008, code: "DEPTH_SENSOR", label: "深度センサー異常" },
  { bit: 0x0400, code: "SENSOR_STALE", label: "センサー更新停滞" }
];

const DATA_NUMERIC = new Set([
  "seq", "ms", "state", "phase", "plan", "cycle", "elapsed", "remain", "water_c", "press_mbar",
  "depth_m", "max_m", "press_c", "lat", "lng", "alt", "sat", "gps", "vinj", "vexh", "sd",
  "last_seq", "last_result", "pc_age", "err"
]);

const EVENT_NUMERIC = new Set([
  "seq", "ms", "state", "phase", "wireless_seq", "cmd", "result", "plan", "crc", "src", "depth_m",
  "threshold_m", "water_c", "vinj", "vexh"
]);

const KNOWN_EVENTS = new Set([
  "BOOT", "START_PLAN", "PHASE_CHANGE", "VALVE_ON", "VALVE_OFF", "PLAN_COMPLETE",
  "DEPTH_TRIGGER", "RTC_SYNC_GPS"
]);

function createIssueCollector(seed = []) {
  const issues = [];
  const index = new Map();
  let omitted = 0;

  function add(value) {
    if (!value) return;
    const normalized = {
      severity: value.severity || "warning",
      code: value.code || "unknown",
      title: value.title || value.code || "不明な問題",
      detail: value.detail || "",
      source: value.source || "",
      count: value.count || 1,
      lines: Array.isArray(value.lines) ? value.lines.filter(Number.isFinite).slice(0, 5) : []
    };
    if (Number.isFinite(value.line) && !normalized.lines.includes(value.line)) normalized.lines.push(value.line);
    const key = [normalized.severity, normalized.code, normalized.title, normalized.source, normalized.detail].join("\u0000");
    const existing = index.get(key);
    if (existing) {
      existing.count += normalized.count;
      for (const line of normalized.lines) {
        if (existing.lines.length < 5 && !existing.lines.includes(line)) existing.lines.push(line);
      }
      return;
    }
    if (issues.length >= 400) {
      omitted += normalized.count;
      return;
    }
    issues.push(normalized);
    index.set(key, normalized);
  }

  for (const item of seed) add(item);

  return {
    add,
    finish() {
      if (omitted > 0) {
        issues.push({
          severity: "warning",
          code: "diagnostics_truncated",
          title: "診断件数を省略しました",
          detail: `同種の問題が多いため、追加の ${omitted.toLocaleString("ja-JP")} 件は表示を省略しました。`,
          source: "",
          count: omitted,
          lines: []
        });
      }
      return issues;
    }
  };
}

function isBlankRow(fields) {
  return fields.length === 1 && fields[0].trim() === "";
}

/** RFC 4180 style tokenization with bounded rows and cells. */
export function tokenizeCsv(input, options = {}) {
  const collector = createIssueCollector();
  const maxRows = options.maxRows ?? MAX_ROWS;
  const source = options.source || "CSV";
  let text = String(input ?? "");

  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes("\u0000")) {
    collector.add({
      severity: "critical",
      code: "binary_input",
      title: "CSVではない可能性があります",
      detail: "NUL文字を検出したため、安全のため読み込みを中止しました。",
      source
    });
    return { records: [], issues: collector.finish(), truncated: false };
  }

  const records = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let justClosedQuote = false;
  let fieldWasTruncated = false;
  let line = 1;
  let rowStartLine = 1;
  let stopped = false;

  const append = (char) => {
    if (field.length < MAX_CELL_CHARS) field += char;
    else fieldWasTruncated = true;
  };

  const pushField = () => {
    if (fieldWasTruncated) {
      collector.add({
        severity: "warning",
        code: "cell_too_long",
        title: "長すぎるセルを切り詰めました",
        detail: `1セルは最大 ${MAX_CELL_CHARS.toLocaleString("ja-JP")} 文字です。`,
        source,
        line: rowStartLine
      });
    }
    row.push(field);
    field = "";
    fieldWasTruncated = false;
    justClosedQuote = false;
  };

  const pushRow = () => {
    pushField();
    if (!isBlankRow(row)) records.push({ fields: row, line: rowStartLine });
    row = [];
    rowStartLine = line + 1;
    if (records.length > maxRows + 1) {
      collector.add({
        severity: "critical",
        code: "row_limit",
        title: "行数上限を超えました",
        detail: `1ファイルは最大 ${maxRows.toLocaleString("ja-JP")} 行までです。巨大ファイルによる画面停止を防ぐため、残りを読み込みませんでした。`,
        source,
        line
      });
      records.length = maxRows + 1;
      stopped = true;
    }
  };

  for (let i = 0; i < text.length && !stopped; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          append('"');
          i += 1;
        } else {
          inQuotes = false;
          justClosedQuote = true;
        }
      } else {
        append(char);
        if (char === "\n") line += 1;
        else if (char === "\r" && text[i + 1] !== "\n") line += 1;
      }
      continue;
    }

    if (justClosedQuote && char !== "," && char !== "\r" && char !== "\n") {
      if (!/\s/.test(char)) {
        collector.add({
          severity: "warning",
          code: "characters_after_quote",
          title: "閉じ引用符の後に文字があります",
          detail: "引用フィールドの後には区切り記号または改行が必要です。",
          source,
          line
        });
      }
      append(char);
      justClosedQuote = false;
      continue;
    }

    if (char === '"' && field.length === 0) {
      inQuotes = true;
    } else if (char === ",") {
      pushField();
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      pushRow();
      line += 1;
      rowStartLine = line;
    } else {
      append(char);
    }
  }

  if (inQuotes) {
    collector.add({
      severity: "critical",
      code: "unclosed_quote",
      title: "引用符が閉じていません",
      detail: "電源断などで末尾行が途中までしか保存されていない可能性があります。",
      source,
      line: rowStartLine
    });
  }

  if (!stopped && (row.length > 0 || field.length > 0 || justClosedQuote)) pushRow();
  return { records, issues: collector.finish(), truncated: stopped };
}

function normalizeHeader(fields) {
  return fields.map((value) => value.trim().toLowerCase());
}

function detectKind(header) {
  const names = new Set(header);
  if (names.has("event") && names.has("wireless_seq")) return "EVENT";
  if (names.has("type") && names.has("cycle") && names.has("depth_m")) return "DATA";
  return null;
}

function parseFiniteNumber(value) {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toUpperCase() === "NA") return { value: null, valid: true };
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    return { value: null, valid: false };
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? { value: parsed, valid: true } : { value: null, valid: false };
}

function sameHeader(fields, header) {
  if (fields.length !== header.length) return false;
  return fields.every((value, index) => value.trim().toLowerCase() === header[index]);
}

export function parseLogText(text, source = "CSV", options = {}) {
  const tokenized = tokenizeCsv(text, { source, maxRows: options.maxRows ?? MAX_ROWS });
  const collector = createIssueCollector(tokenized.issues);

  if (tokenized.records.length === 0) {
    collector.add({
      severity: "critical",
      code: "empty_file",
      title: "CSVにデータがありません",
      detail: "ヘッダーを含むDATA.CSVまたはEVENT.CSVを選択してください。",
      source
    });
    return { source, kind: null, header: [], rows: [], quarantined: 0, issues: collector.finish() };
  }

  const headerRecord = tokenized.records[0];
  const header = normalizeHeader(headerRecord.fields);
  const kind = detectKind(header);
  const duplicateNames = header.filter((name, index) => header.indexOf(name) !== index);
  for (const name of new Set(duplicateNames)) {
    collector.add({
      severity: "critical",
      code: "duplicate_column",
      title: "列名が重複しています",
      detail: `重複列: ${name || "(空欄)"}`,
      source,
      line: headerRecord.line
    });
  }

  if (!kind) {
    collector.add({
      severity: "critical",
      code: "unknown_schema",
      title: "ログ種別を判定できません",
      detail: "Triton/UmiBot standalone v3.6のDATAまたはEVENTヘッダーではありません。",
      source,
      line: headerRecord.line
    });
    return { source, kind: null, header, rows: [], quarantined: tokenized.records.length - 1, issues: collector.finish() };
  }

  const expected = kind === "DATA" ? DATA_COLUMNS : EVENT_COLUMNS;
  const numeric = kind === "DATA" ? DATA_NUMERIC : EVENT_NUMERIC;
  const missing = expected.filter((column) => !header.includes(column));
  const extra = header.filter((column) => !expected.includes(column));
  if (missing.length > 0) {
    collector.add({
      severity: "critical",
      code: "missing_columns",
      title: "必須列が不足しています",
      detail: missing.join(", "),
      source,
      line: headerRecord.line
    });
  }
  if (extra.length > 0) {
    collector.add({
      severity: "info",
      code: "future_columns",
      title: "未知の追加列があります",
      detail: `将来版の可能性があります: ${extra.join(", ")}`,
      source,
      line: headerRecord.line
    });
  }

  const rows = [];
  let quarantined = 0;
  for (let index = 1; index < tokenized.records.length; index += 1) {
    const raw = tokenized.records[index];
    if (sameHeader(raw.fields, header)) {
      quarantined += 1;
      collector.add({
        severity: "warning",
        code: "repeated_header",
        title: "途中に重複ヘッダーがあります",
        detail: "複数ファイルを単純連結した可能性があります。この行は隔離しました。",
        source,
        line: raw.line
      });
      continue;
    }
    if (raw.fields.length !== header.length) {
      quarantined += 1;
      collector.add({
        severity: "critical",
        code: "column_count",
        title: "列数が一致しない行を隔離しました",
        detail: `期待 ${header.length} 列、実際 ${raw.fields.length} 列。末尾が途中で切れた可能性があります。`,
        source,
        line: raw.line
      });
      continue;
    }

    const row = Object.create(null);
    row._source = source;
    row._line = raw.line;
    row._order = index - 1;
    row._invalidFields = [];

    for (let columnIndex = 0; columnIndex < header.length; columnIndex += 1) {
      const column = header[columnIndex];
      if (!expected.includes(column)) continue;
      const rawValue = raw.fields[columnIndex];
      if (numeric.has(column)) {
        const parsed = parseFiniteNumber(rawValue);
        row[column] = parsed.value;
        if (!parsed.valid) {
          row._invalidFields.push(column);
          collector.add({
            severity: "critical",
            code: "invalid_number",
            title: "有限数ではない値を欠損扱いにしました",
            detail: `${column}=${rawValue.slice(0, 80)}`,
            source,
            line: raw.line
          });
        }
      } else {
        const value = rawValue.trim();
        row[column] = value === "" || value.toUpperCase() === "NA" ? null : value;
      }
    }
    rows.push(row);
  }

  return { source, kind, header, rows, quarantined, issues: collector.finish(), truncated: tokenized.truncated };
}

function annotateTimeline(rows, kind, collector) {
  let epoch = 0;
  let wrapOffset = 0;
  let previousMs = null;
  let previousSeq = null;
  let haveRecord = false;

  return rows.map((sourceRow) => {
    const row = sourceRow;
    const rawMs = row.ms;
    const rawSeq = row.seq;
    let startedNewEpoch = false;

    if (Number.isFinite(rawMs)) {
      const seqRegressed = Number.isFinite(previousSeq) && Number.isFinite(rawSeq) && rawSeq < previousSeq;
      const msRegressed = Number.isFinite(previousMs) && rawMs < previousMs;
      const looksLikeWrap = msRegressed && previousMs > 4_000_000_000 && rawMs < 300_000_000 && !seqRegressed;
      const bootBoundary = kind === "EVENT" && row.event === "BOOT" && haveRecord && (seqRegressed || msRegressed);

      if (looksLikeWrap) {
        wrapOffset += UINT32_RANGE;
        collector.add({
          severity: "info",
          code: "millis_wrap",
          title: "millis() の周回を補正しました",
          detail: "約49.7日で発生するuint32周回として時系列を展開しました。",
          source: row._source,
          line: row._line
        });
      } else if (bootBoundary || (seqRegressed && msRegressed)) {
        epoch += 1;
        wrapOffset = 0;
        startedNewEpoch = true;
        collector.add({
          severity: "info",
          code: "boot_boundary",
          title: "再起動境界を検出しました",
          detail: "seq/msの回帰を別の起動として分離しました。",
          source: row._source,
          line: row._line
        });
      } else if (msRegressed) {
        collector.add({
          severity: "warning",
          code: "out_of_order_ms",
          title: "時刻が逆行しています",
          detail: "ファイル順は保持し、表示時だけ時刻順に整列します。",
          source: row._source,
          line: row._line
        });
      } else if (seqRegressed) {
        epoch += 1;
        wrapOffset = 0;
        startedNewEpoch = true;
        collector.add({
          severity: "warning",
          code: "seq_reset",
          title: "seqのリセットを検出しました",
          detail: "msの明確な回帰はありませんが、別起動として扱います。",
          source: row._source,
          line: row._line
        });
      }

      row._epoch = epoch;
      row._unwrappedMs = rawMs + wrapOffset;
      if (!startedNewEpoch || haveRecord) {
        previousMs = rawMs;
        previousSeq = rawSeq;
      }
      haveRecord = true;
    } else {
      row._epoch = epoch;
      row._unwrappedMs = null;
    }
    return row;
  });
}

function alignEpochs(dataRows, eventRows) {
  const all = [...dataRows, ...eventRows].filter((row) => Number.isFinite(row._unwrappedMs));
  const epochStats = new Map();
  for (const row of all) {
    const stats = epochStats.get(row._epoch) || { min: Infinity, max: -Infinity };
    stats.min = Math.min(stats.min, row._unwrappedMs);
    stats.max = Math.max(stats.max, row._unwrappedMs);
    epochStats.set(row._epoch, stats);
  }
  const epochs = [...epochStats.keys()].sort((a, b) => a - b);
  const bases = new Map();
  let previousEnd = 0;
  epochs.forEach((epoch, index) => {
    const stats = epochStats.get(epoch);
    const base = index === 0 ? -stats.min : previousEnd + 500 - stats.min;
    bases.set(epoch, base);
    previousEnd = base + stats.max;
  });
  const apply = (rows) => rows.map((row) => {
    row._timelineMs = Number.isFinite(row._unwrappedMs) ? row._unwrappedMs + (bases.get(row._epoch) || 0) : null;
    return row;
  });
  return { dataRows: apply(dataRows), eventRows: apply(eventRows), epochCount: epochs.length };
}

function compareRows(a, b) {
  const at = Number.isFinite(a._timelineMs) ? a._timelineMs : Infinity;
  const bt = Number.isFinite(b._timelineMs) ? b._timelineMs : Infinity;
  if (at !== bt) return at - bt;
  const as = Number.isFinite(a.seq) ? a.seq : Infinity;
  const bs = Number.isFinite(b.seq) ? b.seq : Infinity;
  if (as !== bs) return as - bs;
  return a._order - b._order;
}

export function inferVehicle(dataRows) {
  let comparable = 0;
  let equal = 0;
  let different = 0;
  for (const row of dataRows) {
    if (!Number.isFinite(row.water_c) || !Number.isFinite(row.press_c)) continue;
    comparable += 1;
    if (Math.abs(row.water_c - row.press_c) <= 0.011) equal += 1;
    else different += 1;
  }
  if (comparable < 10) return { suggested: "unknown", confidence: "none", comparable };
  if (equal / comparable >= 0.98) return { suggested: "umibot", confidence: "hint", comparable };
  if (different / comparable >= 0.6) return { suggested: "triton", confidence: "hint", comparable };
  return { suggested: "unknown", confidence: "none", comparable };
}

export function decodeErrorBits(value) {
  if (!Number.isFinite(value)) return { known: [], unknown: 0 };
  const integer = Math.trunc(value) & 0xffff;
  const known = ERROR_BITS.filter(({ bit }) => (integer & bit) !== 0);
  const knownMask = ERROR_BITS.reduce((mask, item) => mask | item.bit, 0);
  return { known, unknown: integer & ~knownMask & 0xffff };
}

function checkInteger(row, field, min, max, collector) {
  const value = row[field];
  if (value == null) {
    collector.add({
      severity: "critical",
      code: `missing_${field}`,
      title: `${field} が欠損しています`,
      detail: "時系列または状態判定に必要な値です。",
      source: row._source,
      line: row._line
    });
    return false;
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    collector.add({
      severity: "critical",
      code: `invalid_${field}`,
      title: `${field} が許容範囲外です`,
      detail: `${field}=${String(value)}`,
      source: row._source,
      line: row._line
    });
    return false;
  }
  return true;
}

function checkRange(row, field, min, max, collector, severity = "warning") {
  const value = row[field];
  if (value == null) return true;
  if (!Number.isFinite(value) || value < min || value > max) {
    collector.add({
      severity,
      code: `range_${field}`,
      title: `${field} が物理範囲外です`,
      detail: `許容 ${min}〜${max}、実際 ${String(value)}`,
      source: row._source,
      line: row._line
    });
    return false;
  }
  return true;
}

function validateSessionRows(dataRows, eventRows, vehicle, collector, hasData, hasEvent) {
  if (!hasData) {
    collector.add({ severity: "warning", code: "missing_data", title: "DATA.CSVがありません", detail: "イベントと状態帯は表示できますが、センサーグラフは表示できません。" });
  }
  if (!hasEvent) {
    collector.add({ severity: "warning", code: "missing_event", title: "EVENT.CSVがありません", detail: "DATAの状態スナップショットで補完しますが、遷移時刻の精度は下がります。" });
  }

  let previousMaxByEpoch = new Map();
  for (const row of dataRows) {
    if (row.v !== "3.6") {
      collector.add({ severity: "warning", code: "log_version", title: "未検証のログ版です", detail: `v=${row.v ?? "NA"}`, source: row._source, line: row._line });
    }
    checkInteger(row, "seq", 0, 0xffffffff, collector);
    checkInteger(row, "ms", 0, 0xffffffff, collector);
    checkInteger(row, "state", 0, 255, collector);
    checkInteger(row, "phase", 0, 255, collector);
    checkInteger(row, "cycle", 0, 0xffff, collector);
    for (const field of ["vinj", "vexh", "sd", "gps"]) checkInteger(row, field, 0, 1, collector);

    if (![0, 2, 3].includes(row.state)) {
      collector.add({ severity: "warning", code: "unknown_state", title: "Standalone未定義のstateです", detail: `state=${row.state}`, source: row._source, line: row._line });
    }
    if (!Number.isInteger(row.phase) || row.phase < 0 || row.phase > 7) {
      collector.add({ severity: "warning", code: "unknown_phase", title: "未知のphaseです", detail: `phase=${row.phase}`, source: row._source, line: row._line });
    }
    if (row.vinj === 1 && row.vexh === 1) {
      collector.add({ severity: "critical", code: "valve_conflict", title: "両バルブが同時に開いています", detail: "安全上成立しない組み合わせです。", source: row._source, line: row._line });
    }
    if (row.state === 2 && row.phase === 2 && row.vexh !== 1) {
      collector.add({ severity: "warning", code: "phase_valve_mismatch", title: "EXH中に排気弁が閉じています", detail: "DATAと制御状態が一致しません。", source: row._source, line: row._line });
    }
    if (row.state === 2 && row.phase === 5 && row.vinj !== 1) {
      collector.add({ severity: "warning", code: "phase_valve_mismatch", title: "INJ中に注入弁が閉じています", detail: "DATAと制御状態が一致しません。", source: row._source, line: row._line });
    }
    if (row.state === 2 && ![2, 5].includes(row.phase) && (row.vinj === 1 || row.vexh === 1)) {
      collector.add({ severity: "warning", code: "phase_valve_mismatch", title: "フェーズ外でバルブが開いています", detail: `phase=${row.phase}`, source: row._source, line: row._line });
    }

    const depthLimits = vehicle === "triton" ? [-1, 100] : vehicle === "umibot" ? [-5, 300] : [-5, 300];
    const waterLimits = vehicle === "triton" ? [-10, 60] : [-10, 80];
    checkRange(row, "depth_m", depthLimits[0], depthLimits[1], collector, "critical");
    checkRange(row, "max_m", 0, depthLimits[1], collector, "warning");
    checkRange(row, "press_mbar", 0, 65_534, collector, "critical");
    checkRange(row, "water_c", waterLimits[0], waterLimits[1], collector, "warning");
    checkRange(row, "press_c", -10, 80, collector, "warning");
    checkRange(row, "lat", -90, 90, collector, "critical");
    checkRange(row, "lng", -180, 180, collector, "critical");

    if (row.gps === 1 && (!Number.isFinite(row.lat) || !Number.isFinite(row.lng))) {
      collector.add({ severity: "warning", code: "gps_incomplete", title: "gps=1ですが座標が欠損しています", detail: "この点は航跡から除外します。", source: row._source, line: row._line });
    }
    if (row.sd === 0) {
      collector.add({ severity: "warning", code: "sd_not_ready", title: "SDが利用不可です", detail: "失敗行そのものはSDに残らないため、件数は完全な失敗数ではありません。", source: row._source, line: row._line });
    }
    if (Number.isFinite(row.err) && row.err !== 0) {
      const decoded = decodeErrorBits(row.err);
      collector.add({
        severity: "warning",
        code: "firmware_error",
        title: "ファームウェアエラーを記録しています",
        detail: decoded.known.map((item) => item.label).join(" / ") || `err=0x${Math.trunc(row.err).toString(16).toUpperCase()}`,
        source: row._source,
        line: row._line
      });
      if (decoded.unknown !== 0) {
        collector.add({ severity: "warning", code: "unknown_error_bits", title: "未知のエラービットがあります", detail: `unknown=0x${decoded.unknown.toString(16).toUpperCase()}`, source: row._source, line: row._line });
      }
    }

    if (Number.isFinite(row.max_m)) {
      const previousMax = previousMaxByEpoch.get(row._epoch);
      if (Number.isFinite(previousMax) && row.max_m + 0.05 < previousMax) {
        collector.add({ severity: "warning", code: "max_depth_regressed", title: "max_mが減少しています", detail: `${previousMax.toFixed(2)} → ${row.max_m.toFixed(2)} m`, source: row._source, line: row._line });
      }
      previousMaxByEpoch.set(row._epoch, row.max_m);
      if (Number.isFinite(row.depth_m) && row.max_m + 0.05 < row.depth_m) {
        collector.add({ severity: "warning", code: "max_below_depth", title: "max_mが現在深度より浅い値です", detail: `depth=${row.depth_m}, max=${row.max_m}`, source: row._source, line: row._line });
      }
    }

    if (vehicle === "umibot" && Number.isFinite(row.water_c) && Number.isFinite(row.press_c) && Math.abs(row.water_c - row.press_c) > 0.011) {
      collector.add({ severity: "warning", code: "umibot_temperature_mismatch", title: "UmiBotの温度列が一致しません", detail: "現行firmwareではwater_cとpress_cは同じMS5837値です。", source: row._source, line: row._line });
    }
  }

  for (const row of eventRows) {
    if (row.v !== "3.6") {
      collector.add({ severity: "warning", code: "log_version", title: "未検証のログ版です", detail: `v=${row.v ?? "NA"}`, source: row._source, line: row._line });
    }
    checkInteger(row, "seq", 0, 0xffffffff, collector);
    checkInteger(row, "ms", 0, 0xffffffff, collector);
    checkInteger(row, "state", 0, 255, collector);
    checkInteger(row, "phase", 0, 255, collector);
    for (const field of ["vinj", "vexh"]) checkInteger(row, field, 0, 1, collector);
    if (row.vinj === 1 && row.vexh === 1) {
      collector.add({ severity: "critical", code: "valve_conflict", title: "イベントで両バルブ同時ONです", detail: row.event || "EVENT", source: row._source, line: row._line });
    }
    if (row.event && !KNOWN_EVENTS.has(row.event)) {
      collector.add({ severity: "info", code: "unknown_event", title: "未知のイベントを保持しました", detail: row.event, source: row._source, line: row._line });
    }
  }

  for (const row of dataRows) row._kind = "DATA";
  for (const row of eventRows) row._kind = "EVENT";
  const combined = [...dataRows, ...eventRows].sort(compareRows);
  const seenSeq = new Map();
  let previousSeqByEpoch = new Map();
  for (const row of combined) {
    if (!Number.isInteger(row.seq)) continue;
    const key = `${row._epoch}:${row.seq}`;
    if (seenSeq.has(key)) {
      collector.add({ severity: "warning", code: "duplicate_seq", title: "共有seqが重複しています", detail: `seq=${row.seq}`, source: row._source, line: row._line });
    }
    seenSeq.set(key, row);
    const previous = previousSeqByEpoch.get(row._epoch);
    if (Number.isInteger(previous) && row.seq < previous) {
      collector.add({ severity: "warning", code: "out_of_order_seq", title: "seq順が逆転しています", detail: `${previous} → ${row.seq}`, source: row._source, line: row._line });
    }
    previousSeqByEpoch.set(row._epoch, Math.max(previous ?? -Infinity, row.seq));
  }

  const byEpoch = new Map();
  for (const row of dataRows) {
    if (!Number.isFinite(row._timelineMs)) continue;
    const list = byEpoch.get(row._epoch) || [];
    list.push(row);
    byEpoch.set(row._epoch, list);
  }
  for (const list of byEpoch.values()) {
    list.sort(compareRows);
    for (let index = 1; index < list.length; index += 1) {
      const previous = list[index - 1];
      const row = list[index];
      const gap = row._timelineMs - previous._timelineMs;
      if (previous.state === 2 && row.state === 2 && gap > 1_500) {
        collector.add({ severity: "warning", code: "sampling_gap", title: "実行中のDATAに欠落区間があります", detail: `${(gap / 1000).toFixed(1)} 秒`, source: row._source, line: row._line });
      }
    }
  }
}

function buildSegments(points, valueFor, endMs) {
  const usable = points.filter((point) => Number.isFinite(point._timelineMs)).sort(compareRows);
  if (usable.length === 0) return [];
  const segments = [];
  let current = null;
  for (const point of usable) {
    const value = valueFor(point);
    if (value == null) continue;
    const key = JSON.stringify(value);
    if (!current || current.key !== key) {
      if (current) segments.push(current);
      current = { key, value, startMs: point._timelineMs, endMs: point._timelineMs, source: point._kind || "DATA" };
    } else {
      current.endMs = point._timelineMs;
    }
  }
  if (current) segments.push(current);
  for (let index = 0; index < segments.length - 1; index += 1) segments[index].endMs = segments[index + 1].startMs;
  if (segments.length > 0) segments[segments.length - 1].endMs = Math.max(segments.at(-1).endMs, endMs);
  return segments;
}

function compactSegments(segments, maxSegments = 1_200) {
  if (segments.length <= maxSegments) return segments;
  const size = Math.ceil(segments.length / maxSegments);
  const compacted = [];
  for (let start = 0; start < segments.length; start += size) {
    const bucket = segments.slice(start, start + size);
    let representative = bucket[0];
    for (const segment of bucket) {
      if (segment.endMs - segment.startMs > representative.endMs - representative.startMs) representative = segment;
    }
    compacted.push({
      ...representative,
      startMs: bucket[0].startMs,
      endMs: bucket.at(-1).endMs,
      approximated: true
    });
  }
  return compacted;
}

function computeSummary(dataRows, eventRows, issues) {
  let firstMs = Infinity;
  let lastMs = -Infinity;
  let validDepthCount = 0;
  let maxDepth = -Infinity;
  let tempCount = 0;
  let tempSum = 0;
  let tempMin = Infinity;
  let tempMax = -Infinity;
  let coordinateSamples = 0;
  const observedCycles = new Set();

  for (const list of [dataRows, eventRows]) {
    for (const row of list) {
      if (Number.isFinite(row._timelineMs)) {
        firstMs = Math.min(firstMs, row._timelineMs);
        lastMs = Math.max(lastMs, row._timelineMs);
      }
    }
  }
  for (const row of dataRows) {
    if (Number.isFinite(row.depth_m)) {
      validDepthCount += 1;
      maxDepth = Math.max(maxDepth, row.depth_m);
      if (Number.isFinite(row.max_m)) maxDepth = Math.max(maxDepth, row.max_m);
    }
    if (Number.isFinite(row.water_c)) {
      tempCount += 1;
      tempSum += row.water_c;
      tempMin = Math.min(tempMin, row.water_c);
      tempMax = Math.max(tempMax, row.water_c);
    }
    if (row.gps === 1 && Number.isFinite(row.lat) && Number.isFinite(row.lng) && Math.abs(row.lat) <= 90 && Math.abs(row.lng) <= 180) coordinateSamples += 1;
    if (row.state === 2 && Number.isInteger(row.cycle)) observedCycles.add(`${row._epoch}:${row.cycle}`);
  }
  const severityCounts = { critical: 0, warning: 0, info: 0 };
  for (const item of issues) severityCounts[item.severity] = (severityCounts[item.severity] || 0) + item.count;

  return {
    durationMs: Number.isFinite(firstMs) && Number.isFinite(lastMs) ? Math.max(0, lastMs - firstMs) : 0,
    maxDepth: validDepthCount > 0 ? maxDepth : null,
    temperature: tempCount > 0 ? { min: tempMin, max: tempMax, average: tempSum / tempCount } : null,
    coordinateSamples,
    cyclesObserved: observedCycles.size,
    dataRows: dataRows.length,
    eventRows: eventRows.length,
    severityCounts
  };
}

function mergeTimelinePoints(dataRows, eventRows) {
  for (const row of dataRows) { row._kind = "DATA"; row._priority = 0; }
  for (const row of eventRows) { row._kind = "EVENT"; row._priority = 1; }
  return [...dataRows, ...eventRows]
    .filter((row) => Number.isFinite(row._timelineMs))
    .sort((a, b) => compareRows(a, b) || a._priority - b._priority);
}

export function createSession({ name, data = null, event = null, vehicleHint = "unknown" }) {
  const collector = createIssueCollector([...(data?.issues || []), ...(event?.issues || [])]);
  const dataAnnotated = annotateTimeline(data?.rows || [], "DATA", collector);
  const eventAnnotated = annotateTimeline(event?.rows || [], "EVENT", collector);
  const aligned = alignEpochs(dataAnnotated, eventAnnotated);
  const dataRows = [...aligned.dataRows].sort(compareRows);
  const eventRows = [...aligned.eventRows].sort(compareRows);
  const inference = inferVehicle(dataRows);
  const vehicle = ["triton", "umibot"].includes(vehicleHint) ? vehicleHint : "unknown";

  if (vehicle === "unknown") {
    collector.add({
      severity: "warning",
      code: "vehicle_required",
      title: "機種を確認してください",
      detail: inference.suggested === "unknown"
        ? "v3.6 CSVには機種IDがないため自動確定できません。"
        : `列の傾向は${inference.suggested === "triton" ? "Triton-3" : "UmiBot"}に似ていますが、確定はできません。`
    });
  }

  validateSessionRows(dataRows, eventRows, vehicle, collector, Boolean(data), Boolean(event));
  const allPoints = mergeTimelinePoints(dataRows, eventRows);
  const endMs = allPoints.reduce((max, row) => Math.max(max, row._timelineMs), 0);
  const rawStateSegments = buildSegments(allPoints, (row) => (
    Number.isFinite(row.state) && Number.isFinite(row.phase) ? { state: row.state, phase: row.phase } : null
  ), endMs);
  const rawValveSegments = buildSegments(allPoints, (row) => (
    Number.isFinite(row.vinj) && Number.isFinite(row.vexh) ? { vinj: row.vinj, vexh: row.vexh } : null
  ), endMs);
  if (rawStateSegments.length > 1_200 || rawValveSegments.length > 1_200) {
    collector.add({
      severity: "warning",
      code: "timeline_compacted",
      title: "状態帯を表示用に圧縮しました",
      detail: "極端に細かい状態変化で画面が停止しないよう、代表区間へ集約しています。元行の診断・集計は保持しています。"
    });
  }
  const stateSegments = compactSegments(rawStateSegments);
  const valveSegments = compactSegments(rawValveSegments);
  const issues = collector.finish();

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: name || "ログセッション",
    vehicle,
    inference,
    data,
    event,
    dataRows,
    eventRows,
    epochCount: aligned.epochCount,
    stateSegments,
    valveSegments,
    issues,
    summary: computeSummary(dataRows, eventRows, issues)
  };
}

export function rebuildSessionVehicle(session, vehicle) {
  return createSession({ name: session.name, data: session.data, event: session.event, vehicleHint: vehicle });
}

export function downsampleSeries(rows, field, maxPoints = 900) {
  const points = rows
    .filter((row) => Number.isFinite(row._timelineMs) && Number.isFinite(row[field]))
    .map((row) => ({ x: row._timelineMs, y: row[field], row }));
  if (points.length <= maxPoints) return points;

  const bucketCount = Math.max(1, Math.floor(maxPoints / 4));
  const bucketSize = Math.ceil(points.length / bucketCount);
  const output = [];
  for (let start = 0; start < points.length; start += bucketSize) {
    const bucket = points.slice(start, start + bucketSize);
    let min = bucket[0];
    let max = bucket[0];
    for (const point of bucket) {
      if (point.y < min.y) min = point;
      if (point.y > max.y) max = point;
    }
    const candidates = [bucket[0], min, max, bucket.at(-1)].sort((a, b) => a.x - b.x);
    for (const point of candidates) {
      if (output.at(-1)?.x !== point.x || output.at(-1)?.y !== point.y) output.push(point);
    }
  }
  return output.slice(0, maxPoints);
}

export function cycleSeries(dataRows, field = "depth_m") {
  const groups = new Map();
  for (const row of dataRows) {
    if (row.state !== 2 || !Number.isInteger(row.cycle) || !Number.isFinite(row[field]) || !Number.isFinite(row._timelineMs)) continue;
    const key = `${row._epoch}:${row.cycle}`;
    if (!groups.has(key) && groups.size >= 256) continue;
    const group = groups.get(key) || { key, epoch: row._epoch, cycle: row.cycle, startMs: row._timelineMs, points: [] };
    group.startMs = Math.min(group.startMs, row._timelineMs);
    group.points.push({ x: row._timelineMs, y: row[field] });
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    points: group.points.map((point) => ({ x: point.x - group.startMs, y: point.y }))
  })).sort((a, b) => a.startMs - b.startMs);
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "—";
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}時間 ${String(minutes).padStart(2, "0")}分 ${String(seconds).padStart(2, "0")}秒`;
  return `${minutes}分 ${String(seconds).padStart(2, "0")}秒`;
}

export function groupParsedFiles(files) {
  const byFolder = new Map();
  for (const file of files) {
    if (!file.parsed?.kind) continue;
    const path = file.path || file.name || "CSV";
    const parts = path.split("/");
    const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : "選択したファイル";
    const group = byFolder.get(folder) || { folder, data: [], event: [] };
    group[file.parsed.kind.toLowerCase()].push(file.parsed);
    byFolder.set(folder, group);
  }

  const sessions = [];
  for (const group of byFolder.values()) {
    if (group.data.length > 1 || group.event.length > 1) {
      const ambiguity = {
        severity: "warning",
        code: "ambiguous_pair",
        title: "DATA/EVENTの組み合わせが曖昧です",
        detail: "同じフォルダ扱いのファイルが複数あるため、自動ペアリングせず個別に表示します。"
      };
      for (const parsed of group.data) {
        sessions.push(createSession({
          name: parsed.source,
          data: { ...parsed, issues: [...(parsed.issues || []), ambiguity] },
          vehicleHint: "unknown"
        }));
      }
      for (const parsed of group.event) {
        sessions.push(createSession({
          name: parsed.source,
          event: { ...parsed, issues: [...(parsed.issues || []), ambiguity] },
          vehicleHint: "unknown"
        }));
      }
      continue;
    }
    const count = Math.max(group.data.length, group.event.length, 1);
    for (let index = 0; index < count; index += 1) {
      const suffix = count > 1 ? ` (${index + 1}/${count})` : "";
      sessions.push(createSession({
        name: `${group.folder}${suffix}`,
        data: group.data[index] || null,
        event: group.event[index] || null,
        vehicleHint: "unknown"
      }));
    }
  }
  return sessions;
}
