import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  MAX_FILE_BYTES,
  PHASE_LABELS,
  STATE_LABELS,
  createSession,
  cycleSeries,
  downsampleSeries,
  formatDuration,
  parseLogText,
  rebuildSessionVehicle
} from "./log-core.js";
import { createDemo } from "./sample-data.js";

const SERIES_COLORS = ["var(--series-blue)", "var(--series-orange)", "var(--series-green)", "var(--series-purple)", "var(--series-gold)", "var(--series-red)"];
const DEPTH_SERIES = [{ field: "depth_m", label: "深度", color: "var(--series-blue)" }];
const PRESSURE_SERIES = [{ field: "press_mbar", label: "周囲圧力", color: "var(--series-orange)" }];
const TEMPERATURE_SERIES = {
  umibot: [{ field: "water_c", label: "MS5837温度", color: "var(--series-green)" }],
  triton: [
    { field: "water_c", label: "TSYS01 水温", color: "var(--series-green)" },
    { field: "press_c", label: "MS5837 内蔵温度", color: "var(--series-purple)", dashed: true }
  ],
  unknown: [
    { field: "water_c", label: "water_c", color: "var(--series-green)" },
    { field: "press_c", label: "press_c", color: "var(--series-purple)", dashed: true }
  ]
};
const PHASE_COLORS = {
  0: "#3f4a5d",
  1: "#263b8e",
  2: "#8a310b",
  3: "#07536d",
  4: "#592982",
  5: "#006044",
  6: "#164f8e",
  7: "#1b633d"
};

function makeDemoSession(vehicle, adversarial) {
  const demo = createDemo(vehicle, adversarial);
  const data = parseLogText(demo.dataText, `${demo.name}/DATA.CSV`);
  const event = parseLogText(demo.eventText, `${demo.name}/EVENT.CSV`);
  return createSession({ name: demo.name, data, event, vehicleHint: demo.vehicle });
}

function safeStorageGet(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage may be disabled. Theme still works for the current page.
  }
}

function formatNumber(value, digits = 2, suffix = "") {
  return Number.isFinite(value) ? `${value.toFixed(digits)}${suffix}` : "N/A";
}

