import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertTriangle,
  Antenna,
  CheckCircle2,
  Clock3,
  Crosshair,
  Gauge,
  Layers,
  Loader2,
  Moon,
  Play,
  Plug,
  Radio,
  RefreshCw,
  Send,
  ShieldAlert,
  Sun,
  Terminal,
  Thermometer,
  Timer,
  Trash2,
  Unplug,
  Waves,
  Wind
} from "lucide-react";
import "./styles.css";

const FLAG_DEPTH_TRIGGER = 0x01;
const FLAG_MAX_DEPTH = 0x02;
const FLAG_INFINITE = 0x08;
const FLAG_REQUIRE_DEPTH = 0x10;
const MAIN_FIRMWARE_FLAGS_MASK = FLAG_DEPTH_TRIGGER | FLAG_MAX_DEPTH | FLAG_INFINITE | FLAG_REQUIRE_DEPTH;

type Plan = {
  planId: string;
  repeatCount: string;
  maxRuntimeMin: string;
  commTimeoutS: string;
  prepareS: string;
  exhaustOpenS: string;
  descentCoastS: string;
  bottomWaitS: string;
  injectionOpenS: string;
  ascentWaitS: string;
  depthTriggerCm: string;
  maxDepthCm: string;
  logInterval100ms: string;
  statusInterval100ms: string;
};

type Preset = {
  name: string;
  legacy: string;
  badge: string;
  description: string;
  flags: number;
  plan: Plan;
};

type StatusFrame = {
  statusSeq: number;
  deviceId: number;
  state: string;
  phase: string;
  valveBitsHex: string;
  activePlanId: number;
  cycleCount: number;
  phaseElapsedS: number;
  phaseRemainingS: number;
  depthText: string;
  maxDepthText: string;
  waterTempText: string;
  pressureMbar: number;
  gpsSat: number;
  lastCmdResultName: string;
  lastCmdSeq: number;
  errorFlags: number;
  errorFlagsHex: string;
  pcSeenAgeS: number;
  statusFlagNames: string[];
  // Reserved protocol slots: the Triton-3 firmware hardcodes battery_mv=0xFFFF and
  // twelite_lqi=0xFF (not measured), so these are intentionally not surfaced in the UI.
  batteryMv?: number;
  tweliteLqi?: number;
};

type AckFrame = {
  ackedSeq: number;
  deviceId: number;
  command: string;
  result: string;
  ok: boolean;
  state: string;
  phase: string;
  activePlanId: number;
  detailHex: string;
  valveBitsHex: string;
  errorFlagsLowHex: string;
};

type LogEntry = {
  id: number;
  time: string;
  level: "info" | "ok" | "warn" | "error" | "tx" | "rx" | "raw";
  message: string;
  raw?: boolean;
  status?: boolean;
};

type Snapshot = {
  connected: boolean;
  port: string;
  seq: number;
  lastAck: AckFrame | null;
  lastStatus: StatusFrame | null;
};

const vehicles = [
  { name: "Triton-3 #1", dest: "0x78", deviceId: "0x01" },
  { name: "UmiBot #1", dest: "0x78", deviceId: "0x02" },
  { name: "Custom", dest: "", deviceId: "" }
];

const benchPlan: Plan = {
  planId: "1",
  repeatCount: "1",
  maxRuntimeMin: "5",
  commTimeoutS: "0",
  prepareS: "1",
  exhaustOpenS: "0",
  descentCoastS: "0",
  bottomWaitS: "0",
  injectionOpenS: "1",
  ascentWaitS: "0",
  depthTriggerCm: "0",
  maxDepthCm: "0",
  logInterval100ms: "5",
  statusInterval100ms: "10"
};

const baseMissionPlan: Plan = {
  planId: "1",
  repeatCount: "0xFFFF",
  maxRuntimeMin: "60",
  commTimeoutS: "0",
  prepareS: "120",
  exhaustOpenS: "60",
  descentCoastS: "180",
  bottomWaitS: "240",
  injectionOpenS: "20",
  ascentWaitS: "220",
  depthTriggerCm: "0",
  maxDepthCm: "3500",
  logInterval100ms: "5",
  statusInterval100ms: "10"
};