function formatElapsed(ms) {
  if (!Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function vehicleName(vehicle) {
  if (vehicle === "triton") return "Triton-3";
  if (vehicle === "umibot") return "UmiBot";
  return "機種未確認";
}

function issueVerdict(summary) {
  if (summary.severityCounts.critical > 0) return { tone: "danger", label: "危険な入力", detail: "隔離または要調査のデータがあります" };
  if (summary.severityCounts.warning > 0) return { tone: "warning", label: "要確認", detail: "解釈上の注意があります" };
  return { tone: "good", label: "検証OK", detail: "既知の矛盾は検出されませんでした" };
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function lowerBound(rows, value) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((rows[mid]._timelineMs ?? Infinity) < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

function upperBound(rows, value) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((rows[mid]._timelineMs ?? Infinity) <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

function rowsInWindow(rows, startMs, endMs) {
  if (rows.length === 0) return [];
  return rows.slice(lowerBound(rows, startMs), upperBound(rows, endMs));
}

function nearestRow(rows, value) {
  if (rows.length === 0 || !Number.isFinite(value)) return null;
  const index = lowerBound(rows, value);
  const before = rows[Math.max(0, index - 1)];
  const after = rows[Math.min(rows.length - 1, index)];
  if (!before) return after || null;
  if (!after) return before;
  return Math.abs(before._timelineMs - value) <= Math.abs(after._timelineMs - value) ? before : after;
}

function compactUiSegments(segments, limit = 1_200) {
  if (segments.length <= limit) return segments;
  const size = Math.ceil(segments.length / limit);
  const compacted = [];
  for (let start = 0; start < segments.length; start += size) {
    const bucket = segments.slice(start, start + size);
    let representative = bucket[0];
    for (const segment of bucket) {
      if (segment.endMs - segment.startMs > representative.endMs - representative.startMs) representative = segment;
    }
    compacted.push({ ...representative, startMs: bucket[0].startMs, endMs: bucket.at(-1).endMs, approximated: true });
  }
  return compacted;
}

function buildWindowSegments(dataRows, eventRows, startMs, endMs, valueFor) {
  const startData = Math.max(0, lowerBound(dataRows, startMs) - 1);
  const startEvent = Math.max(0, lowerBound(eventRows, startMs) - 1);
  const endData = upperBound(dataRows, endMs);
  const endEvent = upperBound(eventRows, endMs);
  let dataIndex = startData;
  let eventIndex = startEvent;
  let segments = [];
  let current = null;
  while (dataIndex < endData || eventIndex < endEvent) {
    const dataPoint = dataRows[dataIndex];
    const eventPoint = eventRows[eventIndex];
    let point;
    if (!eventPoint) {
      point = dataPoint;
      dataIndex += 1;
    } else if (!dataPoint) {
      point = eventPoint;
      eventIndex += 1;
    } else {
      const comparison = (dataPoint._timelineMs - eventPoint._timelineMs) || ((dataPoint.seq ?? 0) - (eventPoint.seq ?? 0)) || -1;
      if (comparison <= 0) { point = dataPoint; dataIndex += 1; }
      else { point = eventPoint; eventIndex += 1; }
    }
    const value = valueFor(point);
    if (value == null) continue;
    const key = JSON.stringify(value);
    const time = Math.min(endMs, Math.max(startMs, point._timelineMs));
    if (!current || current.key !== key) {
      if (current && current.startMs < time) {
        current.endMs = time;
        segments.push(current);
      }
      current = { key, value, startMs: time, endMs: time, source: point._kind || (point._priority ? "EVENT" : "DATA") };
      if (segments.length > 2_400) segments = compactUiSegments(segments);
    }
  }
  if (current) {
    current.endMs = Math.max(current.startMs, endMs);
    segments.push(current);
  }
  return compactUiSegments(segments.filter((segment) => segment.endMs >= startMs && segment.startMs <= endMs));
}

function getTimelineBounds(session) {
  const firstFinite = (rows) => {
    for (const row of rows) if (Number.isFinite(row._timelineMs)) return row._timelineMs;
    return null;
  };
  const lastFinite = (rows) => {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (Number.isFinite(rows[index]._timelineMs)) return rows[index]._timelineMs;
    }
    return null;
  };
  const candidates = [firstFinite(session.dataRows), firstFinite(session.eventRows), lastFinite(session.dataRows), lastFinite(session.eventRows)].filter(Number.isFinite);
  if (candidates.length === 0) return { min: 0, max: 1 };
  const min = Math.min(...candidates);
  const max = Math.max(...candidates);
  return { min, max: max > min ? max : min + 1 };
}

function epochMarkersFor(session) {
  const markers = new Map();
  for (const rows of [session.dataRows, session.eventRows]) {
    for (const row of rows) {
      if (!Number.isFinite(row._timelineMs) || !Number.isInteger(row._epoch)) continue;
      const current = markers.get(row._epoch);
      if (!Number.isFinite(current) || row._timelineMs < current) markers.set(row._epoch, row._timelineMs);
    }
  }
  return [...markers.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([epoch, x]) => ({ x, label: `起動 ${epoch + 1}`, kind: "epoch" }));
}

function MetricCard({ label, value, note, tone = "" }) {
  return (
    <div className={`metric-card ${tone}`}>
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value}</strong>
      {note && <span className="metric-note">{note}</span>}
    </div>
  );
}

function LineChart({ title, description, rows, series, invertY = false, unit = "", cursorMs = null, onCursorChange, markers = [] }) {
  const chartId = `chart-${useId().replaceAll(":", "")}`;
  const width = 1000;
  const height = 280;
  const plot = { left: 72, right: 980, top: 28, bottom: 226 };
  const prepared = useMemo(() => series.map((item) => ({
    ...item,
    points: downsampleSeries(rows, item.field, Math.max(160, Math.floor(900 / series.length)))
  })), [rows, series]);
  const allPoints = prepared.flatMap((item) => item.points);

  if (allPoints.length === 0) {
    return (
      <section className="chart-card" aria-label={title}>
        <div className="card-heading"><h3>{title}</h3></div>
        <div className="chart-empty">有効なデータがありません</div>
      </section>
    );
  }

  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const point of allPoints) {
    xMin = Math.min(xMin, point.x);
    xMax = Math.max(xMax, point.x);
    yMin = Math.min(yMin, point.y);
    yMax = Math.max(yMax, point.y);
  }
  if (xMin === xMax) xMax += 1;
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const yPad = (yMax - yMin) * 0.08;
  yMin -= yPad;
  yMax += yPad;
  if (invertY) yMin = Math.min(0, yMin);

  const xFor = (value) => plot.left + ((value - xMin) / (xMax - xMin)) * (plot.right - plot.left);
  const yFor = (value) => {
    const ratio = (value - yMin) / (yMax - yMin);
    return invertY
      ? plot.top + ratio * (plot.bottom - plot.top)
      : plot.bottom - ratio * (plot.bottom - plot.top);
  };
  const pathFor = (points) => points.map((point, index) => `${index === 0 ? "M" : "L"}${xFor(point.x).toFixed(2)},${yFor(point.y).toFixed(2)}`).join(" ");
  const epochChunks = (points) => {
    const chunks = [];
    let current = [];
    let epoch = null;
    for (const point of points) {
      const nextEpoch = point.row?._epoch ?? 0;
      if (current.length > 0 && nextEpoch !== epoch) {
        chunks.push(current);
        current = [];
      }
      current.push(point);
      epoch = nextEpoch;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  };
  const cursorVisible = Number.isFinite(cursorMs) && cursorMs >= xMin && cursorMs <= xMax;
  const cursorX = cursorVisible ? xFor(cursorMs) : null;
  const cursorPoints = cursorVisible ? prepared.map((item) => {
    if (item.points.length === 0) return null;
    let closest = item.points[0];
    for (const point of item.points) {
      if (Math.abs(point.x - cursorMs) < Math.abs(closest.x - cursorMs)) closest = point;
    }
    return { ...closest, color: item.color };
  }).filter(Boolean) : [];
  const visibleMarkers = markers.filter((marker) => marker.x >= xMin && marker.x <= xMax).slice(0, 160);
  const updateCursor = (event) => {
    if (!onCursorChange) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const viewX = ((event.clientX - bounds.left) / bounds.width) * width;
    if (viewX < plot.left || viewX > plot.right) return;
    onCursorChange(xMin + ((viewX - plot.left) / (plot.right - plot.left)) * (xMax - xMin));
  };

  return (
    <section className="chart-card">
      <div className="card-heading chart-heading">
        <div><h3>{title}</h3><p>{description}</p></div>
        <div className="legend" aria-label="系列">
          {prepared.map((item, index) => (
            <span className="legend-item" key={item.field}>
              <span className="legend-line" style={{ background: item.color || SERIES_COLORS[index], opacity: item.dashed ? 0.65 : 1 }} />
              {item.label}
            </span>
          ))}
          {cursorVisible && <span className="cursor-readout">選択 {formatElapsed(cursorMs)}</span>}
        </div>
      </div>
      <div className="chart-wrap">
        <svg className="line-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${chartId}-title`}>
          <title id={`${chartId}-title`}>{title}</title>
          <desc>{description}。描画点は長時間ログでも見やすいように間引いています。</desc>
          {[0, 1, 2, 3, 4].map((tick) => {
            const ratio = tick / 4;
            const y = plot.top + ratio * (plot.bottom - plot.top);
            const value = invertY ? yMin + ratio * (yMax - yMin) : yMax - ratio * (yMax - yMin);
            return (
              <g key={`y-${tick}`}>
                <line className="chart-grid" x1={plot.left} y1={y} x2={plot.right} y2={y} />
                <text className="chart-axis-label" x={plot.left - 12} y={y + 4} textAnchor="end">{value.toFixed(Math.abs(value) >= 100 ? 0 : 1)}{unit}</text>
              </g>
            );
          })}
          {[0, 1, 2, 3, 4, 5].map((tick) => {
            const ratio = tick / 5;
            const x = plot.left + ratio * (plot.right - plot.left);
            const value = xMin + ratio * (xMax - xMin);
            return (
              <g key={`x-${tick}`}>
                <line className="chart-grid vertical" x1={x} y1={plot.top} x2={x} y2={plot.bottom} />
                <text className="chart-axis-label" x={x} y={plot.bottom + 27} textAnchor="middle">{formatElapsed(value)}</text>
              </g>
            );
          })}
          {visibleMarkers.map((marker, index) => marker.kind === "epoch" ? (
            <g key={`${marker.kind}-${marker.x}-${index}`}>
              <line className="epoch-line" x1={xFor(marker.x)} y1={plot.top} x2={xFor(marker.x)} y2={plot.bottom} />
              <text className="epoch-label" x={xFor(marker.x) + 5} y={plot.top + 11}>{marker.label}</text>
            </g>
          ) : (
            <g key={`${marker.kind}-${marker.x}-${index}`}>
              <title>{marker.label}</title>
              <line className="event-marker" x1={xFor(marker.x)} y1={plot.top} x2={xFor(marker.x)} y2={plot.top + 12} />
            </g>
          ))}
          {prepared.flatMap((item, index) => epochChunks(item.points).map((points, chunkIndex) => (
            <path
              key={`${item.field}-${chunkIndex}`}
              d={pathFor(points)}
              fill="none"
              stroke={item.color || SERIES_COLORS[index]}
              strokeWidth="3"
              strokeDasharray={item.dashed ? "10 8" : undefined}
              vectorEffect="non-scaling-stroke"
            />
          )))}
          <rect
            className="chart-hit-area"
            x={plot.left}
            y={plot.top}
            width={plot.right - plot.left}
            height={plot.bottom - plot.top}
            onPointerMove={updateCursor}
            onPointerDown={updateCursor}
          />
          {cursorVisible && <line className="chart-cursor" x1={cursorX} y1={plot.top} x2={cursorX} y2={plot.bottom} />}
          {cursorPoints.map((point, index) => <circle key={`${point.x}-${index}`} className="chart-cursor-point" cx={xFor(point.x)} cy={yFor(point.y)} r="4" style={{ fill: point.color || SERIES_COLORS[index] }} />)}
          <line className="chart-axis" x1={plot.left} y1={plot.bottom} x2={plot.right} y2={plot.bottom} />
          <text className="chart-axis-caption" x={(plot.left + plot.right) / 2} y={height - 7} textAnchor="middle">セッション相対時刻（起動境界は実時間の連続を意味しません）</text>
        </svg>
      </div>
    </section>
  );
}

function Timeline({ session, startMs, endMs, cursorMs, onCursorChange, markers = [] }) {
  const minMs = Number.isFinite(startMs) ? startMs : 0;
  const maxMs = Number.isFinite(endMs) && endMs > minMs ? endMs : Math.max(1, session.summary.durationMs);
  const duration = Math.max(1, maxMs - minMs);
  const fullBounds = useMemo(() => getTimelineBounds(session), [session]);
  const stateSegments = useMemo(() => minMs <= fullBounds.min && maxMs >= fullBounds.max ? session.stateSegments : buildWindowSegments(
    session.dataRows,
    session.eventRows,
    minMs,
    maxMs,
    (row) => Number.isFinite(row.state) && Number.isFinite(row.phase) ? { state: row.state, phase: row.phase } : null
  ), [session, minMs, maxMs, fullBounds]);
  const valveSegments = useMemo(() => minMs <= fullBounds.min && maxMs >= fullBounds.max ? session.valveSegments : buildWindowSegments(
    session.dataRows,
    session.eventRows,
    minMs,
    maxMs,
    (row) => Number.isFinite(row.vinj) && Number.isFinite(row.vexh) ? { vinj: row.vinj, vexh: row.vexh } : null
  ), [session, minMs, maxMs, fullBounds]);
  const segmentStyle = (segment) => ({
    left: `${((segment.startMs - minMs) / duration) * 100}%`,
    width: `${Math.max(0.15, ((segment.endMs - segment.startMs) / duration) * 100)}%`
  });
  const markerStyle = (value) => ({ left: `${((value - minMs) / duration) * 100}%` });
  const visibleMarkers = markers.filter((marker) => marker.x >= minMs && marker.x <= maxMs);
  const visibleEvents = rowsInWindow(session.eventRows, minMs, maxMs).filter((_, index, rows) => {
    if (rows.length <= 120) return true;
    return index % Math.ceil(rows.length / 120) === 0;
  });
  const selectFromLane = (event) => {
    if (!onCursorChange) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    onCursorChange(minMs + ratio * duration);
  };

  return (
    <section className="timeline-card">
      <div className="card-heading chart-heading">
        <div>
          <h3>制御タイムライン</h3>
          <p>EVENTを優先し、欠けた区間は500ms周期のDATAで補完します。</p>
        </div>
        <span className="source-chip">{session.eventRows.length ? "EVENT + DATA" : "DATA補完のみ"}</span>
      </div>
      <div className="timeline-group" aria-label="フェーズの時系列">
        <span className="lane-label">フェーズ</span>
        <div className="timeline-lane phase-lane" onPointerMove={selectFromLane} onPointerDown={selectFromLane}>
          {stateSegments.map((segment, index) => {
            const phase = segment.value.phase;
            const label = PHASE_LABELS[phase] || `P${phase}`;
            return (
              <span
                key={`${segment.startMs}-${index}`}
                className="timeline-segment"
                style={{ ...segmentStyle(segment), background: PHASE_COLORS[phase] || "#6b7280" }}
                title={`${STATE_LABELS[segment.value.state] || `state ${segment.value.state}`} / ${label} · ${formatElapsed(segment.startMs)}〜${formatElapsed(segment.endMs)}`}
              >
                <span>{label}</span>
              </span>
            );
          })}
          {visibleEvents.map((event, index) => <span key={`event-${event.seq}-${index}`} className="timeline-event-pin" style={markerStyle(event._timelineMs)} title={`${event.event || "EVENT"} · ${formatElapsed(event._timelineMs)} · ${String(event.msg || "").slice(0, 180)}`} />)}
          {visibleMarkers.map((marker) => <span key={`${marker.kind}-${marker.x}`} className="timeline-epoch-line" style={markerStyle(marker.x)} title={marker.label} />)}
          {Number.isFinite(cursorMs) && cursorMs >= minMs && cursorMs <= maxMs && <span className="timeline-cursor" style={markerStyle(cursorMs)} />}
        </div>
      </div>
      <div className="timeline-group" aria-label="バルブ状態の時系列">
        <span className="lane-label">バルブ</span>
        <div className="timeline-lane valve-lane" onPointerMove={selectFromLane} onPointerDown={selectFromLane}>
          {valveSegments.map((segment, index) => {
            const { vinj, vexh } = segment.value;
            const conflict = vinj === 1 && vexh === 1;
            const label = conflict ? "CONFLICT" : vinj === 1 ? "INJ" : vexh === 1 ? "EXH" : "CLOSED";
            const tone = conflict ? "conflict" : vinj === 1 ? "inject" : vexh === 1 ? "exhaust" : "closed";
            return (
              <span
                key={`${segment.startMs}-${index}`}
                className={`timeline-segment ${tone}`}
                style={segmentStyle(segment)}
                title={`${label} · ${formatElapsed(segment.startMs)}〜${formatElapsed(segment.endMs)}`}
              >
                <span>{label}</span>
              </span>
            );
          })}
          {visibleMarkers.map((marker) => <span key={`${marker.kind}-${marker.x}`} className="timeline-epoch-line" style={markerStyle(marker.x)} title={marker.label} />)}
          {Number.isFinite(cursorMs) && cursorMs >= minMs && cursorMs <= maxMs && <span className="timeline-cursor" style={markerStyle(cursorMs)} />}
        </div>
      </div>
      <div className="timeline-ticks" aria-hidden="true"><span>{formatElapsed(minMs)}</span><span>{formatElapsed(minMs + duration / 2)}</span><span>{formatElapsed(maxMs)}</span></div>
    </section>
  );
}

function GpsPlot({ rows, cursorMs }) {
  const points = useMemo(() => {
    const valid = rows.filter((row) => row.gps === 1 && Number.isFinite(row.lat) && Number.isFinite(row.lng) && Math.abs(row.lat) <= 90 && Math.abs(row.lng) <= 180);
    const step = Math.max(1, Math.ceil(valid.length / 500));
    return valid.filter((_, index) => index % step === 0 || index === valid.length - 1);
  }, [rows]);
  if (points.length === 0) return <div className="chart-empty gps-empty">有効な保持座標がありません</div>;

  const lats = points.map((row) => row.lat);
  const lngs = points.map((row) => row.lng);
  let latMin = Math.min(...lats); let latMax = Math.max(...lats);
  let lngMin = Math.min(...lngs); let lngMax = Math.max(...lngs);
  if (latMin === latMax) { latMin -= 0.0001; latMax += 0.0001; }
  if (lngMin === lngMax) { lngMin -= 0.0001; lngMax += 0.0001; }
  const x = (lng) => 34 + ((lng - lngMin) / (lngMax - lngMin)) * 532;
  const y = (lat) => 226 - ((lat - latMin) / (latMax - latMin)) * 192;
  const path = points.map((row, index) => `${index ? "L" : "M"}${x(row.lng).toFixed(2)},${y(row.lat).toFixed(2)}`).join(" ");
  const selected = nearestRow(points, cursorMs);
  return (
    <svg className="gps-plot" viewBox="0 0 600 260" role="img" aria-label="GPS保持座標の簡易軌跡">
      <title>GPS保持座標の簡易軌跡</title>
      <desc>緑が最初、赤が最後の保持座標です。gpsは現在のfixではなく、一度取得した座標を保持する場合があります。</desc>
      <rect x="20" y="20" width="560" height="220" rx="16" className="gps-bg" />
      {[1, 2, 3, 4].map((value) => <line key={`h${value}`} x1="20" y1={20 + value * 44} x2="580" y2={20 + value * 44} className="chart-grid" />)}
      {[1, 2, 3, 4].map((value) => <line key={`v${value}`} x1={20 + value * 112} y1="20" x2={20 + value * 112} y2="240" className="chart-grid" />)}
      <path d={path} fill="none" stroke="#1677ff" strokeWidth="3" vectorEffect="non-scaling-stroke" />
      <circle cx={x(points[0].lng)} cy={y(points[0].lat)} r="7" fill="#16845b" />
      <circle cx={x(points.at(-1).lng)} cy={y(points.at(-1).lat)} r="7" fill="#d7475b" />
      {selected && <circle className="gps-selected" cx={x(selected.lng)} cy={y(selected.lat)} r="9" fill="none" stroke="#f2c500" strokeWidth="4" />}
      <text x="32" y="252" className="chart-axis-label">offline plot · CSVは外部送信されません</text>
    </svg>
  );
}

function OnlineGpsMap({ rows, cursorMs, onStatus, onUnavailable }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const cursorRef = useRef(null);
  const points = useMemo(() => {
    const valid = rows.filter((row) => row.gps === 1 && Number.isFinite(row.lat) && Number.isFinite(row.lng) && Math.abs(row.lat) <= 90 && Math.abs(row.lng) <= 180);
    const step = Math.max(1, Math.ceil(valid.length / 4_000));
    return valid.filter((_, index) => index % step === 0 || index === valid.length - 1);
  }, [rows]);

  useEffect(() => {
    if (!containerRef.current || points.length === 0) return undefined;
    onStatus?.("OpenStreetMapを読み込み中");
    let map;
    let resizeObserver;
    let fallbackTimer;
    let loadedTiles = 0;
    let failedTiles = 0;
    try {
      map = L.map(containerRef.current, { zoomControl: true, attributionControl: true, preferCanvas: true });
      const tileLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        crossOrigin: true,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
      });
      tileLayer.on("tileload", () => {
        loadedTiles += 1;
        if (fallbackTimer) window.clearTimeout(fallbackTimer);
        onStatus?.("OpenStreetMap オンライン表示");
      });
      tileLayer.on("tileerror", () => {
        failedTiles += 1;
        if (loadedTiles > 0 || failedTiles < 4 || fallbackTimer) return;
        onStatus?.("地図タイルを取得できないため簡易表示へ切り替えます");
        fallbackTimer = window.setTimeout(() => onUnavailable?.(), 700);
      });
      tileLayer.addTo(map);
      const latLngs = points.map((row) => [row.lat, row.lng]);
      L.polyline(latLngs, { color: "#0647c8", weight: 4, opacity: 1 }).addTo(map);
      L.circleMarker(latLngs[0], { radius: 7, color: "#ffffff", weight: 3, fillColor: "#006b3f", fillOpacity: 1 }).addTo(map).bindTooltip("開始");
      L.circleMarker(latLngs.at(-1), { radius: 7, color: "#ffffff", weight: 3, fillColor: "#b11735", fillOpacity: 1 }).addTo(map).bindTooltip("終了");
      cursorRef.current = L.circleMarker(latLngs[0], { radius: 10, color: "#ffcc00", weight: 4, fillOpacity: 0, opacity: 0 }).addTo(map);
      const bounds = L.latLngBounds(latLngs);
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24], maxZoom: points.length === 1 ? 16 : 17 });
      mapRef.current = map;
      window.setTimeout(() => map?.invalidateSize({ pan: false }), 0);
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => map?.invalidateSize({ pan: false }));
        resizeObserver.observe(containerRef.current);
      }
    } catch {
      onStatus?.("地図を初期化できないため簡易表示へ切り替えます");
      fallbackTimer = window.setTimeout(() => onUnavailable?.(), 0);
    }
    return () => {
      if (fallbackTimer) window.clearTimeout(fallbackTimer);
      resizeObserver?.disconnect();
      map?.remove();
      mapRef.current = null;
      cursorRef.current = null;
    };
  }, [points, onStatus, onUnavailable]);

  useEffect(() => {
    if (!cursorRef.current) return;
    const row = nearestRow(points, cursorMs);
    if (!row) {
      cursorRef.current.setStyle({ opacity: 0 });
      return;
    }
    cursorRef.current.setLatLng([row.lat, row.lng]);
    cursorRef.current.setStyle({ opacity: 1 });
  }, [cursorMs, points]);

  if (points.length === 0) return <div className="chart-empty gps-empty">この表示区間に有効な保持座標がありません</div>;
  return <div ref={containerRef} className="online-gps-map" aria-label="OpenStreetMap上のGPS保持座標" />;
}