const presets: Preset[] = [
  { name: "Bench Test", legacy: "", badge: "Short", description: "1 s injection check", flags: 0, plan: benchPlan },
  {
    name: "Continuous Cycle",
    legacy: "B",
    badge: "Repeat",
    description: "Time-based · 60 min cap",
    flags: FLAG_MAX_DEPTH | FLAG_INFINITE,
    plan: baseMissionPlan
  },
  {
    name: "Single Cycle",
    legacy: "C",
    badge: "1 cycle",
    description: "Time-based · single run",
    flags: FLAG_MAX_DEPTH,
    plan: { ...baseMissionPlan, repeatCount: "1", maxRuntimeMin: "30" }
  },
  {
    name: "Depth 10 m",
    legacy: "D",
    badge: "10 m",
    description: "Inject on depth reach",
    flags: FLAG_DEPTH_TRIGGER | FLAG_MAX_DEPTH | FLAG_INFINITE,
    plan: { ...baseMissionPlan, depthTriggerCm: "1000" }
  },
  {
    name: "Depth 20 m",
    legacy: "E",
    badge: "20 m",
    description: "Inject on depth reach",
    flags: FLAG_DEPTH_TRIGGER | FLAG_MAX_DEPTH | FLAG_INFINITE,
    plan: { ...baseMissionPlan, depthTriggerCm: "2000" }
  },
  {
    name: "Depth 30 m",
    legacy: "F",
    badge: "30 m",
    description: "Inject on depth reach",
    flags: FLAG_DEPTH_TRIGGER | FLAG_MAX_DEPTH | FLAG_INFINITE,
    plan: { ...baseMissionPlan, depthTriggerCm: "3000" }
  }
];

const flagDefs: { flag: number; label: string }[] = [
  { flag: FLAG_DEPTH_TRIGGER, label: "Depth Trigger" },
  { flag: FLAG_MAX_DEPTH, label: "Max Depth" },
  { flag: FLAG_INFINITE, label: "Infinite Repeat" },
  { flag: FLAG_REQUIRE_DEPTH, label: "Require Depth" }
];

// Phase order in the timeline, mapped to firmware phase names.
const phaseSteps: { key: string; short: string; phase: string; kind?: "exh" | "inj" }[] = [
  { key: "prepareS", short: "PREP", phase: "PREPARE" },
  { key: "exhaustOpenS", short: "EXH", phase: "EXHAUST_OPEN", kind: "exh" },
  { key: "descentCoastS", short: "DESC", phase: "DESCENT_COAST" },
  { key: "bottomWaitS", short: "WAIT", phase: "BOTTOM_WAIT" },
  { key: "injectionOpenS", short: "INJ", phase: "INJECTION_OPEN", kind: "inj" },
  { key: "ascentWaitS", short: "ASC", phase: "ASCENT_WAIT" }
];

function clonePlan(plan: Plan): Plan {
  return { ...plan, commTimeoutS: "0" };
}

function asNumber(value: string): number {
  if (value.trim().toLowerCase().startsWith("0x")) return Number.parseInt(value, 16);
  return Number.parseInt(value, 10);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || response.statusText);
  }
  return payload as T;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3
  )}`;
}

// Firmware sends 0xFFFF as the "pressure unavailable" sentinel (depth sensor not OK);
// surface it as N/A rather than a fake 65535 mbar reading.
function pressureText(mbar?: number): string {
  if (mbar === undefined || mbar === null || mbar === 0xffff) return "N/A";
  return `${mbar} mbar`;
}

function App() {
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (document.documentElement.getAttribute("data-theme") as "light" | "dark") || "light"
  );
  const [ports, setPorts] = useState<string[]>([]);
  const [port, setPort] = useState("");
  const [connected, setConnected] = useState(false);
  const [connectedPort, setConnectedPort] = useState("");
  const [vehicle, setVehicle] = useState(vehicles[0].name);
  const [dest, setDest] = useState("0x78");
  const [deviceId, setDeviceId] = useState("0x01");
  const [presetName, setPresetName] = useState(presets[0].name);
  const [plan, setPlan] = useState<Plan>(clonePlan(benchPlan));
  const [flags, setFlags] = useState(0);
  const [status, setStatus] = useState<StatusFrame | null>(null);
  const [lastAck, setLastAck] = useState<AckFrame | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showRaw, setShowRaw] = useState(false);
  const [showStatus, setShowStatus] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [linkTest, setLinkTest] = useState(true);
  const [linkTestInterval, setLinkTestInterval] = useState("5.0");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const busyActionRef = useRef<string | null>(null);
  const logId = useRef(0);
  const terminalRef = useRef<HTMLDivElement>(null);
  const effectiveFlags = flags & MAIN_FIRMWARE_FLAGS_MASK;
  const isRunning = status?.state === "RUNNING" || lastAck?.state === "RUNNING";

  const currentState = status?.state || lastAck?.state || "NO DATA";
  const currentPhase = status?.phase || lastAck?.phase || "—";
  const isError = Boolean(status?.errorFlags);

  const activePhaseIndex = useMemo(() => {
    if (!isRunning || !status) return -1;
    return phaseSteps.findIndex((step) => step.phase === status.phase);
  }, [isRunning, status]);

  const planSummary = useMemo(() => {
    const trigger = asNumber(plan.depthTriggerCm || "0");
    const maxDepth = asNumber(plan.maxDepthCm || "0");
    return {
      trigger: trigger > 0 ? `${(trigger / 100).toFixed(1)} m` : "—",
      maxDepth: maxDepth > 0 ? `${(maxDepth / 100).toFixed(1)} m` : "—",
      repeat: plan.repeatCount,
      runtime: `${plan.maxRuntimeMin} min`,
      statusReport: `${plan.statusInterval100ms} ×100ms`
    };
  }, [plan]);

  const filteredLogs = useMemo(
    () => logs.filter((entry) => (showRaw || !entry.raw) && (showStatus || !entry.status)),
    [logs, showRaw, showStatus]
  );

  useEffect(() => {
    refreshPorts();
    api<Snapshot>("/api/snapshot")
      .then((snapshot) => {
        setConnected(snapshot.connected);
        setConnectedPort(snapshot.port || "");
        if (snapshot.lastStatus && isSelectedDevice(snapshot.lastStatus)) setStatus(snapshot.lastStatus);
        if (snapshot.lastAck && isSelectedDevice(snapshot.lastAck)) setLastAck(snapshot.lastAck);
      })
      .catch((error) => appendLog("error", String(error.message || error)));

    const source = new EventSource("/events");
    source.onmessage = (message) => {
      const event = JSON.parse(message.data);
      handleServerEvent(event);
    };
    source.onerror = () => appendLog("warn", "event stream reconnecting");
    return () => source.close();
  }, []);

  useEffect(() => {
    if (!autoScroll) return;
    terminalRef.current?.scrollTo({ top: terminalRef.current.scrollHeight });
  }, [filteredLogs, autoScroll]);

  useEffect(() => {
    busyActionRef.current = busyAction;
  }, [busyAction]);

  useEffect(() => {
    if (!linkTest || !connected || isRunning) return;
    const ms = Math.max(250, Math.round(Number.parseFloat(linkTestInterval || "1") * 1000));
    const timer = window.setInterval(() => {
      sendCommand("status", false);
    }, ms);
    return () => window.clearInterval(timer);
  }, [linkTest, linkTestInterval, connected, dest, deviceId, isRunning]);

  useEffect(() => {
    setStatus(null);
    setLastAck(null);
  }, [dest, deviceId]);

  useEffect(() => {
    if (!isRunning || !linkTest) return;
    setLinkTest(false);
    appendLog("warn", "SURFACE LINK stopped: RUNNING disables periodic wireless checks");
  }, [isRunning, linkTest]);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("triton-theme", next);
    } catch {
      /* ignore storage errors */
    }
  }

  function appendLog(level: LogEntry["level"], message: string, raw = false, time = new Date().toISOString(), status = false) {
    setLogs((current) => {
      const next = [...current, { id: logId.current++, time, level, message, raw, status }];
      return next.slice(-700);
    });
  }

  function selectedDeviceId(): number | null {
    const parsed = asNumber(deviceId || "");
    return Number.isFinite(parsed) ? parsed : null;
  }

  function isSelectedDevice(payload: { deviceId?: number }) {
    const selected = selectedDeviceId();
    return selected === null || payload.deviceId === selected;
  }

  function handleServerEvent(event: { type: string; time: string; payload: any }) {
    const time = event.time;
    const payload = event.payload;
    if (event.type === "connection") {
      setConnected(Boolean(payload.connected));
      setConnectedPort(payload.port || "");
      return;
    }
    if (event.type === "status") {
      if (!isSelectedDevice(payload)) return;
      setStatus(payload);
      appendLog(
        payload.errorFlags ? "error" : "rx",
        `STATUS dev=0x${payload.deviceId.toString(16).toUpperCase().padStart(2, "0")} seq=${payload.statusSeq} ${payload.state}/${payload.phase} depth=${payload.depthText} temp=${payload.waterTempText} err=${payload.errorFlagsHex}`,
        false,
        time,
        true
      );
      return;
    }
    if (event.type === "ack") {
      if (!isSelectedDevice(payload)) return;
      setLastAck(payload);
      appendLog(
        payload.ok ? "ok" : "error",
        `ACK dev=0x${payload.deviceId.toString(16).toUpperCase().padStart(2, "0")} seq=${payload.ackedSeq} ${payload.command} ${payload.result} state=${payload.state} phase=${payload.phase}`,
        false,
        time
      );
      return;
    }
    if (event.type === "tx") {
      appendLog("tx", `TX seq=${payload.seq} ${payload.command} dest=0x${payload.dest.toString(16).toUpperCase()}`, false, time);
      appendLog("raw", payload.raw, true, time);
      return;
    }
    if (event.type === "raw_rx") {
      appendLog("raw", `RX ${payload.line}`, true, time);
      return;
    }
    if (event.type === "skip") {
      appendLog("raw", `SKIP ${payload.reason}: ${payload.line || ""}`, true, time);
      return;
    }
    if (event.type === "log") {
      if (typeof payload.message === "string" && (payload.message.startsWith("STATUS ") || payload.message.startsWith("ACK "))) {
        return;
      }
      appendLog(payload.level || "info", payload.message, false, time);
    }
  }

  function refreshPorts() {
    api<{ ports: string[] }>("/api/ports")
      .then((payload) => {
        setPorts(payload.ports);
        if (!port && payload.ports.length > 0) setPort(payload.ports[0]);
      })
      .catch((error) => appendLog("error", String(error.message || error)));
  }

  function applyVehicle(name: string) {
    setVehicle(name);
    const next = vehicles.find((item) => item.name === name);
    if (next && next.name !== "Custom") {
      setDest(next.dest);
      setDeviceId(next.deviceId);
    }
  }

  function applyPreset(preset: Preset) {
    setPresetName(preset.name);
    setFlags(preset.flags & MAIN_FIRMWARE_FLAGS_MASK);
    setPlan(clonePlan(preset.plan));
    appendLog("info", `preset ${preset.name} applied`);
  }

  function setPlanField(key: keyof Plan, value: string) {
    setPlan((current) => ({ ...current, [key]: value }));
  }

  function toggleFlag(flag: number) {
    setFlags((current) => (current ^ flag) & MAIN_FIRMWARE_FLAGS_MASK);
  }

  async function connect() {
    if (!port) return;
    setBusyAction("connect");
    try {
      const snapshot = await api<Snapshot>("/api/connect", { method: "POST", body: JSON.stringify({ port }) });
      setConnected(snapshot.connected);
      setConnectedPort(snapshot.port);
    } catch (error: any) {
      appendLog("error", error.message || String(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function disconnect() {
    setBusyAction("disconnect");
    setLinkTest(false);
    try {
      const snapshot = await api<Snapshot>("/api/disconnect", { method: "POST", body: JSON.stringify({}) });
      setConnected(snapshot.connected);
      setConnectedPort("");
    } catch (error: any) {
      appendLog("error", error.message || String(error));
    } finally {
      setBusyAction(null);
    }
  }

  function planPayload() {
    return {
      planFlags: effectiveFlags,
      planId: plan.planId,
      repeatCount: plan.repeatCount,
      maxRuntimeMin: plan.maxRuntimeMin,
      commTimeoutS: "0",
      prepareS: plan.prepareS,
      exhaustOpenS: plan.exhaustOpenS,
      descentCoastS: plan.descentCoastS,
      bottomWaitS: plan.bottomWaitS,
      injectionOpenS: plan.injectionOpenS,
      ascentWaitS: plan.ascentWaitS,
      depthTriggerCm: plan.depthTriggerCm,
      maxDepthCm: plan.maxDepthCm,
      logInterval100ms: plan.logInterval100ms,
      statusInterval100ms: plan.statusInterval100ms
    };
  }

  async function sendCommand(action: string, includePlan = true) {
    if (!connected) {
      appendLog("error", "serial is not connected");
      return;
    }
    if (busyActionRef.current) {
      appendLog("warn", `${action.toUpperCase()} ignored: ${busyActionRef.current.toUpperCase()} is still in progress`);
      return;
    }
    if ((action === "start" || action === "load_start") && linkTest) {
      setLinkTest(false);
      appendLog("warn", "SURFACE LINK stopped before START");
    }
    setBusyAction(action);
    try {
      await api("/api/command", {
        method: "POST",
        body: JSON.stringify({
          action,
          dest,
          deviceId,
          plan: includePlan ? planPayload() : undefined
        })
      });
    } catch (error: any) {
      appendLog("error", error.message || String(error));
    } finally {
      setBusyAction(null);
    }
  }

  const activePreset = presets.find((item) => item.name === presetName);

  return (
    <div className="app">
      <header className="appbar">
        <div className="brand">
          <div className="brand__mark">
            <Waves size={24} />
          </div>
          <div>
            <div className="brand__title">Triton-3 Mission Console</div>
            <div className="brand__sub">TWELITE v3.6 · ControlPlan</div>
          </div>
        </div>

        <div className="connbar">
          <select className="select" value={port} onChange={(event) => setPort(event.target.value)}>
            <option value="">No serial port</option>
            {ports.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <button className="btn ghost icon" onClick={refreshPorts} title="Refresh ports" aria-label="Refresh ports">
            <RefreshCw size={17} />
          </button>
          {connected ? (
            <button className="btn outline" onClick={disconnect} disabled={busyAction === "disconnect"}>
              {busyAction === "disconnect" ? <Loader2 className="spin" size={17} /> : <Unplug size={17} />}
              Disconnect
            </button>
          ) : (
            <button className="btn primary" onClick={connect} disabled={!port || busyAction === "connect"}>
              {busyAction === "connect" ? <Loader2 className="spin" size={17} /> : <Plug size={17} />}
              Connect
            </button>
          )}
          <span className={`status-pill ${connected ? "online" : "offline"}`}>
            <span className="dot" />
            {connected ? `Online · ${connectedPort}` : "Offline"}
          </span>
        </div>

        <div className="appbar__actions">
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button className="btn stop" onClick={() => sendCommand("stop", false)} disabled={!connected || Boolean(busyAction)}>
            <ShieldAlert size={20} />
            STOP SAFE
          </button>
        </div>
      </header>

      <div className={`statusbar ${isError ? "alarm" : ""}`} data-state={currentState}>
        <div className="statusbar__state">
          <span className="state-dot" />
          <div>
            <div className="label">Control State</div>
            <div className="value">{currentState}</div>
          </div>
        </div>
        <span className="statusbar__phase">{currentPhase}</span>
        <div className="statusbar__metrics">
          <QMetric k="Depth" v={status?.depthText || "—"} />
          <QMetric k="Water Temp" v={status?.waterTempText || "—"} />
          <QMetric k="Active Plan" v={status ? String(status.activePlanId) : lastAck ? String(lastAck.activePlanId) : "—"} />
          <QMetric k="Cycle" v={status ? String(status.cycleCount) : "—"} />
          <QMetric
            k="Errors"
            v={status?.errorFlagsHex || "0x0000"}
            tone={isError ? "alarm" : status ? "good" : undefined}
          />
        </div>
      </div>

      <main className="workspace">
        {/* ----------------------------------------------------------- config */}
        <div className="col-config">
          <section className="card">
            <div className="card__head">
              <Crosshair size={17} />
              <h2>Target</h2>
            </div>
            <div className="card__body">
              <div className="pickgrid">
                {vehicles.map((item) => (
                  <button
                    key={item.name}
                    className={`pick ${vehicle === item.name ? "active" : ""}`}
                    onClick={() => applyVehicle(item.name)}
                  >
                    <span className="name">{item.name}</span>
                    <span className="meta">{item.name === "Custom" ? "Manual entry" : `${item.dest} / ${item.deviceId}`}</span>
                  </button>
                ))}
              </div>
              <div className="field-row">
                <label className="field">
                  <span className="lbl">Dest ID</span>
                  <input className="input" value={dest} onChange={(event) => setDest(event.target.value)} />
                </label>
                <label className="field">
                  <span className="lbl">Device ID</span>
                  <input className="input" value={deviceId} onChange={(event) => setDeviceId(event.target.value)} />
                </label>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card__head">
              <Layers size={17} />
              <h2>Mission Preset</h2>
            </div>
            <div className="card__body">
              <div className="pickgrid">
                {presets.map((preset) => (
                  <button
                    key={preset.name}
                    className={`pick ${presetName === preset.name ? "active" : ""}`}
                    onClick={() => applyPreset(preset)}
                  >
                    {preset.legacy && <span className="legacy">{preset.legacy}</span>}
                    <span className="name">{preset.name}</span>
                    <span className="badge">{preset.badge}</span>
                    <span className="desc">{preset.description}</span>
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card__head">
              <ShieldAlert size={17} />
              <h2>Safety Conditions</h2>
            </div>
            <div className="card__body">
              <div className="flag-grid">
                {flagDefs.map(({ flag, label }) => {
                  const on = Boolean(effectiveFlags & flag);
                  return (
                    <button key={flag} className={`flag ${on ? "active" : ""}`} onClick={() => toggleFlag(flag)}>
                      <span className="check">{on && <CheckCircle2 size={13} />}</span>
                      {label}
                    </button>
                  );
                })}
              </div>
              <div className="flag-code">flags 0x{effectiveFlags.toString(16).toUpperCase().padStart(2, "0")}</div>
            </div>
          </section>
        </div>

        {/* ------------------------------------------------------------- plan */}
        <div className="col-plan">
          <section className="card">
            <div className="card__head">
              <Activity size={17} />
              <h2>Plan Overview</h2>
            </div>
            <div className="card__body">
              <div className="plan-head">
                <div>
                  <div className="preset-name">{presetName}</div>
                  <div className="preset-note">
                    {activePreset?.description || "Custom plan"} · repeat {planSummary.repeat}
                  </div>
                </div>
                <div className="summary">
                  <SummaryCell k="Depth Trigger" v={planSummary.trigger} />
                  <SummaryCell k="Max Depth" v={planSummary.maxDepth} />
                  <SummaryCell k="Max Runtime" v={planSummary.runtime} />
                  <SummaryCell k="Status Report" v={planSummary.statusReport} />
                </div>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card__head">
              <Timer size={17} />
              <h2>Phase Timeline</h2>
              {isRunning && <span className="hint">live</span>}
            </div>
            <div className="card__body">
              <div className="timeline">
                {phaseSteps.map((step, index) => {
                  const active = index === activePhaseIndex;
                  const done = activePhaseIndex >= 0 && index < activePhaseIndex;
                  return (
                    <div
                      key={step.short}
                      className={`tl-node ${step.kind ? `kind-${step.kind}` : ""} ${active ? "active" : ""} ${
                        done ? "done" : ""
                      }`}
                    >
                      <span className="nm">{step.short}</span>
                      <span className="sec">{plan[step.key as keyof Plan]}s</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card__head">
              <Send size={17} />
              <h2>Commands</h2>
              {!connected && <span className="hint">connect a port to enable</span>}
            </div>
            <div className="card__body">
              <div className="cmd-deck">
                <button className="btn outline" disabled={!connected || Boolean(busyAction)} onClick={() => sendCommand("load")}>
                  <Send size={18} />
                  LOAD
                </button>
                <button className="btn go" disabled={!connected || Boolean(busyAction)} onClick={() => sendCommand("start")}>
                  <Play size={18} />
                  START
                </button>
                <button className="btn primary" disabled={!connected || Boolean(busyAction)} onClick={() => sendCommand("load_start")}>
                  <CheckCircle2 size={18} />
                  LOAD + START
                </button>
              </div>
              <div className="cmd-util" style={{ marginTop: 9 }}>
                <button className="btn ghost" disabled={!connected || Boolean(busyAction)} onClick={() => sendCommand("status", false)}>
                  <RefreshCw size={17} />
                  STATUS
                </button>
                <button className="btn ghost" disabled={!connected || Boolean(busyAction)} onClick={() => sendCommand("nop", false)}>
                  <Radio size={17} />
                  NOP
                </button>
              </div>
              <div className="cmd-link" style={{ marginTop: 9 }}>
                <label className={`link-toggle ${linkTest ? "active" : ""} ${isRunning ? "disabled" : ""}`}>
                  <input
                    type="checkbox"
                    checked={linkTest}
                    disabled={isRunning}
                    onChange={(event) => setLinkTest(event.target.checked)}
                  />
                  <Clock3 size={16} />
                  SURFACE LINK
                </label>
                <span className="link-interval">
                  every
                  <input
                    value={linkTestInterval}
                    disabled={isRunning}
                    onChange={(event) => setLinkTestInterval(event.target.value)}
                  />
                  s
                </span>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card__head">
              <Gauge size={17} />
              <h2>Plan Parameters</h2>
            </div>
            <div className="card__body">
              <ParamGroup title="ID / Limits">
                <Param label="Plan ID" value={plan.planId} onChange={(v) => setPlanField("planId", v)} />
                <Param label="Repeat" value={plan.repeatCount} onChange={(v) => setPlanField("repeatCount", v)} />
                <Param label="Max Runtime (min)" value={plan.maxRuntimeMin} onChange={(v) => setPlanField("maxRuntimeMin", v)} />
              </ParamGroup>
              <ParamGroup title="Phase Timing">
                <Param label="Prepare (s)" value={plan.prepareS} onChange={(v) => setPlanField("prepareS", v)} />
                <Param label="Exhaust Open (s)" value={plan.exhaustOpenS} onChange={(v) => setPlanField("exhaustOpenS", v)} />
                <Param label="Descent Coast (s)" value={plan.descentCoastS} onChange={(v) => setPlanField("descentCoastS", v)} />
                <Param label="Bottom Wait (s)" value={plan.bottomWaitS} onChange={(v) => setPlanField("bottomWaitS", v)} />
                <Param label="Injection (s)" value={plan.injectionOpenS} onChange={(v) => setPlanField("injectionOpenS", v)} />
                <Param label="Ascent Wait (s)" value={plan.ascentWaitS} onChange={(v) => setPlanField("ascentWaitS", v)} />
              </ParamGroup>
              <ParamGroup title="Depth / Reporting">
                <Param label="Depth Trigger (cm)" value={plan.depthTriggerCm} onChange={(v) => setPlanField("depthTriggerCm", v)} />
                <Param label="Max Depth (cm)" value={plan.maxDepthCm} onChange={(v) => setPlanField("maxDepthCm", v)} />
                <Param label="Log Interval (×100ms)" value={plan.logInterval100ms} onChange={(v) => setPlanField("logInterval100ms", v)} />
                <Param
                  label="Status Interval (×100ms)"
                  value={plan.statusInterval100ms}
                  onChange={(v) => setPlanField("statusInterval100ms", v)}
                />
              </ParamGroup>
            </div>
          </section>
        </div>

        {/* ---------------------------------------------------------- monitor */}
        <div className="col-monitor">
          <section className="card">
            <div className="card__head">
              <Antenna size={17} />
              <h2>Telemetry</h2>
              <span className="hint">{status ? `PC age ${status.pcSeenAgeS}s` : "awaiting data"}</span>
            </div>
            <div className="card__body">
              <div className="tgrid">
                <Tile icon={<Waves size={15} />} k="Depth" v={status?.depthText || "—"} tone="accent" />
                <Tile icon={<Gauge size={15} />} k="Max Depth" v={status?.maxDepthText || "—"} />
                <Tile icon={<Thermometer size={15} />} k="Water Temp" v={status?.waterTempText || "—"} />
                <Tile icon={<Wind size={15} />} k="Pressure" v={status ? pressureText(status.pressureMbar) : "—"} />
                <Tile icon={<Activity size={15} />} k="Valves" v={status?.valveBitsHex || lastAck?.valveBitsHex || "—"} tone="warn" />
                <Tile icon={<Timer size={15} />} k="Elapsed" v={status ? `${status.phaseElapsedS}s` : "—"} />
                <Tile icon={<Clock3 size={15} />} k="Remaining" v={status ? `${status.phaseRemainingS}s` : "—"} />
                <Tile
                  icon={<AlertTriangle size={15} />}
                  k="Errors"
                  v={status?.errorFlagsHex || "0x0000"}
                  tone={isError ? "danger" : status ? "ok" : undefined}
                />
              </div>
              <div className="tfooter">
                <div>
                  <div className="k">GPS Sat</div>
                  <div className="v">{status ? String(status.gpsSat) : "—"}</div>
                </div>
                <div>
                  <div className="k">Last Result</div>
                  <div className="v">{status?.lastCmdResultName || lastAck?.result || "—"}</div>
                </div>
                <div>
                  <div className="k">Cmd Seq</div>
                  <div className="v">{status ? String(status.lastCmdSeq) : "—"}</div>
                </div>
                <div>
                  <div className="k">Status Seq</div>
                  <div className="v">{status ? String(status.statusSeq) : "—"}</div>
                </div>
              </div>
              <div className="tfooter" style={{ gridTemplateColumns: "1fr" }}>
                <div>
                  <div className="k">Status Flags</div>
                  {status && status.statusFlagNames.length > 0 ? (
                    <div className="chips">
                      {status.statusFlagNames.map((name) => (
                        <span key={name} className="chip">
                          {name}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="v">—</div>
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className="card terminal-card">
            <div className="terminal-head">
              <div className="ttl">
                <Terminal size={17} />
                Terminal
              </div>
              <div className="term-controls">
                <label className={`toggle-chip ${showStatus ? "active" : ""}`}>
                  <input type="checkbox" checked={showStatus} onChange={(event) => setShowStatus(event.target.checked)} />
                  STATUS
                </label>
                <label className={`toggle-chip ${showRaw ? "active" : ""}`}>
                  <input type="checkbox" checked={showRaw} onChange={(event) => setShowRaw(event.target.checked)} />
                  RAW
                </label>
                <label className={`toggle-chip ${autoScroll ? "active" : ""}`}>
                  <input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} />
                  AUTO
                </label>
                <button className="term-clear" onClick={() => setLogs([])} title="Clear terminal" aria-label="Clear terminal">
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
            <div ref={terminalRef} className="terminal">
              {filteredLogs.length === 0 ? (
                <div className="term-empty">No messages yet. Connect a port and send a command.</div>
              ) : (
                filteredLogs.map((entry) => (
                  <div key={entry.id} className={`term-line ${entry.level}`}>
                    <span className="t">{formatTime(entry.time)}</span>
                    <span className="m">{entry.message}</span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

function QMetric({ k, v, tone }: { k: string; v: string; tone?: "alarm" | "good" }) {
  return (
    <div className="qmetric">
      <span className="k">{k}</span>
      <span className={`v ${tone || ""}`}>{v}</span>
    </div>
  );
}

function SummaryCell({ k, v }: { k: string; v: string }) {
  return (
    <div className="cell">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  );
}

function ParamGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="param-group">
      <h3>{title}</h3>
      <div className="param-grid">{children}</div>
    </div>
  );
}

function Param({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="param">
      <span className="lbl">{label}</span>
      <input className="input" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function Tile({
  icon,
  k,
  v,
  tone
}: {
  icon: React.ReactNode;
  k: string;
  v: string;
  tone?: "accent" | "warn" | "danger" | "ok";
}) {
  return (
    <div className={`tile ${tone || ""}`}>
      <div className="k">
        {icon}
        <span>{k}</span>
      </div>
      <div className="v">{v}</div>
    </div>
  );
}

// Reuse the root across hot-module reloads to avoid duplicate createRoot() calls.
const container = document.getElementById("root")!;
const store = window as unknown as { __tritonRoot?: ReturnType<typeof createRoot> };
const root = store.__tritonRoot ?? (store.__tritonRoot = createRoot(container));
root.render(<App />);