function GpsPanel({ rows, cursorMs, sessionId }) {
  const [mode, setMode] = useState("online");
  const [status, setStatus] = useState("OpenStreetMapを読み込み中");
  const gpsStats = useMemo(() => {
    const valid = rows.filter((row) => row.gps === 1 && Number.isFinite(row.lat) && Number.isFinite(row.lng) && Math.abs(row.lat) <= 90 && Math.abs(row.lng) <= 180);
    const distinct = new Set(valid.map((row) => `${row.lat.toFixed(6)},${row.lng.toFixed(6)}`)).size;
    return { valid: valid.length, distinct };
  }, [rows]);
  const useOfflineFallback = useCallback(() => {
    setMode("offline");
    setStatus("オフライン簡易表示（地図タイルを取得できません）");
  }, []);

  useEffect(() => {
    setMode("online");
    setStatus("OpenStreetMapを読み込み中");
  }, [sessionId]);

  return (
    <section className="chart-card gps-card">
      <div className="card-heading chart-heading">
        <div><h3>GPS航跡マップ</h3><p>緑が開始、赤が終了、黄が選択時刻。保持座標であり現在fix数ではありません。</p></div>
        <div className="map-mode" role="group" aria-label="地図表示モード">
          <button className={mode === "offline" ? "active" : ""} onClick={() => { setMode("offline"); setStatus("オフライン簡易表示"); }}>簡易</button>
          <button className={mode === "online" ? "active" : ""} onClick={() => { setMode("online"); setStatus("OpenStreetMapを読み込み中"); }}>OpenStreetMap</button>
        </div>
      </div>
      <div className="gps-status"><span className={mode === "online" ? "privacy-dot online" : "privacy-dot"} /><strong>{status}</strong><span>有効 {gpsStats.valid.toLocaleString("ja-JP")}点 · 異なる座標 {gpsStats.distinct.toLocaleString("ja-JP")}点</span>{mode === "online" && <span>地図タイルのみ外部取得</span>}</div>
      {mode === "online" ? <OnlineGpsMap rows={rows} cursorMs={cursorMs} onStatus={setStatus} onUnavailable={useOfflineFallback} /> : <GpsPlot rows={rows} cursorMs={cursorMs} />}
    </section>
  );
}

function CycleComparison({ session }) {
  const cycles = useMemo(() => cycleSeries(session.dataRows, "depth_m"), [session.dataRows]);
  const [selected, setSelected] = useState(() => new Set());

  useEffect(() => {
    setSelected(new Set(cycles.slice(0, 6).map((cycle) => cycle.key)));
  }, [session.id]);

  const visible = cycles.filter((cycle) => selected.has(cycle.key)).slice(0, 8);
  let maxX = 1;
  let maxY = 1;
  let minY = 0;
  for (const cycle of visible) {
    for (const point of cycle.points) {
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
      minY = Math.min(minY, point.y);
    }
  }
  const x = (value) => 62 + (value / maxX) * 900;
  const y = (value) => 32 + ((value - minY) / (maxY - minY || 1)) * 180;

  return (
    <section className="chart-card cycle-card">
      <div className="card-heading chart-heading"><div><h3>サイクル比較</h3><p>各サイクルの開始を0秒として深度を重ねます。</p></div></div>
      {cycles.length === 0 ? <div className="chart-empty">比較できる実行中データがありません</div> : (
        <>
          <div className="cycle-options" role="group" aria-label="表示するサイクル">
            {cycles.slice(0, 12).map((cycle, index) => (
              <label key={cycle.key} className="cycle-option">
                <input
                  type="checkbox"
                  checked={selected.has(cycle.key)}
                  onChange={(event) => setSelected((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(cycle.key); else next.delete(cycle.key);
                    return next;
                  })}
                />
                <span className="cycle-dot" style={{ background: SERIES_COLORS[index % SERIES_COLORS.length] }} />
                起動{cycle.epoch + 1} / C{cycle.cycle}
              </label>
            ))}
          </div>
          <div className="chart-wrap">
            <svg className="line-chart cycle-chart" viewBox="0 0 1000 260" role="img" aria-label="サイクル深度比較">
              <title>サイクル深度比較</title>
              {[0, 1, 2, 3, 4].map((tick) => {
                const yy = 32 + tick * 45;
                return <line key={tick} x1="62" y1={yy} x2="962" y2={yy} className="chart-grid" />;
              })}
              {visible.map((cycle) => {
                const originalIndex = cycles.findIndex((item) => item.key === cycle.key);
                const sampled = cycle.points.length > 500 ? cycle.points.filter((_, index) => index % Math.ceil(cycle.points.length / 500) === 0) : cycle.points;
                const path = sampled.map((point, index) => `${index ? "L" : "M"}${x(point.x).toFixed(2)},${y(point.y).toFixed(2)}`).join(" ");
                return <path key={cycle.key} d={path} fill="none" stroke={SERIES_COLORS[originalIndex % SERIES_COLORS.length]} strokeWidth="3" vectorEffect="non-scaling-stroke" />;
              })}
              <text x="512" y="252" textAnchor="middle" className="chart-axis-caption">サイクル開始からの経過時間</text>
            </svg>
          </div>
          <div className="table-shell compact-table">
            <table>
              <thead><tr><th>区間</th><th>開始</th><th>長さ</th><th>最大深度</th><th>到達</th><th>有効点</th></tr></thead>
              <tbody>{cycles.slice(0, 12).map((cycle) => {
                const deepest = cycle.points.reduce((best, point) => !best || point.y > best.y ? point : best, null);
                return <tr key={cycle.key}><td>起動{cycle.epoch + 1} / C{cycle.cycle}</td><td>{formatElapsed(cycle.startMs)}</td><td>{formatElapsed(cycle.points.at(-1)?.x || 0)}</td><td>{formatNumber(deepest?.y, 2, " m")}</td><td>{formatElapsed(deepest?.x)}</td><td>{cycle.points.length.toLocaleString("ja-JP")}</td></tr>;
              })}</tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function QualityPanel({ session, titleId = "quality-title" }) {
  const [filter, setFilter] = useState("all");
  const verdict = issueVerdict(session.summary);
  const shown = session.issues.filter((issue) => filter === "all" || issue.severity === filter);
  return (
    <section className={`quality-panel ${verdict.tone}`} aria-labelledby={titleId}>
      <div className="quality-summary">
        <div className="verdict-mark" aria-hidden="true">{verdict.tone === "good" ? "✓" : verdict.tone === "warning" ? "!" : "×"}</div>
        <div><span className="eyebrow">ADVERSARIAL CHECK</span><h2 id={titleId}>{verdict.label}</h2><p>{verdict.detail}</p></div>
        <div className="quality-counts">
          <button className={filter === "critical" ? "active" : ""} onClick={() => setFilter(filter === "critical" ? "all" : "critical")}><strong>{session.summary.severityCounts.critical}</strong><span>重大</span></button>
          <button className={filter === "warning" ? "active" : ""} onClick={() => setFilter(filter === "warning" ? "all" : "warning")}><strong>{session.summary.severityCounts.warning}</strong><span>警告</span></button>
          <button className={filter === "info" ? "active" : ""} onClick={() => setFilter(filter === "info" ? "all" : "info")}><strong>{session.summary.severityCounts.info}</strong><span>情報</span></button>
        </div>
      </div>
      {shown.length > 0 && (
        <details className="issue-details" open={verdict.tone === "danger"}>
          <summary>{filter === "all" ? "診断内容" : `${filter} の診断`}（{shown.length}種類）</summary>
          <ul className="issue-list">
            {shown.map((issue, index) => (
              <li key={`${issue.code}-${issue.source}-${index}`} className={`issue ${issue.severity}`}>
                <span className="issue-severity">{issue.severity === "critical" ? "重大" : issue.severity === "warning" ? "警告" : "情報"}</span>
                <div><strong>{issue.title}{issue.count > 1 ? ` ×${issue.count.toLocaleString("ja-JP")}` : ""}</strong><p>{issue.detail}</p>{(issue.source || issue.lines.length > 0) && <small>{issue.source}{issue.lines.length > 0 ? ` · 行 ${issue.lines.join(", ")}` : ""}</small>}</div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function EventTable({ events, selectedMs, onSelect }) {
  const [eventType, setEventType] = useState("all");
  const [query, setQuery] = useState("");
  const types = useMemo(() => [...new Set(events.map((event) => event.event).filter(Boolean))].sort().slice(0, 100), [events]);
  useEffect(() => {
    if (eventType !== "all" && !types.includes(eventType)) setEventType("all");
  }, [eventType, types]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("ja");
    return events.filter((event) => {
      if (eventType !== "all" && event.event !== eventType) return false;
      if (!needle) return true;
      return [event.event, event.msg, event.date, event.time].some((value) => String(value || "").toLocaleLowerCase("ja").includes(needle));
    });
  }, [events, eventType, query]);

  return (
    <section className="data-card">
      <div className="card-heading table-heading">
        <div><h3>イベントログ</h3><p>CSV由来の文字列はHTMLとして解釈せず、そのまま表示します。</p></div>
        <div className="table-filters">
          <label><span>種別</span><select value={eventType} onChange={(event) => setEventType(event.target.value)}><option value="all">すべて</option>{types.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
          <label><span>検索</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="イベント・メッセージ" /></label>
        </div>
      </div>
      <div className="table-meta">{filtered.length.toLocaleString("ja-JP")}件{filtered.length > 250 ? "（先頭250件を表示）" : ""}</div>
      <div className="table-shell">
        <table>
          <thead><tr><th>相対時刻</th><th>記録時刻</th><th>イベント</th><th>state / phase</th><th>深度</th><th>詳細</th></tr></thead>
          <tbody>
            {filtered.slice(0, 250).map((event, index) => (
              <tr key={`${event._epoch}-${event.seq}-${index}`} aria-selected={Number.isFinite(selectedMs) && Math.abs(event._timelineMs - selectedMs) < 1}>
                <td className="mono"><button className="time-link" onClick={() => onSelect?.(event._timelineMs)}>{formatElapsed(event._timelineMs)}</button></td>
                <td className="mono">{event.date || "—"} {event.time || "—"}</td>
                <td><span className="event-badge">{event.event || "UNKNOWN"}</span></td>
                <td>{STATE_LABELS[event.state] || `S${event.state}`} / {PHASE_LABELS[event.phase] || `P${event.phase}`}</td>
                <td className="mono">{formatNumber(event.depth_m, 2, " m")}</td>
                <td className="message-cell">{event.msg || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SensorTable({ rows, selectedMs, onSelect }) {
  return (
    <section className="data-card sensor-details">
      <div className="card-heading table-heading"><div><h3>センサーデータ</h3><p>現在の表示区間から先頭500行。時刻を選ぶと全グラフのカーソルが同期します。</p></div></div>
      <div className="table-meta">{rows.length.toLocaleString("ja-JP")}行{rows.length > 500 ? "（先頭500行を表示）" : ""}</div>
      <div className="table-shell">
        <table>
          <thead><tr><th>相対時刻</th><th>state / phase</th><th>cycle</th><th>深度 m</th><th>周囲圧力 mbar</th><th>water_c ℃</th><th>press_c ℃</th><th>弁 INJ / EXH</th><th>err</th></tr></thead>
          <tbody>{rows.slice(0, 500).map((row, index) => (
            <tr key={`${row._epoch}-${row.seq}-${index}`} aria-selected={Number.isFinite(selectedMs) && Math.abs(row._timelineMs - selectedMs) < 1}>
              <td className="mono"><button className="time-link" onClick={() => onSelect?.(row._timelineMs)}>{formatElapsed(row._timelineMs)}</button></td><td>{STATE_LABELS[row.state] || `S${row.state}`} / {PHASE_LABELS[row.phase] || `P${row.phase}`}</td><td>{row.cycle ?? "—"}</td><td>{formatNumber(row.depth_m)}</td><td>{formatNumber(row.press_mbar)}</td><td>{formatNumber(row.water_c)}</td><td>{formatNumber(row.press_c)}</td><td>{row.vinj ?? "—"} / {row.vexh ?? "—"}</td><td className="mono">{Number.isFinite(row.err) ? `0x${Math.trunc(row.err).toString(16).toUpperCase().padStart(4, "0")}` : "—"}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  );
}

function VehicleNotes({ session }) {
  return (
    <aside className="device-note">
      <span className="eyebrow">FORMAT NOTE</span>
      {session.vehicle === "triton" ? (
        <><h3>Triton-3として検証</h3><p><code>water_c</code>はTSYS01、<code>press_c</code>はMS5837内蔵温度です。2系列の乖離を比較できます。</p><p><code>sd</code>はカード準備状態と直前書込状態を含みますが、失敗行そのものは記録されない場合があります。</p></>
      ) : session.vehicle === "umibot" ? (
        <><h3>UmiBotとして検証</h3><p><code>water_c</code>と<code>press_c</code>は同じMS5837温度です。独立センサーとして二重表示しません。</p><p><code>sd</code>は初期化状態であり、個々の書込み成功を保証しません。</p></>
      ) : (
        <><h3>機種の指定が必要です</h3><p>v3.6のヘッダーは両機種で同一です。温度値の一致は推定材料にしかならないため、上の選択欄で実機を指定してください。</p>{session.inference.suggested !== "unknown" && <p>参考推定: {vehicleName(session.inference.suggested)}に似ています（確定ではありません）。</p>}</>
      )}
      <p className="reserved-note"><code>last_seq / last_result / pc_age</code> とEVENT通信列はStandaloneでは予約値のため、通信実績には使いません。</p>
    </aside>
  );
}

function summarizeWindow(rows) {
  let maxDepth = -Infinity;
  let tempSum = 0;
  let tempCount = 0;
  let gpsCount = 0;
  let errorCount = 0;
  let gapCount = 0;
  const cycles = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (Number.isFinite(row.depth_m)) maxDepth = Math.max(maxDepth, row.depth_m);
    if (Number.isFinite(row.water_c)) { tempSum += row.water_c; tempCount += 1; }
    if (row.gps === 1 && Number.isFinite(row.lat) && Number.isFinite(row.lng)) gpsCount += 1;
    if (Number.isFinite(row.err) && row.err !== 0) errorCount += 1;
    if (row.state === 2 && Number.isInteger(row.cycle)) cycles.add(`${row._epoch}:${row.cycle}`);
    const previous = rows[index - 1];
    if (previous && previous._epoch === row._epoch && previous.state === 2 && row.state === 2 && row._timelineMs - previous._timelineMs > 1_500) gapCount += 1;
  }
  return {
    maxDepth: Number.isFinite(maxDepth) ? maxDepth : null,
    averageTemperature: tempCount ? tempSum / tempCount : null,
    gpsCount,
    errorCount,
    gapCount,
    cycles: cycles.size
  };
}

function RangeControl({ bounds, range, onChange, markers, rowCount, eventCount }) {
  const [startPercent, endPercent] = range;
  const duration = bounds.max - bounds.min;
  const startMs = bounds.min + (startPercent / 100) * duration;
  const endMs = bounds.min + (endPercent / 100) * duration;
  const selectEpoch = (index) => {
    const start = markers[index]?.x ?? bounds.min;
    const nextStart = markers[index + 1]?.x;
    const end = Number.isFinite(nextStart) ? nextStart - 0.001 : bounds.max;
    const toPercent = (value) => ((value - bounds.min) / duration) * 100;
    onChange([Math.max(0, toPercent(start)), Math.min(100, toPercent(end))]);
  };
  return (
    <section className="range-control" aria-label="共通表示時間範囲">
      <div className="range-heading">
        <div><strong>共通表示区間</strong><span className="mono">{formatElapsed(startMs)} — {formatElapsed(endMs)} / {formatDuration(endMs - startMs)}</span></div>
        <div className="range-actions">
          <button className={startPercent === 0 && endPercent === 100 ? "active" : ""} onClick={() => onChange([0, 100])}>全区間</button>
          {markers.map((marker, index) => <button key={`${marker.x}-${index}`} onClick={() => selectEpoch(index)}>{marker.label}</button>)}
        </div>
      </div>
      <div className="range-sliders">
        <label><span>開始</span><input type="range" min="0" max="99" step="1" value={startPercent} onChange={(event) => onChange([Math.min(Number(event.target.value), endPercent - 1), endPercent])} /></label>
        <label><span>終了</span><input type="range" min="1" max="100" step="1" value={endPercent} onChange={(event) => onChange([startPercent, Math.max(Number(event.target.value), startPercent + 1)])} /></label>
      </div>
      <span className="range-count mono">{rowCount.toLocaleString("ja-JP")} DATA · {eventCount.toLocaleString("ja-JP")} EVENT</span>
    </section>
  );
}

function SelectionInspector({ dataRows, eventRows, cursorMs, onMoveEvent }) {
  const row = nearestRow(dataRows, cursorMs);
  const event = nearestRow(eventRows, cursorMs);
  const delta = row ? Math.abs(row._timelineMs - cursorMs) : null;
  const entries = row ? [
    ["DATA時刻", `${formatElapsed(row._timelineMs)}${Number.isFinite(delta) ? `（選択差 ${(delta / 1000).toFixed(2)}秒）` : ""}`],
    ["state / phase", `${STATE_LABELS[row.state] || `S${row.state}`} / ${PHASE_LABELS[row.phase] || `P${row.phase}`}`],
    ["起動 / cycle", `${(row._epoch ?? 0) + 1} / ${row.cycle ?? "—"}`],
    ["深度", formatNumber(row.depth_m, 3, " m")],
    ["周囲圧力", formatNumber(row.press_mbar, 1, " mbar")],
    ["温度", `${formatNumber(row.water_c, 2, " ℃")} / ${formatNumber(row.press_c, 2, " ℃")}`],
    ["バルブ", `INJ ${row.vinj ?? "—"} / EXH ${row.vexh ?? "—"}`],
    ["GPS", row.gps === 1 && Number.isFinite(row.lat) && Number.isFinite(row.lng) ? `${row.lat.toFixed(6)}, ${row.lng.toFixed(6)} · ${row.sat ?? 0} sat` : `保持なし · ${row.sat ?? 0} sat`],
    ["SD / err", `${row.sd ?? "—"} / ${Number.isFinite(row.err) ? `0x${Math.trunc(row.err).toString(16).toUpperCase().padStart(4, "0")}` : "—"}`],
    ["ソース", `${row._source || "—"}${row._line ? `:${row._line}` : ""}`]
  ] : [];

  return (
    <section className="inspector-card selection-inspector">
      <div className="pane-title"><div><span>INSPECTOR</span><strong>選択時刻 {formatElapsed(cursorMs)}</strong></div><div className="event-step"><button onClick={() => onMoveEvent(-1)} aria-label="前のイベント">←</button><button onClick={() => onMoveEvent(1)} aria-label="次のイベント">→</button></div></div>
      {row ? <dl className="inspection-list">{entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd className={label === "ソース" ? "mono" : ""}>{value}</dd></div>)}</dl> : <div className="inspector-empty">この区間にDATAがありません</div>}
      <div className="nearest-event">
        <span>最寄りEVENT</span>
        {event ? <><strong><span className="event-badge">{event.event || "UNKNOWN"}</span> {formatElapsed(event._timelineMs)}</strong><p>{event.msg || "詳細なし"}</p></> : <p>この区間にEVENTがありません</p>}
      </div>
      <p className="inspection-note">値は補間せず、選択時刻に最も近い生DATAを表示します。</p>
    </section>
  );
}

function QualitySummaryCard({ session, onOpen }) {
  const verdict = issueVerdict(session.summary);
  return (
    <section className={`inspector-card quality-inspector ${verdict.tone}`}>
      <div className="pane-title"><div><span>DATA QUALITY</span><strong>{verdict.label}</strong></div><button className="pane-link" onClick={onOpen}>詳細</button></div>
      <div className="quality-mini-counts">
        <div><strong>{session.summary.severityCounts.critical}</strong><span>重大</span></div>
        <div><strong>{session.summary.severityCounts.warning}</strong><span>警告</span></div>
        <div><strong>{session.summary.severityCounts.info}</strong><span>情報</span></div>
      </div>
      <p>{verdict.detail}</p>
    </section>
  );
}

function Dashboard({ session, onVehicleChange, onClear }) {
  const [view, setView] = useState("timeline");
  const [range, setRange] = useState([0, 100]);
  const bounds = useMemo(() => getTimelineBounds(session), [session]);
  const [cursorMs, setCursorMs] = useState(() => bounds.min);
  const epochMarkers = useMemo(() => epochMarkersFor(session), [session]);
  const startMs = bounds.min + (range[0] / 100) * (bounds.max - bounds.min);
  const endMs = bounds.min + (range[1] / 100) * (bounds.max - bounds.min);
  const windowRows = useMemo(() => rowsInWindow(session.dataRows, startMs, endMs), [session.dataRows, startMs, endMs]);
  const windowEvents = useMemo(() => rowsInWindow(session.eventRows, startMs, endMs), [session.eventRows, startMs, endMs]);
  const windowSummary = useMemo(() => summarizeWindow(windowRows), [windowRows]);
  const sampledEventMarkers = useMemo(() => {
    const step = Math.max(1, Math.ceil(windowEvents.length / 120));
    return windowEvents.filter((_, index) => index % step === 0).map((event) => ({ x: event._timelineMs, label: `${event.event || "EVENT"}: ${String(event.msg || "").slice(0, 180)}`, kind: "event" }));
  }, [windowEvents]);

  useEffect(() => {
    setView("timeline");
    setRange([0, 100]);
    setCursorMs(bounds.min);
  }, [session.id, bounds.min]);

  useEffect(() => {
    if (cursorMs < startMs || cursorMs > endMs) setCursorMs(startMs);
  }, [cursorMs, startMs, endMs]);

  const moveEvent = (direction) => {
    if (windowEvents.length === 0) return;
    let index = lowerBound(windowEvents, cursorMs);
    if (direction < 0) index = Math.max(0, index - (windowEvents[index]?._timelineMs >= cursorMs ? 1 : 0));
    else if (windowEvents[index]?._timelineMs <= cursorMs) index += 1;
    index = Math.min(windowEvents.length - 1, Math.max(0, index));
    setCursorMs(windowEvents[index]._timelineMs);
  };

  const tempSeries = TEMPERATURE_SERIES[session.vehicle] || TEMPERATURE_SERIES.unknown;

  const views = [
    { id: "timeline", label: "時系列", count: null },
    { id: "cycles", label: "航跡・サイクル", count: windowSummary.cycles },
    { id: "events", label: "イベント", count: windowEvents.length },
    { id: "data", label: "生DATA", count: windowRows.length },
    { id: "quality", label: "品質診断", count: session.issues.length }
  ];

  return (
    <div className="dashboard">
      <section className="session-toolbar">
        <div className="session-identity"><span className="eyebrow">ACTIVE SESSION</span><h1>{session.name}</h1><p>{session.summary.dataRows.toLocaleString("ja-JP")} DATA · {session.summary.eventRows.toLocaleString("ja-JP")} EVENT · {session.epochCount || 1} 起動</p></div>
        <div className="session-controls"><label className="vehicle-select"><span>v3.6 ログの機種</span><select value={session.vehicle} onChange={(event) => onVehicleChange(event.target.value)}><option value="unknown">選択してください</option><option value="triton">Triton-3</option><option value="umibot">UmiBot</option></select></label><button className="clear-button" onClick={onClear}>閉じる</button></div>
      </section>

      <nav className="view-tabs" aria-label="分析ビュー">{views.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} aria-current={view === item.id ? "page" : undefined} onClick={() => setView(item.id)}><span>{item.label}</span>{item.count != null && <b>{item.count.toLocaleString("ja-JP")}</b>}</button>)}</nav>

      <RangeControl bounds={bounds} range={range} onChange={setRange} markers={epochMarkers} rowCount={windowRows.length} eventCount={windowEvents.length} />

      <section className="metric-grid" aria-label="表示区間の概要">
        <MetricCard label="表示区間" value={formatDuration(endMs - startMs)} note={`全体 ${formatDuration(bounds.max - bounds.min)}`} />
        <MetricCard label="最大深度" value={formatNumber(windowSummary.maxDepth, 2, " m")} note="表示区間のdepth_m" />
        <MetricCard label="平均水温" value={formatNumber(windowSummary.averageTemperature, 2, " ℃")} note={session.vehicle === "triton" ? "TSYS01 water_c" : "MS5837 water_c"} />
        <MetricCard label="観測サイクル" value={`${windowSummary.cycles}`} note="表示区間と重なる実行区間" />
        <MetricCard label="保持座標" value={windowSummary.gpsCount.toLocaleString("ja-JP")} note="現在fix数ではありません" />
        <MetricCard label="区間内注意" value={`${windowSummary.errorCount + windowSummary.gapCount}`} note={`err行 ${windowSummary.errorCount} · 欠落区間 ${windowSummary.gapCount}`} tone={windowSummary.errorCount + windowSummary.gapCount ? "warning" : ""} />
      </section>

      {view === "timeline" && <div className="workbench-grid">
        <div className="workbench-main">
          <Timeline session={session} startMs={startMs} endMs={endMs} cursorMs={cursorMs} onCursorChange={setCursorMs} markers={epochMarkers} />
          <LineChart title="深度プロファイル" description="MS5837の実測深度。ポインタまたはタップで選択時刻を同期します。" rows={windowRows} series={DEPTH_SERIES} invertY unit="m" cursorMs={cursorMs} onCursorChange={setCursorMs} markers={[...epochMarkers, ...sampledEventMarkers]} />
          <div className="two-column">
            <LineChart title="温度" description={session.vehicle === "umibot" ? "UmiBotはMS5837温度を1系列で表示します。" : "機種に応じて独立した温度系列を表示します。"} rows={windowRows} series={tempSeries} unit="℃" cursorMs={cursorMs} onCursorChange={setCursorMs} markers={epochMarkers} />
            <LineChart title="周囲圧力" description="水中の周囲絶対圧力です。気圧だけを意味する値ではありません。" rows={windowRows} series={PRESSURE_SERIES} unit="" cursorMs={cursorMs} onCursorChange={setCursorMs} markers={epochMarkers} />
          </div>
        </div>
        <aside className="workbench-inspector">
          <div className="compact-map"><GpsPanel rows={session.dataRows} cursorMs={cursorMs} sessionId={session.id} /></div>
          <SelectionInspector dataRows={windowRows} eventRows={windowEvents} cursorMs={cursorMs} onMoveEvent={moveEvent} />
          <QualitySummaryCard session={session} onOpen={() => setView("quality")} />
          <VehicleNotes session={session} />
        </aside>
      </div>}

      {view === "cycles" && <div className="cycle-workbench">
        <CycleComparison key={session.id} session={session} />
        <GpsPanel rows={session.dataRows} cursorMs={cursorMs} sessionId={session.id} />
        <aside className="cycle-inspector"><SelectionInspector dataRows={windowRows} eventRows={windowEvents} cursorMs={cursorMs} onMoveEvent={moveEvent} /></aside>
      </div>}

      {view === "events" && <div className="event-workbench"><EventTable key={session.id} events={windowEvents} selectedMs={cursorMs} onSelect={setCursorMs} /><aside><SelectionInspector dataRows={windowRows} eventRows={windowEvents} cursorMs={cursorMs} onMoveEvent={moveEvent} /></aside></div>}

      {view === "data" && <div className="data-workbench"><SensorTable rows={windowRows} selectedMs={cursorMs} onSelect={setCursorMs} /><aside><SelectionInspector dataRows={windowRows} eventRows={windowEvents} cursorMs={cursorMs} onMoveEvent={moveEvent} /></aside></div>}

      {view === "quality" && <div className="quality-workbench"><QualityPanel key={session.id} session={session} /><VehicleNotes session={session} /></div>}
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState(() => {
    const stored = safeStorageGet("osezaki-log-theme", "auto");
    return ["auto", "light", "dark"].includes(stored) ? stored : "auto";
  });
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches || false);
  const [sessions, setSessions] = useState(() => [makeDemoSession("triton", false)]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadMessage, setLoadMessage] = useState("内蔵のTriton-3正常ログを表示しています。CSVを開くと置き換わります。");
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const workerRef = useRef(null);
  const importRejectRef = useRef(null);
  const dragDepthRef = useRef(0);

  const resolvedTheme = theme === "auto" ? (systemDark ? "dark" : "light") : theme;

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    safeStorageSet("osezaki-log-theme", theme);
  }, [theme, resolvedTheme]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return undefined;
    const update = (event) => setSystemDark(event.matches);
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  useEffect(() => () => workerRef.current?.terminate(), []);

  const active = sessions[activeIndex] || null;

  const loadDemo = (vehicle, adversarial) => {
    const next = makeDemoSession(vehicle, adversarial);
    setSessions([next]);
    setActiveIndex(0);
    setLoadMessage(`${vehicleName(vehicle)}の${adversarial ? "敵対的" : "正常"}ダミーデータを読み込みました。`);
  };

  const downloadDemo = (vehicle, adversarial) => {
    const demo = createDemo(vehicle, adversarial);
    downloadText(`${vehicle}-${adversarial ? "adversarial" : "normal"}-DATA.CSV`, demo.dataText);
    window.setTimeout(() => downloadText(`${vehicle}-${adversarial ? "adversarial" : "normal"}-EVENT.CSV`, demo.eventText), 120);
  };

  const importFiles = async (fileList) => {
    const files = [...fileList].filter((file) => file.name.toLowerCase().endsWith(".csv"));
    if (files.length === 0) {
      setLoadMessage("CSVファイルが見つかりませんでした。");
      return;
    }
    const tooLarge = files.find((file) => file.size > MAX_FILE_BYTES);
    if (tooLarge) {
      setLoadMessage(`${tooLarge.name} は32 MiB上限を超えています。巨大入力による画面停止を防ぐため読み込みませんでした。`);
      return;
    }

    setLoading(true);
    setLoadMessage(`${files.length}ファイルを安全に検証しています…`);
    workerRef.current?.terminate();
    const worker = new Worker(new URL("./log.worker.js", import.meta.url), { type: "module" });
    workerRef.current = worker;

    try {
      const payload = await Promise.all(files.map(async (file) => ({
        name: file.name,
        path: file.webkitRelativePath || file.name,
        buffer: await file.arrayBuffer()
      })));
      const result = await new Promise((resolve, reject) => {
        importRejectRef.current = reject;
        worker.onmessage = (event) => event.data.ok ? resolve(event.data) : reject(new Error(event.data.error));
        worker.onerror = () => reject(new Error("解析処理を開始できませんでした。"));
        worker.postMessage({ files: payload }, payload.map((item) => item.buffer));
      });
      if (result.sessions.length === 0) throw new Error(result.errors.join(" / ") || "対応するDATA/EVENTログを認識できませんでした。");
      setSessions(result.sessions);
      setActiveIndex(0);
      setLoadMessage(`${result.sessions.length}セッションを読み込みました。CSVは端末外へ送信していません。${result.errors.length ? ` ${result.errors.length}件のファイル警告があります。` : ""}`);
    } catch (error) {
      setLoadMessage(error instanceof Error ? error.message : "CSVの読み込みに失敗しました。");
    } finally {
      importRejectRef.current = null;
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
      setLoading(false);
    }
  };

  const updateVehicle = (vehicle) => {
    setSessions((current) => current.map((session, index) => index === activeIndex ? rebuildSessionVehicle(session, vehicle) : session));
  };

  const cancelImport = () => {
    workerRef.current?.terminate();
    workerRef.current = null;
    importRejectRef.current?.(new Error("CSVの検証をキャンセルしました。"));
    importRejectRef.current = null;
    setLoading(false);
    setLoadMessage("CSVの検証をキャンセルしました。");
  };

  const themeLabel = theme === "auto" ? "自動" : theme === "light" ? "ライト" : "ダーク";
  const cycleTheme = () => setTheme((current) => current === "auto" ? "light" : current === "light" ? "dark" : "auto");
  const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");

  return (
    <div
      className={`app-shell ${active ? "has-session" : "is-empty"}`}
      onDragEnter={(event) => { if (!hasFiles(event)) return; event.preventDefault(); dragDepthRef.current += 1; setDragActive(true); }}
      onDragOver={(event) => { if (hasFiles(event)) event.preventDefault(); }}
      onDragLeave={(event) => { event.preventDefault(); dragDepthRef.current = Math.max(0, dragDepthRef.current - 1); if (dragDepthRef.current === 0) setDragActive(false); }}
      onDrop={(event) => { if (!event.dataTransfer?.files?.length) return; event.preventDefault(); dragDepthRef.current = 0; setDragActive(false); importFiles(event.dataTransfer.files); }}
    >
      <a className="skip-link" href="#main-content">解析結果へ移動</a>
      <header className="site-header">
        <div className="brand-block"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><div><strong>OSEZAKI LOG LAB</strong><span>Triton-3 / UmiBot standalone</span></div></div>
        <div className="header-actions">
          <button className="toolbar-button primary" onClick={() => fileInputRef.current?.click()} disabled={loading}>{loading ? "検証中…" : "CSVを開く"}</button>
          <button className="toolbar-button" onClick={() => folderInputRef.current?.click()} disabled={loading}>フォルダ</button>
          {loading && <button className="toolbar-button danger" onClick={cancelImport}>取消</button>}
          <details className="fixture-menu">
            <summary>テストデータ</summary>
            <div className="fixture-popover">
              <div className="fixture-popover-title"><strong>内蔵検証ログ</strong><span>表示 / CSV保存</span></div>
              {[{ vehicle: "triton", adversarial: false }, { vehicle: "triton", adversarial: true }, { vehicle: "umibot", adversarial: false }, { vehicle: "umibot", adversarial: true }].map(({ vehicle, adversarial }) => (
                <div className="fixture-row" key={`${vehicle}-${adversarial}`}>
                  <div><strong>{vehicleName(vehicle)}</strong><span className={adversarial ? "danger-text" : "good-text"}>{adversarial ? "敵対的" : "正常"}</span></div>
                  <div><button onClick={() => loadDemo(vehicle, adversarial)}>表示</button><button onClick={() => downloadDemo(vehicle, adversarial)}>CSV ↓</button></div>
                </div>
              ))}
            </div>
          </details>
          <span className="privacy-pill"><span className="privacy-dot" />CSVは端末内解析</span>
          <button className="theme-button" onClick={cycleTheme} aria-label={`テーマは${themeLabel}。切り替える`}><span aria-hidden="true">{resolvedTheme === "light" ? "☀" : "☾"}</span>{themeLabel}</button>
        </div>
        <input ref={fileInputRef} className="visually-hidden" type="file" accept=".csv,.CSV,text/csv" multiple onChange={(event) => { importFiles(event.target.files); event.target.value = ""; }} />
        <input ref={folderInputRef} className="visually-hidden" type="file" accept=".csv,.CSV,text/csv" multiple {...{ webkitdirectory: "", directory: "" }} onChange={(event) => { importFiles(event.target.files); event.target.value = ""; }} />
      </header>

      <div className="workspace-bar">
        <nav className="session-tabs" role="tablist" aria-label="ログセッション">{sessions.map((session, index) => <button key={session.id} role="tab" aria-selected={index === activeIndex} className={index === activeIndex ? "active" : ""} onClick={() => setActiveIndex(index)}><span>{index + 1}</span>{session.name}</button>)}</nav>
        <div className="status-announcer" role="status" aria-live="polite"><span className={loading ? "status-spinner" : "status-dot"} />{loadMessage}</div>
      </div>

      <main id="main-content" className="main-content">{active ? <Dashboard key={active.id} session={active} onVehicleChange={updateVehicle} onClear={() => { setSessions([]); setActiveIndex(0); setLoadMessage("ログを画面から閉じました。端末には保存していません。"); }} /> : <section className="empty-state"><div className="empty-state-mark" aria-hidden="true">CSV</div><div><h1>解析するログがありません</h1><p>DATA.CSV / EVENT.CSVを開くか、この画面へドロップしてください。片方だけでも不足を明示して解析します。</p><div className="empty-actions"><button className="toolbar-button primary" onClick={() => fileInputRef.current?.click()}>CSVを開く</button><button className="toolbar-button" onClick={() => folderInputRef.current?.click()}>フォルダを開く</button></div><small>1ファイル32 MiB / 250,000行まで。CSV本体は端末外へ送信しません。</small></div></section>}</main>

      {dragActive && <div className="drop-overlay" aria-hidden="true"><div><strong>DATA.CSV / EVENT.CSVをドロップ</strong><span>フォルダ内のペアをセッションとして検証します</span></div></div>}
    </div>
  );
}
