import { useState, useEffect, useCallback, useRef } from "react";

// ══════════════════════════════════════════════════════════════
// LUDWIG'S TRAINING HUB — v2 (refactored)
// Conditioning · Gym · BJJ — all in one place
// ══════════════════════════════════════════════════════════════
//
// ARCHITECTURE NOTES (v2)
// - All persistence goes through `storage` (the adapter) and the
//   per-section services: condStore, gymStore, bjjStore.
// - Components NEVER call localStorage / hybridGet / hybridSet directly.
// - Services are async-first (return Promises) so swapping in a
//   Supabase backend later only requires changing the adapter, not
//   any UI code.
// - All storage keys are namespaced under "v2-" so this app cannot
//   read or corrupt data from the original training_hub.jsx (v1).
//
// To migrate to Supabase later, replace the body of `storage.get/set/
// remove` with API calls. Nothing else needs to change.
// ══════════════════════════════════════════════════════════════

// ─── Storage Adapter ─────────────────────────────────────────────
// Thin async wrapper over localStorage. Single point of swap for
// Supabase later. All values are stored as JSON strings.
const storage = {
  async get(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? null : JSON.parse(raw);
    } catch (e) {
      console.error("storage.get failed:", key, e);
      return null;
    }
  },
  async set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error("storage.set failed:", key, e);
      return false;
    }
  },
  async remove(key) {
    try {
      localStorage.removeItem(key);
      return true;
    } catch (e) {
      console.error("storage.remove failed:", key, e);
      return false;
    }
  },
};

// ─── ID generator ────────────────────────────────────────────────
// Stable, sortable, collision-resistant enough for a single-user app.
// Format: <timestamp>-<random>
function genId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Migration helpers ──────────────────────────────────────────
// One-time backfill: ensure every item in an array has a stable id
// and ISO createdAt/updatedAt timestamps. Idempotent — items that
// already have these fields are left untouched. Returns a new array
// and a boolean flag indicating whether any changes were made (so
// callers can decide whether to re-save).
function ensureIds(items) {
  if (!Array.isArray(items)) return { items, changed: false };
  let changed = false;
  const out = items.map(item => {
    if (!item || typeof item !== "object") return item;
    let next = item;
    if (!next.id) {
      next = { ...next, id: genId() };
      changed = true;
    }
    if (!next.createdAt) {
      const iso = next.ts ? new Date(next.ts).toISOString() : new Date().toISOString();
      next = { ...next, createdAt: iso };
      changed = true;
    }
    if (!next.updatedAt) {
      next = { ...next, updatedAt: next.createdAt };
      changed = true;
    }
    return next;
  });
  return { items: out, changed };
}

// ─── Per-section storage services ───────────────────────────────
// Each service exposes: load(), save(data), clear()
// The UI imports nothing else for persistence.

const condStore = {
  KEY: "v2-cond-sessions",
  async load() {
    const data = await storage.get(this.KEY);
    return Array.isArray(data) ? data : [];
  },
  async save(sessions) { return storage.set(this.KEY, sessions); },
  async clear() { return storage.remove(this.KEY); },
};

const gymStore = {
  ENTRIES_KEY:   "v2-gym-entries",    // flat log entries (Slice 3)
  OVERRIDES_KEY: "v2-gym-overrides",  // program edits
  ARCHIVE_KEY:   "v2-gym-archive",    // archived blocks
  async loadEntries()   { return (await storage.get(this.ENTRIES_KEY))   || {}; },
  async saveEntries(d)  { return storage.set(this.ENTRIES_KEY, d); },
  async loadOverrides() { return (await storage.get(this.OVERRIDES_KEY)) || {}; },
  async saveOverrides(d){ return storage.set(this.OVERRIDES_KEY, d); },
  async loadArchive()   { return (await storage.get(this.ARCHIVE_KEY))   || []; },
  async saveArchive(d)  { return storage.set(this.ARCHIVE_KEY, d); },
  async clearAll() {
    await storage.remove(this.ENTRIES_KEY);
    await storage.remove(this.OVERRIDES_KEY);
    await storage.remove(this.ARCHIVE_KEY);
  },
};

const bjjStore = {
  SESSIONS_KEY: "v2-bjj-sessions",
  COMPS_KEY:    "v2-bjj-comps",
  async loadSessions()  { return (await storage.get(this.SESSIONS_KEY)) || { sessions: [] }; },
  async saveSessions(d) { return storage.set(this.SESSIONS_KEY, d); },
  async loadComps()     { return (await storage.get(this.COMPS_KEY))    || []; },
  async saveComps(d)    { return storage.set(this.COMPS_KEY, d); },
  async clearAll() {
    await storage.remove(this.SESSIONS_KEY);
    await storage.remove(this.COMPS_KEY);
  },
};

// ─── Legacy compat shims ────────────────────────────────────────
// The existing UI calls hybridGet/hybridSet directly in many places.
// In Slice 1 we route those calls through the storage adapter so we
// can verify the abstraction works without touching UI code yet.
// Slices 2–5 will progressively replace these call sites with the
// service layer above, and these shims will be deleted.

async function hybridGet(key) {
  const v = await storage.get(key);
  return v == null ? null : (typeof v === "string" ? v : JSON.stringify(v));
}
async function hybridSet(key, value) {
  // Existing code passes JSON strings. Parse before storing so the
  // adapter holds structured data, not double-encoded strings.
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return storage.set(key, parsed);
  } catch {
    return storage.set(key, value);
  }
}

const APP_TABS = [
  { id: "conditioning", label: "Conditioning", icon: "🚴", color: "#f97316" },
  { id: "gym", label: "Gym", icon: "🏋️", color: "#0ea5e9" },
  { id: "bjj", label: "BJJ", icon: "🥋", color: "#6ba3be" },
];


// ══════════════════════════════════════════════════════════════
// CONDITIONING APP
// ══════════════════════════════════════════════════════════════


const COND_STORAGE_KEY = "v2-cond-sessions";

const LEVELS = [
  { name: "Beginner", min: 0, max: 54, color: "#6b7280", bg: "rgba(107,114,128,0.08)", border: "rgba(107,114,128,0.25)" },
  { name: "Trained", min: 55, max: 64, color: "#3b82f6", bg: "rgba(59,130,246,0.08)", border: "rgba(59,130,246,0.25)" },
  { name: "Competitive", min: 65, max: 74, color: "#22c55e", bg: "rgba(34,197,94,0.08)", border: "rgba(34,197,94,0.25)" },
  { name: "High-level BJJ", min: 75, max: 82, color: "#eab308", bg: "rgba(234,179,8,0.08)", border: "rgba(234,179,8,0.25)" },
  { name: "Elite", min: 83, max: 88, color: "#f97316", bg: "rgba(249,115,22,0.08)", border: "rgba(249,115,22,0.3)" },
  { name: "Exceptional", min: 89, max: 999, color: "#a855f7", bg: "rgba(168,85,247,0.08)", border: "rgba(168,85,247,0.3)" },
];

const PHASES = [
  { id: 1, name: "Aerobic base", short: "BASE", weeks: "1–6", color: "#3b82f6" },
  { id: 2, name: "Mixed power", short: "MIXED", weeks: "7–14", color: "#22c55e" },
  { id: 3, name: "Elite output", short: "ELITE", weeks: "15+", color: "#f97316" },
];

const WORKOUTS = {
  1: [
    {
      id: "ss", badge: "SS", badgeColor: "#3b82f6", title: "Steady state ride",
      sub: "Weeks 1–3 · Build aerobic base", dur: "20 min",
      rpmLabel: "Target RPM — avg over work block", rpmSub: "Conversational pace. Could speak in short sentences.",
      rpmRange: "45–55",
      protocol: [
        { k: "Warmup", v: "3 min easy spin (~35 RPM)" },
        { k: "Work", v: "15 min @ 45–55 RPM steady", highlight: "blue" },
        { k: "Cooldown", v: "2 min easy — total 20 min" },
      ],
      intervals: null,
      notes: [
        { type: "green", text: "Progress: +2–3 RPM per week. By week 3 aim for 50–58 RPM at same perceived effort." },
        { type: "side", text: "Feels easy — that's correct. Zone 2 base is built below lactate threshold. If you're breathing hard you're too fast." },
      ],
    },
    {
      id: "z2", badge: "Z2", badgeColor: "#3b82f6", title: "Zone 2 intervals",
      sub: "Weeks 4–6 · Introduce structure", dur: "25 min",
      rpmLabel: "Work block RPM", rpmSub: "Aerobic threshold — nose breathing should still be possible",
      rpmRange: "55–65",
      protocol: [
        { k: "Warmup", v: "3 min easy" },
        { k: "Work", v: "4 min @ 55–65 RPM", highlight: "blue" },
        { k: "Active rest", v: "2 min @ 35–40 RPM" },
        { k: "Rounds", v: "4× = ~25 min total" },
      ],
      intervals: { on: 4, off: 4, color: "blue" },
      notes: [
        { type: "green", text: "Progress: +2 RPM each week. Week 6 goal: 60–68 RPM sustained comfortably across all 4 rounds." },
      ],
    },
  ],
  2: [
    {
      id: "3030", badge: "30/30", badgeColor: "#22c55e", title: "30/30 intervals",
      sub: "Weeks 7–10 · Lactate threshold", dur: "27 min",
      rpmLabel: "Work block RPM (~110% of zone 2 pace)", rpmSub: "Uncomfortable but repeatable across all 10 rounds",
      rpmRange: "68–78",
      protocol: [
        { k: "Warmup + aerobic", v: "4 min build + 10 min @ 58–65 RPM", highlight: "blue" },
        { k: "Work", v: "30 sec @ 68–78 RPM", highlight: "orange" },
        { k: "Rest", v: "30 sec @ ~35 RPM" },
        { k: "Rounds", v: "10× — total ~27 min" },
        { k: "Cooldown", v: "3 min easy" },
      ],
      intervals: { on: 5, off: 5, color: "orange" },
      notes: [
        { type: "green", text: "Progress: when round 10 RPM matches round 1, add 2–3 RPM to target next week." },
        { type: "side", text: "BJJ scramble simulator. Recovery quality between intervals is the actual training adaptation you're building here." },
      ],
    },
    {
      id: "hiit", badge: "HIIT", badgeColor: "#f97316", title: "Sprints + aerobic base",
      sub: "Weeks 11–14 · Full spectrum", dur: "28 min",
      rpmLabel: "Sprint RPM — 10 sec peak", rpmSub: "True max effort. Legs + arms. Not sustainable.",
      rpmRange: "85–100",
      protocol: [
        { k: "Warmup", v: "4 min build" },
        { k: "Block A", v: "8 min @ 60–70 RPM steady", highlight: "blue" },
        { k: "Rest", v: "2 min easy spin" },
        { k: "Block B", v: "8 × [10 sec max / 50 sec easy]", highlight: "orange" },
        { k: "Cooldown", v: "3 min — total ~28 min" },
      ],
      intervals: null,
      notes: [
        { type: "green", text: "Track sprint 1 vs sprint 8. Goal: close the gap to within 5–8 RPM. That's real conditioning." },
        { type: "side", text: "100 RPM on a 10 sec sprint is realistic for a trained athlete. Holding above 80 RPM across all 8 sprints is the real benchmark." },
      ],
    },
  ],
  3: [
    {
      id: "max", badge: "MAX", badgeColor: "#f97316", title: "Max effort repeats",
      sub: "Weeks 15–18 · Peak alactic power", dur: "26 min",
      rpmLabel: "Peak sprint RPM — 15 sec effort", rpmSub: "All-out. Full recovery between efforts.",
      rpmRange: "95–110",
      protocol: [
        { k: "Warmup", v: "5 min with 2 build sprints" },
        { k: "Sprint", v: "15 sec absolute max effort", highlight: "orange" },
        { k: "Rest", v: "2 min 45 sec easy spin" },
        { k: "Rounds", v: "6 — total ~26 min" },
        { k: "Cooldown", v: "3 min easy" },
      ],
      intervals: null,
      notes: [
        { type: "green", text: "Progress: when all 6 sprints hold 95+, extend sprint to 20 sec. Do NOT cut rest short." },
        { type: "side", text: "Pure ATP-CP work. Long rest is intentional — it's what lets you actually hit max output. Cutting rest kills the adaptation." },
        { type: "red", text: "110+ RPM on a 15 sec effort at 90 kg is genuinely exceptional. If you hit it, trust it." },
      ],
    },
    {
      id: "test", badge: "TEST", badgeColor: "#eab308", title: "10-min benchmark test",
      sub: "Every 4 weeks — track objectively", dur: "20 min",
      rpmLabel: null, rpmSub: null, rpmRange: null,
      protocol: [
        { k: "Warmup", v: "5 min easy build" },
        { k: "Test", v: "10 min all-out — max average RPM", highlight: "orange" },
        { k: "Record", v: "Average RPM (primary) + peak RPM" },
        { k: "Cooldown", v: "5 min easy" },
      ],
      intervals: null,
      notes: [],
      showLevels: true,
    },
  ],
};

const ROADMAP = [
  { weeks: "1–3", phase: "Base", phaseColor: "#3b82f6", workout: "Steady state", rpm: "45–55", rpmColor: "#3b82f6", time: "20 min" },
  { weeks: "4–6", phase: "Base", phaseColor: "#3b82f6", workout: "Zone 2 intervals", rpm: "55–65", rpmColor: "#3b82f6", time: "25 min" },
  { weeks: "7–10", phase: "Mixed", phaseColor: "#22c55e", workout: "30/30 intervals", rpm: "68–78", rpmColor: "#22c55e", time: "27 min" },
  { weeks: "11–14", phase: "Mixed", phaseColor: "#22c55e", workout: "Sprints + aerobic", rpm: "85–100", rpmColor: "#f97316", time: "28 min" },
  { weeks: "15–18", phase: "Elite", phaseColor: "#f97316", workout: "Max repeats", rpm: "95–110", rpmColor: "#f97316", time: "26 min" },
  { weeks: "Every 4w", phase: "Test", phaseColor: "#eab308", workout: "10-min benchmark", rpm: "Track avg", rpmColor: "#eab308", time: "20 min" },
];

// ─── Helpers ───
function getLevelForRPM(rpm) {
  for (let i = 0; i < LEVELS.length; i++) {
    if (rpm >= LEVELS[i].min && rpm <= LEVELS[i].max) return i;
  }
  return 0;
}

function getLevelLabel(l) {
  if (l.max === 999) return `${l.min}+ RPM`;
  if (l.min === 0) return `Under ${l.max + 1} RPM`;
  return `${l.min}–${l.max} RPM`;
}

function getPhase(w) {
  return w <= 6 ? { n: 1, name: "Aerobic base" } : w <= 14 ? { n: 2, name: "Mixed power" } : { n: 3, name: "Elite output" };
}

function calcNext(sessions) {
  if (!sessions.length) return null;
  const last = sessions[sessions.length - 1];
  const nw = last.week + 1;
  const base = nw <= 3 ? { min: 45, max: 55 } : nw <= 6 ? { min: 55, max: 65 } : nw <= 10 ? { min: 68, max: 78 } : nw <= 14 ? { min: 85, max: 100 } : { min: 95, max: 110 };
  let tMin, tMax, advice;
  if (sessions.length >= 2) {
    const prev = sessions[sessions.length - 2];
    const d = last.rpm - prev.rpm;
    const r = last.rpe;
    if (d <= 0 && r <= 5) { tMin = last.rpm + 3; tMax = last.rpm + 6; advice = "Stalled but felt easy — push harder."; }
    else if (d <= 0 && r >= 9) { tMin = last.rpm; tMax = last.rpm + 1; advice = "Stalled at max effort — hold and consolidate."; }
    else if (r <= 4) { tMin = last.rpm + 4; tMax = last.rpm + 7; advice = "Felt easy — bigger jump this week."; }
    else if (r >= 9) { tMin = last.rpm + 1; tMax = last.rpm + 2; advice = "Very hard last week — small step up."; }
    else { tMin = last.rpm + 2; tMax = last.rpm + 4; advice = "Standard progression — +2–4 RPM."; }
    tMin = Math.min(tMin, base.max + 6);
    tMax = Math.min(tMax, base.max + 10);
  } else {
    tMin = base.min; tMax = base.max; advice = "Building baseline — hit the target range.";
  }
  return { week: nw, min: Math.round(tMin), max: Math.round(tMax), label: `${Math.round(tMin)}–${Math.round(tMax)} RPM`, phase: getPhase(nw).name, advice };
}

// ─── Storage ───
async function loadSessions() {
  try {
    const result = await hybridGet(COND_STORAGE_KEY);
    const raw = result ? JSON.parse(result) : [];
    const { items, changed } = ensureIds(raw);
    if (changed) await hybridSet(COND_STORAGE_KEY, JSON.stringify(items));
    return items;
  } catch { return []; }
}

async function saveSessions(sessions) {
  try {
    await hybridSet(COND_STORAGE_KEY, JSON.stringify(sessions));
  } catch (e) { console.error("Save failed:", e); }
}

// ─── Components ───
function LevelBar({ currentRPM, compact = false }) {
  const idx = currentRPM != null ? getLevelForRPM(currentRPM) : -1;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: compact ? 4 : 6 }}>
      {LEVELS.map((l, i) => {
        const isCurrent = i === idx;
        return (
          <div key={i} style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: compact ? "8px 10px" : "10px 12px",
            borderRadius: 8, border: `1px solid ${isCurrent ? l.border : "rgba(255,255,255,0.06)"}`,
            background: isCurrent ? l.bg : "rgba(255,255,255,0.02)",
            transition: "all 0.3s ease",
          }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: l.color, flexShrink: 0 }} />
            <div style={{ fontSize: 12, fontWeight: 600, color: isCurrent ? l.color : "rgba(255,255,255,0.6)", minWidth: compact ? 90 : 120 }}>{l.name}</div>
            <div style={{ marginLeft: "auto", fontSize: compact ? 13 : 15, fontWeight: 800, color: isCurrent ? l.color : "rgba(255,255,255,0.25)", fontFamily: "'Barlow Condensed', sans-serif" }}>{getLevelLabel(l)}</div>
            {isCurrent && <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", padding: "2px 8px", borderRadius: 99, background: l.bg, color: l.color, border: `1px solid ${l.border}`, whiteSpace: "nowrap" }}>YOU</div>}
          </div>
        );
      })}
    </div>
  );
}

function RPMChart({ sessions }) {
  const data = sessions.slice(-12);
  if (data.length < 2) return <div style={{ textAlign: "center", padding: "30px 0", color: "rgba(255,255,255,0.2)", fontSize: 12 }}>Log 2+ sessions to see chart</div>;
  const rpms = data.map(s => s.rpm);
  const minR = Math.min(...rpms) - 8;
  const maxR = Math.max(...rpms) + 8;
  const W = 600, H = 140;
  const pts = data.map((s, i) => ({ x: (i / (data.length - 1)) * (W - 40) + 20, y: H - ((s.rpm - minR) / (maxR - minR)) * (H - 30) - 15, rpm: s.rpm, week: s.week }));
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const area = `M ${pts[0].x} ${H} L ${line.replace(/M /, "")} L ${pts[pts.length - 1].x} ${H} Z`;
  const [hover, setHover] = useState(null);

  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", overflow: "visible" }}>
        <defs>
          <linearGradient id="rpmGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f97316" stopOpacity="0.2" />
            <stop offset="100%" stopColor="#f97316" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 1, 2].map(i => {
          const y = 10 + (H - 30) * i / 2;
          const v = Math.round(maxR - (maxR - minR) * i / 2);
          return <g key={i}><line x1="20" y1={y} x2={W - 20} y2={y} stroke="rgba(255,255,255,0.05)" strokeWidth="1" /><text x="22" y={y - 4} fill="rgba(255,255,255,0.2)" fontSize="9" fontFamily="Barlow, sans-serif">{v}</text></g>;
        })}
        <path d={area} fill="url(#rpmGrad)" />
        <path d={line} fill="none" stroke="#f97316" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        {pts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={hover === i ? 6 : 4} fill="#f97316" stroke="#0a0a0a" strokeWidth="2"
            style={{ cursor: "pointer", transition: "r 0.15s ease" }}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
        ))}
        {hover !== null && (
          <g>
            <rect x={pts[hover].x - 28} y={pts[hover].y - 30} width="56" height="20" rx="4" fill="rgba(0,0,0,0.85)" stroke="rgba(249,115,22,0.4)" strokeWidth="1" />
            <text x={pts[hover].x} y={pts[hover].y - 16} textAnchor="middle" fill="#f97316" fontSize="11" fontWeight="700" fontFamily="Barlow Condensed, sans-serif">{pts[hover].rpm} RPM</text>
          </g>
        )}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "rgba(255,255,255,0.25)", marginTop: 4, padding: "0 4px" }}>
        {data.map((s, i) => <span key={i}>Wk{s.week}</span>)}
      </div>
    </div>
  );
}

function RPEChart({ sessions }) {
  const data = sessions.slice(-12);
  if (data.length < 2) return <div style={{ textAlign: "center", padding: "30px 0", color: "rgba(255,255,255,0.2)", fontSize: 12 }}>Log 2+ sessions to see effort trend</div>;
  const W = 600, H = 120;
  const gap = (W - 40) / data.length;
  const bw = Math.max(12, gap - 6);
  const getColor = rpe => rpe <= 3 ? "#22c55e" : rpe <= 6 ? "#eab308" : rpe <= 8 ? "#f97316" : "#ef4444";

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }}>
        {data.map((s, i) => {
          const x = 20 + i * gap + (gap - bw) / 2;
          const h = (s.rpe / 10) * (H - 25);
          const y = H - h - 10;
          return (
            <g key={i}>
              <rect x={x} y={y} width={bw} height={h} rx="4" fill={getColor(s.rpe)} opacity="0.7" />
              <text x={x + bw / 2} y={H - 1} textAnchor="middle" fill="rgba(255,255,255,0.25)" fontSize="9" fontFamily="Barlow, sans-serif">{s.rpe}</text>
            </g>
          );
        })}
      </svg>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
        {[["1–3 Easy", "#22c55e"], ["4–6 Moderate", "#eab308"], ["7–8 Hard", "#f97316"], ["9–10 Max", "#ef4444"]].map(([label, color]) => (
          <span key={label} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 99, fontWeight: 600, background: `${color}15`, color }}>{label}</span>
        ))}
      </div>
    </div>
  );
}

function TargetBanner({ next }) {
  if (!next) return null;
  return (
    <div style={{
      background: "linear-gradient(135deg, rgba(249,115,22,0.12), rgba(249,115,22,0.04))",
      border: "1px solid rgba(249,115,22,0.3)", borderRadius: 10,
      padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between",
      marginBottom: 14,
    }}>
      <div>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#f97316", marginBottom: 3 }}>This week's target</div>
        <div style={{ fontSize: 20, fontWeight: 900, color: "#f0f0ee", fontFamily: "'Barlow Condensed', sans-serif" }}>{next.label}</div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>Week {next.week} · {next.phase}</div>
        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", marginTop: 2 }}>{next.advice}</div>
      </div>
    </div>
  );
}

function WorkoutCard({ workout, bestRPM }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{
      background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)",
      borderRadius: 12, overflow: "hidden", marginBottom: 10,
      transition: "border-color 0.2s ease",
    }}>
      <div onClick={() => setOpen(!open)} style={{
        padding: "14px 16px", display: "flex", alignItems: "center", gap: 12,
        cursor: "pointer", transition: "background 0.15s ease",
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 10, fontWeight: 900, fontFamily: "'Barlow Condensed', sans-serif", flexShrink: 0,
          background: `${workout.badgeColor}15`, color: workout.badgeColor, border: `1px solid ${workout.badgeColor}40`,
        }}>{workout.badge}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#f0f0ee" }}>{workout.title}</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 1 }}>{workout.sub}</div>
        </div>
        <div style={{ fontSize: 13, fontWeight: 700, color: "rgba(255,255,255,0.3)", fontFamily: "'Barlow Condensed', sans-serif", whiteSpace: "nowrap" }}>{workout.dur}</div>
        <div style={{ color: "rgba(255,255,255,0.25)", fontSize: 10, transition: "transform 0.3s ease", transform: open ? "rotate(180deg)" : "rotate(0)" }}>▼</div>
      </div>
      <div style={{
        maxHeight: open ? 800 : 0, overflow: "hidden",
        transition: "max-height 0.4s cubic-bezier(0.4, 0, 0.2, 1)",
      }}>
        <div style={{ padding: "0 16px 16px" }}>
          {workout.rpmRange && (
            <div style={{
              background: "rgba(249,115,22,0.08)", border: "1px solid rgba(249,115,22,0.25)",
              borderRadius: 10, padding: "12px 14px", marginBottom: 12,
              display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <div>
                <div style={{ fontSize: 11, color: "#f97316", fontWeight: 600 }}>{workout.rpmLabel}</div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginTop: 2 }}>{workout.rpmSub}</div>
              </div>
              <div style={{ fontSize: 30, fontWeight: 900, color: "#f97316", fontFamily: "'Barlow Condensed', sans-serif", lineHeight: 1 }}>{workout.rpmRange}</div>
            </div>
          )}
          <div style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, padding: 12, marginBottom: 10 }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", marginBottom: 10 }}>Protocol</div>
            {workout.protocol.map((row, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "6px 0", borderBottom: i < workout.protocol.length - 1 ? "1px solid rgba(255,255,255,0.05)" : "none", fontSize: 12 }}>
                <span style={{ color: "rgba(255,255,255,0.35)" }}>{row.k}</span>
                <span style={{ fontWeight: 600, color: row.highlight === "orange" ? "#f97316" : row.highlight === "blue" ? "#3b82f6" : "#f0f0ee" }}>{row.v}</span>
              </div>
            ))}
          </div>
          {workout.intervals && (
            <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height: 32, margin: "8px 0" }}>
              {Array.from({ length: workout.intervals.on + workout.intervals.off }).map((_, i) => {
                const isOn = i % 2 === 0;
                return <div key={i} style={{
                  flex: 1, borderRadius: "3px 3px 0 0",
                  height: isOn ? "100%" : "35%",
                  background: isOn ? (workout.intervals.color === "blue" ? "#3b82f6" : "#f97316") : "rgba(255,255,255,0.08)",
                  transition: "height 0.3s ease",
                }} />;
              })}
            </div>
          )}
          {workout.notes?.map((note, i) => (
            <div key={i} style={{
              marginTop: 8, padding: "10px 13px", fontSize: 11, lineHeight: 1.6, borderRadius: note.type === "side" ? "0 7px 7px 0" : 7,
              ...(note.type === "green" ? { background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.2)", color: "#22c55e" } :
                note.type === "red" ? { background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "#ef4444" } :
                  { borderLeft: "2px solid #f97316", background: "rgba(255,255,255,0.02)", color: "rgba(255,255,255,0.4)" }),
            }}>{note.text}</div>
          ))}
          {workout.showLevels && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(255,255,255,0.3)", marginBottom: 10 }}>Performance levels</div>
              <LevelBar currentRPM={bestRPM} compact />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main App ───
function ConditioningApp() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState("program");
  const [phase, setPhase] = useState(1);
  const [rpmInput, setRpmInput] = useState("");
  const [weekInput, setWeekInput] = useState("");
  const [noteInput, setNoteInput] = useState("");
  const [selRPE, setSelRPE] = useState(null);
  const [logSuccess, setLogSuccess] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const pageRef = useRef(null);

  useEffect(() => {
    loadSessions().then(data => {
      setSessions(data);
      if (data.length > 0) setWeekInput(String(data[data.length - 1].week + 1));
      else setWeekInput("1");
      setLoading(false);
    });
  }, []);

  const save = useCallback(async (newSessions) => {
    setSessions(newSessions);
    await saveSessions(newSessions);
  }, []);

  const best = sessions.length > 0 ? Math.max(...sessions.map(s => s.rpm)) : null;
  const next = calcNext(sessions);
  const currentWeek = sessions.length > 0 ? sessions[sessions.length - 1].week + 1 : 1;
  const currentPhaseInfo = getPhase(currentWeek);

  const handleLog = async () => {
    const rpm = parseInt(rpmInput);
    const week = parseInt(weekInput);
    if (!rpm || rpm < 20 || rpm > 150) { alert("Enter a valid RPM (20–150)"); return; }
    if (!week || week < 1) { alert("Enter a valid week number"); return; }
    if (!selRPE) { alert("Select an RPE score"); return; }
    const now = Date.now();
    const entry = {
      id: genId(),
      rpm, week, rpe: selRPE,
      note: noteInput.trim() || null,
      date: new Date().toLocaleDateString("en-SE", { month: "short", day: "numeric" }),
      ts: now,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
    const newSessions = [...sessions, entry];
    await save(newSessions);
    setRpmInput("");
    setWeekInput(String(week + 1));
    setNoteInput("");
    setSelRPE(null);

    const lvl = LEVELS[getLevelForRPM(rpm)];
    const diff = sessions.length > 0 ? rpm - sessions[sessions.length - 1].rpm : null;
    setLogSuccess({ rpm, level: lvl, diff, hitTarget: next ? (rpm >= next.min) : false });
    setTimeout(() => setLogSuccess(null), 5000);
  };

  const handleClear = async () => {
    await save([]);
    setWeekInput("1");
    setConfirmClear(false);
  };

  const navItems = [
    { id: "program", label: "Program" },
    { id: "log", label: "Log" },
    { id: "dashboard", label: "Dashboard" },
    { id: "roadmap", label: "Roadmap" },
  ];

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", background: "#09090b", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "#f97316", fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 700, letterSpacing: "0.05em" }}>LOADING...</div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#09090b", color: "#f0f0ee", fontFamily: "'Barlow', 'Helvetica Neue', sans-serif", paddingBottom: 60 }}>

      {/* Hero */}
      <div style={{
        background: "linear-gradient(180deg, #111 0%, #09090b 100%)",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        padding: "24px 20px 18px", position: "relative", overflow: "hidden",
      }}>
        <div style={{ position: "absolute", top: -80, right: -80, width: 260, height: 260, background: "radial-gradient(circle, rgba(249,115,22,0.1) 0%, transparent 70%)", pointerEvents: "none" }} />
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.16em", color: "#f97316", textTransform: "uppercase", marginBottom: 6 }}>Sunday Conditioning</div>
        <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 28, fontWeight: 900, lineHeight: 1, color: "#f0f0ee", marginBottom: 5 }}>ASSAULT BIKE PROGRAM</div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.35)" }}>Progressive · 20–30 min · Aerobic base + alactic power</div>
      </div>

      {/* Stats bar */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        {[
          { label: "Next week", value: `Wk ${currentWeek}`, color: "#f97316" },
          { label: "Phase", value: `P${currentPhaseInfo.n}`, color: "#f0f0ee" },
          { label: "Best RPM", value: best || "—", color: "#22c55e" },
          { label: "Sessions", value: sessions.length, color: "#f0f0ee" },
        ].map((s, i) => (
          <div key={i} style={{ background: "#111", padding: "12px 14px", borderRight: i < 3 ? "1px solid rgba(255,255,255,0.06)" : "none" }}>
            <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 3 }}>{s.label}</div>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 17, fontWeight: 700, color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Nav */}
      <nav style={{ display: "flex", background: "#111", borderBottom: "1px solid rgba(255,255,255,0.06)", overflow: "auto" }}>
        {navItems.map(item => (
          <button key={item.id} onClick={() => setPage(item.id)} style={{
            flex: 1, minWidth: 80, padding: "14px 8px",
            fontFamily: "'Barlow Condensed', sans-serif", fontSize: 12, fontWeight: 700,
            letterSpacing: "0.08em", textTransform: "uppercase",
            color: page === item.id ? "#f97316" : "rgba(255,255,255,0.25)",
            background: "none", border: "none",
            borderBottom: `2px solid ${page === item.id ? "#f97316" : "transparent"}`,
            cursor: "pointer", transition: "all 0.2s ease", whiteSpace: "nowrap",
          }}>{item.label}</button>
        ))}
      </nav>

      {/* Pages */}
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "18px 16px" }}>

        {/* ─── PROGRAM ─── */}
        {page === "program" && (
          <div style={{ animation: "fadeIn 0.3s ease" }}>
            <TargetBanner next={next} />
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", color: "rgba(255,255,255,0.25)", textTransform: "uppercase", margin: "16px 0 10px" }}>Select phase</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginBottom: 16 }}>
              {PHASES.map(p => (
                <div key={p.id} onClick={() => setPhase(p.id)} style={{
                  background: phase === p.id ? `${p.color}12` : "rgba(255,255,255,0.03)",
                  border: `1px solid ${phase === p.id ? `${p.color}50` : "rgba(255,255,255,0.06)"}`,
                  borderRadius: 10, padding: "12px 8px", cursor: "pointer", textAlign: "center",
                  transition: "all 0.2s ease",
                }}>
                  <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 20, fontWeight: 900, color: phase === p.id ? p.color : "rgba(255,255,255,0.2)", lineHeight: 1, marginBottom: 3 }}>0{p.id}</div>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: phase === p.id ? "#f0f0ee" : "rgba(255,255,255,0.3)" }}>{p.name}</div>
                  <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", marginTop: 2 }}>{p.weeks}</div>
                </div>
              ))}
            </div>
            {WORKOUTS[phase]?.map(w => <WorkoutCard key={w.id} workout={w} bestRPM={best} />)}
          </div>
        )}

        {/* ─── LOG ─── */}
        {page === "log" && (
          <div style={{ animation: "fadeIn 0.3s ease" }}>
            <TargetBanner next={next} />

            {/* Success toast */}
            {logSuccess && (
              <div style={{
                background: "linear-gradient(135deg, rgba(34,197,94,0.12), rgba(34,197,94,0.04))",
                border: "1px solid rgba(34,197,94,0.3)", borderRadius: 12,
                padding: 16, marginBottom: 14, animation: "slideDown 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ fontSize: 28 }}>✓</div>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "'Barlow Condensed', sans-serif", color: "#22c55e" }}>{logSuccess.rpm} RPM logged</div>
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 2 }}>
                      Level: {logSuccess.level.name}
                      {logSuccess.diff !== null && <span style={{ color: logSuccess.diff >= 0 ? "#22c55e" : "#ef4444", marginLeft: 8 }}>{logSuccess.diff >= 0 ? "+" : ""}{logSuccess.diff} RPM vs last</span>}
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", color: "rgba(255,255,255,0.25)", textTransform: "uppercase", margin: "16px 0 10px" }}>Log session</div>
            <div style={{
              background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: 12, padding: 16,
            }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.3)", marginBottom: 6 }}>RPM achieved</div>
                  <input type="number" value={rpmInput} onChange={e => setRpmInput(e.target.value)} placeholder="e.g. 62" min="20" max="150" style={{
                    width: "100%", background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8,
                    padding: "10px 12px", fontSize: 16, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700,
                    color: "#f0f0ee", outline: "none",
                  }} />
                </div>
                <div>
                  <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.3)", marginBottom: 6 }}>Week #</div>
                  <input type="number" value={weekInput} onChange={e => setWeekInput(e.target.value)} placeholder="e.g. 1" min="1" max="52" style={{
                    width: "100%", background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8,
                    padding: "10px 12px", fontSize: 16, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700,
                    color: "#f0f0ee", outline: "none",
                  }} />
                </div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.3)", marginBottom: 6 }}>RPE — how hard did it feel?</div>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                  {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
                    <button key={n} onClick={() => setSelRPE(n)} style={{
                      width: 36, height: 36, borderRadius: 8,
                      border: `1px solid ${selRPE === n ? "#f97316" : "rgba(255,255,255,0.08)"}`,
                      background: selRPE === n ? "#f97316" : "rgba(0,0,0,0.3)",
                      color: selRPE === n ? "#fff" : "rgba(255,255,255,0.3)",
                      fontSize: 13, fontWeight: 700, cursor: "pointer",
                      transition: "all 0.15s ease",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      transform: selRPE === n ? "scale(1.1)" : "scale(1)",
                    }}>{n}</button>
                  ))}
                </div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.3)", marginBottom: 6 }}>Notes (optional)</div>
                <input type="text" value={noteInput} onChange={e => setNoteInput(e.target.value)} placeholder="e.g. felt sluggish, after open mat..." style={{
                  width: "100%", background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8,
                  padding: "10px 12px", fontSize: 13, fontFamily: "'Barlow', sans-serif",
                  color: "#f0f0ee", outline: "none",
                }} />
              </div>

              <button onClick={handleLog} style={{
                width: "100%", padding: "12px", background: "#f97316", border: "none", borderRadius: 10,
                fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, fontWeight: 900,
                letterSpacing: "0.05em", color: "#fff", cursor: "pointer",
                transition: "opacity 0.15s ease, transform 0.15s ease",
              }}>LOG SESSION →</button>
            </div>

            {/* Recent sessions */}
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", color: "rgba(255,255,255,0.25)", textTransform: "uppercase", margin: "20px 0 10px" }}>Recent sessions</div>
            <div style={{
              background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: 12, padding: 16,
            }}>
              {sessions.length === 0 ? (
                <div style={{ textAlign: "center", padding: "24px 0", color: "rgba(255,255,255,0.2)" }}>
                  <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.4 }}>📋</div>
                  <div style={{ fontSize: 12 }}>No sessions yet.</div>
                </div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr>
                        {["Week", "Date", "RPM", "RPE", "Level", ""].map((h, i) => (
                          <th key={i} style={{ textAlign: "left", fontSize: 9, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: "rgba(255,255,255,0.25)", padding: "0 6px 8px 0", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...sessions].reverse().slice(0, 10).map((s, i) => {
                        const lv = LEVELS[getLevelForRPM(s.rpm)];
                        return (
                          <tr key={i} style={{ animation: `fadeIn 0.3s ease ${i * 0.05}s both` }}>
                            <td style={{ padding: "8px 6px 8px 0", borderBottom: "1px solid rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.5)" }}>Wk {s.week}</td>
                            <td style={{ padding: "8px 6px 8px 0", borderBottom: "1px solid rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.4)" }}>{s.date}</td>
                            <td style={{ padding: "8px 6px 8px 0", borderBottom: "1px solid rgba(255,255,255,0.04)", color: "#f97316", fontWeight: 700, fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15 }}>{s.rpm}</td>
                            <td style={{ padding: "8px 6px 8px 0", borderBottom: "1px solid rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.5)" }}>{s.rpe}/10</td>
                            <td style={{ padding: "8px 6px 8px 0", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                                <span style={{ width: 8, height: 8, borderRadius: "50%", background: lv.color, display: "inline-block" }} />
                                <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 11 }}>{lv.name}</span>
                              </span>
                            </td>
                            <td style={{ padding: "8px 0 8px 0", borderBottom: "1px solid rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.25)", fontSize: 10, maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.note || ""}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ─── DASHBOARD ─── */}
        {page === "dashboard" && (
          <div style={{ animation: "fadeIn 0.3s ease" }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", color: "rgba(255,255,255,0.25)", textTransform: "uppercase", margin: "16px 0 10px" }}>Overview</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
              {[
                { label: "Current week", value: sessions.length > 0 ? currentWeek : "—", sub: sessions.length > 0 ? currentPhaseInfo.name : "No sessions yet", color: "#f97316" },
                { label: "Best RPM", value: best ? `${best}` : "—", sub: best ? `Week ${sessions.reduce((a, b) => b.rpm > a.rpm ? b : a).week}` : "—", color: "#22c55e" },
                { label: "Last session", value: sessions.length > 0 ? `${sessions[sessions.length - 1].rpm}` : "—", sub: sessions.length > 0 ? `RPE ${sessions[sessions.length - 1].rpe}/10` : "—", color: "#3b82f6" },
                { label: "Total sessions", value: sessions.length, sub: "Sundays logged", color: "#f0f0ee" },
              ].map((card, i) => (
                <div key={i} style={{
                  background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)",
                  borderRadius: 12, padding: 14,
                }}>
                  <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.25)", marginBottom: 6 }}>{card.label}</div>
                  <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 26, fontWeight: 900, color: card.color, lineHeight: 1 }}>{card.value}</div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 4 }}>{card.sub}</div>
                </div>
              ))}
            </div>

            {/* Level */}
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", color: "rgba(255,255,255,0.25)", textTransform: "uppercase", margin: "16px 0 10px" }}>Your level</div>
            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: 14, marginBottom: 14 }}>
              {best ? <LevelBar currentRPM={best} /> : <div style={{ textAlign: "center", padding: "20px 0", color: "rgba(255,255,255,0.2)", fontSize: 12 }}>Log a session to see your level.</div>}
            </div>

            {/* RPM Chart */}
            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: 16, marginBottom: 10 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.25)", marginBottom: 14 }}>RPM progress</div>
              <RPMChart sessions={sessions} />
            </div>

            {/* RPE Chart */}
            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: 16, marginBottom: 10 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.25)", marginBottom: 14 }}>Effort (RPE) — lower over time = easier</div>
              <RPEChart sessions={sessions} />
            </div>

            {/* Streak */}
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", color: "rgba(255,255,255,0.25)", textTransform: "uppercase", margin: "16px 0 10px" }}>Consistency</div>
            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: 14, marginBottom: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: "rgba(255,255,255,0.25)", marginBottom: 8 }}>Last 12 Sundays</div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {Array.from({ length: 12 }).map((_, i) => {
                  const s = sessions.slice(-12)[i];
                  const c = s ? (s.rpe <= 3 ? "#22c55e" : s.rpe <= 6 ? "#eab308" : s.rpe <= 8 ? "#f97316" : "#ef4444") : "rgba(255,255,255,0.06)";
                  return <div key={i} style={{ width: 14, height: 14, borderRadius: 3, background: c, transition: "background 0.3s ease" }} />;
                })}
              </div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 8 }}>
                {sessions.length === 0 ? "No sessions logged yet." : `${sessions.length} session${sessions.length > 1 ? "s" : ""} total · Avg RPM: ${Math.round(sessions.reduce((a, b) => a + b.rpm, 0) / sessions.length)}`}
              </div>
            </div>

            {/* Smart progression */}
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", color: "rgba(255,255,255,0.25)", textTransform: "uppercase", margin: "16px 0 10px" }}>Smart progression</div>
            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: 14, marginBottom: 14 }}>
              {sessions.length < 2 ? (
                <div style={{ textAlign: "center", padding: "20px 0", color: "rgba(255,255,255,0.2)", fontSize: 12 }}>Log 2+ sessions to unlock auto-progression.</div>
              ) : (() => {
                const last = sessions[sessions.length - 1];
                const prev = sessions[sessions.length - 2];
                const d = last.rpm - prev.rpm;
                const avgRPE = Math.round(sessions.slice(-4).reduce((a, b) => a + b.rpe, 0) / Math.min(sessions.length, 4));
                return (
                  <>
                    <div style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, padding: 12, marginBottom: 10 }}>
                      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", marginBottom: 10 }}>Analysis</div>
                      {[
                        { k: "Last RPM", v: last.rpm, c: "#f0f0ee" },
                        { k: "Week-on-week", v: `${d >= 0 ? "+" : ""}${d} RPM`, c: d > 0 ? "#22c55e" : d < 0 ? "#ef4444" : "rgba(255,255,255,0.4)" },
                        { k: "Avg RPE (last 4)", v: `${avgRPE}/10`, c: "#f0f0ee" },
                        { k: "Sessions logged", v: sessions.length, c: "#f0f0ee" },
                      ].map((row, i) => (
                        <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "5px 0", borderBottom: i < 3 ? "1px solid rgba(255,255,255,0.05)" : "none", fontSize: 12 }}>
                          <span style={{ color: "rgba(255,255,255,0.35)" }}>{row.k}</span>
                          <span style={{ fontWeight: 600, color: row.c }}>{row.v}</span>
                        </div>
                      ))}
                    </div>
                    {next && (
                      <div style={{
                        background: "linear-gradient(135deg, rgba(249,115,22,0.1), rgba(249,115,22,0.04))",
                        border: "1px solid rgba(249,115,22,0.3)", borderRadius: 10, padding: "13px 15px",
                      }}>
                        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#f97316", marginBottom: 8 }}>Next Sunday's target</div>
                        {[
                          { k: "Target RPM", v: next.label, c: "#f97316" },
                          { k: "Phase", v: next.phase, c: "#f0f0ee" },
                          { k: "Why", v: next.advice, c: "rgba(255,255,255,0.5)", fw: 400 },
                        ].map((row, i) => (
                          <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, marginBottom: i < 2 ? 4 : 0 }}>
                            <span style={{ color: "rgba(255,255,255,0.35)" }}>{row.k}</span>
                            <span style={{ fontWeight: row.fw || 700, color: row.c }}>{row.v}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>

            {/* Clear */}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8, gap: 8 }}>
              {confirmClear ? (
                <>
                  <span style={{ fontSize: 11, color: "#ef4444", alignSelf: "center" }}>Are you sure?</span>
                  <button onClick={handleClear} style={{ background: "none", border: "1px solid #ef4444", borderRadius: 6, color: "#ef4444", fontSize: 11, padding: "5px 10px", cursor: "pointer" }}>Yes, clear all</button>
                  <button onClick={() => setConfirmClear(false)} style={{ background: "none", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, color: "rgba(255,255,255,0.4)", fontSize: 11, padding: "5px 10px", cursor: "pointer" }}>Cancel</button>
                </>
              ) : (
                <button onClick={() => setConfirmClear(true)} style={{ background: "none", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, color: "rgba(255,255,255,0.25)", fontSize: 11, padding: "5px 10px", cursor: "pointer", transition: "all 0.15s" }}>Clear all data</button>
              )}
            </div>
          </div>
        )}

        {/* ─── ROADMAP ─── */}
        {page === "roadmap" && (
          <div style={{ animation: "fadeIn 0.3s ease" }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", color: "rgba(255,255,255,0.25)", textTransform: "uppercase", margin: "16px 0 10px" }}>How to progress</div>
            <div style={{
              background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: 12, padding: 14, marginBottom: 14,
            }}>
              <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", lineHeight: 1.7, marginBottom: 12 }}>
                Log RPM and RPE every Sunday. The app calculates next week's target based on both numbers — not just raw RPM.
              </div>
              <div style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, padding: 12 }}>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", marginBottom: 10 }}>What to log</div>
                {[
                  { k: "Steady state / zone 2", v: "Average RPM over work block", c: "#3b82f6" },
                  { k: "30/30 intervals", v: "Average RPM on work intervals", c: "#3b82f6" },
                  { k: "Sprint sessions", v: "Peak RPM (best single sprint)", c: "#f97316" },
                  { k: "Benchmark test", v: "Average RPM over full 10 min", c: "#f97316" },
                  { k: "On track", v: "+2–3 RPM per week", c: "#22c55e" },
                ].map((row, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "5px 0", borderBottom: i < 4 ? "1px solid rgba(255,255,255,0.05)" : "none", fontSize: 12 }}>
                    <span style={{ color: "rgba(255,255,255,0.35)" }}>{row.k}</span>
                    <span style={{ fontWeight: 600, color: row.c }}>{row.v}</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", color: "rgba(255,255,255,0.25)", textTransform: "uppercase", margin: "16px 0 10px" }}>Full progression roadmap</div>
            <div style={{
              background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: 12, overflow: "hidden", marginBottom: 14,
            }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: "rgba(255,255,255,0.03)" }}>
                      {["Weeks", "Phase", "Workout", "Target RPM", "Time"].map((h, i) => (
                        <th key={i} style={{ textAlign: "left", fontSize: 9, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: "rgba(255,255,255,0.25)", padding: "10px 8px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ROADMAP.map((row, i) => (
                      <tr key={i}>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.5)" }}>{row.weeks}</td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                          <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 99, textTransform: "uppercase", letterSpacing: "0.05em", background: `${row.phaseColor}15`, color: row.phaseColor }}>{row.phase}</span>
                        </td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.6)" }}>{row.workout}</td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid rgba(255,255,255,0.04)", color: row.rpmColor, fontWeight: 600 }}>{row.rpm}</td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.4)" }}>{row.time}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", color: "rgba(255,255,255,0.25)", textTransform: "uppercase", margin: "16px 0 10px" }}>10-min benchmark levels</div>
            <LevelBar currentRPM={best} />
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", lineHeight: 1.6, marginTop: 10 }}>
              Sustained 10-min output is typically 65–75% of peak sprint RPM due to the air bike's nonlinear resistance curve. These levels reflect real-world distributions from CrossFit, MMA, and combat sports athletes.
            </div>
          </div>
        )}
      </div>

    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// GYM APP
// ══════════════════════════════════════════════════════════════


// ─── CONFIG ───
const GYM_STORAGE_KEY = "v2-gym-entries";
const GYM_PROGRAM_KEY = "v2-gym-overrides";
const GYM_ARCHIVE_KEY = "v2-gym-archive";
const GOALS = { squat: 150, bench: 120, deadlift: 200 };
const WEEK1_START = new Date(2026, 3, 6); // April 6, 2026
const TOTAL_WEEKS = 8;
const INCREMENT = 2.5;

// Accent: warm teal/cyan
const GC = {
  bg: "#0b0c0f", card: "rgba(255,255,255,0.03)", border: "rgba(255,255,255,0.06)",
  accent: "#0ea5e9", accentBg: "rgba(14,165,233,0.1)", accentBorder: "rgba(14,165,233,0.3)",
  green: "#22c55e", greenBg: "rgba(34,197,94,0.1)",
  red: "#ef4444", redBg: "rgba(239,68,68,0.1)",
  yellow: "#eab308", yellowBg: "rgba(234,179,8,0.1)",
  orange: "#f97316",
  text: "#e8e8e6", dim: "rgba(255,255,255,0.35)", dimmer: "rgba(255,255,255,0.2)",
};

const GYM_DAYS = [
  {
    id: "upper", name: "Upper", day: "Monday", color: GC.accent,
    exercises: [
      { id: "bench_top", name: "Bench Press (top set)", sets: 1, repRange: [5, 5], startWeight: 80, is1RM: "bench" },
      { id: "bench_back", name: "Bench Press (back-off)", sets: 3, repRange: [5, 5], startWeight: 73, is1RM: "bench" },
      { id: "chinups", name: "Weighted Chin/Pull-ups", sets: 4, repRange: [4, 6], startWeight: 10 },
      { id: "row", name: "Row (machine)", sets: 3, repRange: [8, 10], startWeight: 80 },
      { id: "curl", name: "Hammer Curl", sets: 2, repRange: [10, 12], startWeight: 15 },
      { id: "pushdown", name: "Rope Pushdown", sets: 2, repRange: [10, 12], startWeight: 21.5 },
    ],
  },
  {
    id: "lower", name: "Lower", day: "Wednesday", color: GC.green,
    exercises: [
      { id: "squat_top", name: "Back Squat (top set)", sets: 1, repRange: [3, 5], startWeight: 100, is1RM: "squat" },
      { id: "squat_back", name: "Back Squat (back-off)", sets: 3, repRange: [5, 6], startWeight: 90, is1RM: "squat" },
      { id: "rdl", name: "Romanian Deadlift", sets: 3, repRange: [6, 8], startWeight: 100 },
      { id: "ttb", name: "Toes-to-Bar", sets: 3, repRange: [8, 15], startWeight: 0, bodyweight: true },
    ],
  },
  {
    id: "full", name: "Full", day: "Fri/Sat/Sun", color: GC.orange,
    exercises: [
      { id: "dead_top", name: "Deadlift (top set)", sets: 1, repRange: [3, 5], startWeight: 120, is1RM: "deadlift" },
      { id: "dead_back", name: "Deadlift (back-off)", sets: 2, repRange: [5, 5], startWeight: 107.5, is1RM: "deadlift" },
      { id: "incline_db", name: "Incline DB Bench (per hand)", sets: 3, repRange: [6, 8], startWeight: 30 },
      { id: "cs_row", name: "Chest Supported Row (per hand)", sets: 3, repRange: [6, 8], startWeight: 30 },
      { id: "bss", name: "Bulgarian Split Squat", sets: 2, repRange: [6, 8], startWeight: 22.5 },
      { id: "deadhang", name: "Dead Hang", sets: 2, repRange: [30, 45], startWeight: 0, bodyweight: true, isTime: true },
    ],
  },
];

// ─── Helpers ───
// ══════════════════════════════════════════════════════════════
// PURE GYM HELPERS
// ──────────────────────────────────────────────────────────────
// All functions in this section are PURE: same inputs → same
// outputs, no side effects, no React state, no storage calls,
// no Date.now() or Math.random() in the return value, no module-
// level mutable state. They take everything they need as arguments
// (days, logData, exercise, etc.) so they're trivially testable
// and can be moved to a separate file later without any wiring.
// ══════════════════════════════════════════════════════════════

/**
 * Estimate 1RM from a working set using Epley's formula.
 * @param {number} weight - working weight in kg
 * @param {number} reps - reps performed at that weight
 * @returns {number} estimated 1RM in kg, rounded
 */
function epley1RM(weight, reps) {
  if (reps <= 0 || weight <= 0) return 0;
  if (reps === 1) return weight;
  return Math.round(weight * (1 + reps / 30));
}

/**
 * Compute the target weight for an exercise in a given week,
 * applying the progression rule: +INCREMENT kg for each prior week
 * where ALL sets hit the top of the rep range.
 * @param {object} exercise - exercise definition (sets, repRange, startWeight)
 * @param {number} weekNum - target week (1-indexed)
 * @param {object} logData - legacy week-keyed log map
 * @returns {number} target weight in kg
 */
function getTargetWeight(exercise, weekNum, logData) {
  let weight = exercise.startWeight;
  for (let w = 1; w < weekNum; w++) {
    const weekLog = logData[`w${w}`];
    if (!weekLog) continue;
    const exLog = weekLog[exercise.id];
    if (!exLog) continue;
    const allSetsHitTop = exLog.reps && exLog.reps.length === exercise.sets &&
      exLog.reps.every(r => r >= exercise.repRange[1]);
    if (allSetsHitTop) weight += INCREMENT;
  }
  return weight;
}

/**
 * Get reps logged in the previous week for an exercise (for "last week" hint).
 * @returns {number[]|null} reps array, or null if no prior data
 */
function getLastWeekReps(exercise, weekNum, logData) {
  if (weekNum <= 1) return null;
  const prev = logData[`w${weekNum - 1}`];
  if (!prev || !prev[exercise.id]) return null;
  return prev[exercise.id].reps || null;
}

/**
 * Find best estimated 1RM across all logged data for a given lift.
 * Now takes `days` as a parameter so it respects program edits via
 * the editor (previously hardcoded GYM_DAYS, missing override changes).
 * @param {string} liftKey - matches exercise.is1RM ("squat" / "bench" / "deadlift")
 * @param {object} logData - legacy week-keyed log map
 * @param {array} days - effective days array (post-overrides)
 * @returns {number} best estimated 1RM in kg
 */
function getBest1RM(liftKey, logData, days) {
  let best = 0;
  (days || []).forEach(day => {
    day.exercises.forEach(ex => {
      if (ex.is1RM !== liftKey) return;
      for (let w = 1; w <= TOTAL_WEEKS; w++) {
        const wl = logData[`w${w}`];
        if (!wl || !wl[ex.id]) continue;
        const reps = wl[ex.id].reps || [];
        const weight = getTargetWeight(ex, w, logData);
        reps.forEach(r => {
          if (r > 0) {
            const e = epley1RM(weight, r);
            if (e > best) best = e;
          }
        });
      }
    });
  });
  return best;
}

/**
 * Compute completion ratio (0..1) for one session = one (week, day).
 * "Done" = a set with reps > 0. "Total" = sum of programmed sets for the day.
 */
function getSessionCompletion(weekNum, dayId, days, logData) {
  const day = (days || []).find(d => d.id === dayId);
  if (!day) return 0;
  const wl = logData[`w${weekNum}`];
  if (!wl) return 0;
  let done = 0, total = 0;
  day.exercises.forEach(ex => {
    total += ex.sets;
    const reps = wl[ex.id]?.reps || [];
    reps.forEach(r => { if (r > 0) done++; });
  });
  return total > 0 ? done / total : 0;
}

/**
 * Compute completion ratio (0..1) for an entire week across all days.
 */
function getWeekCompletion(weekNum, days, logData) {
  let done = 0, total = 0;
  (days || []).forEach(day => {
    day.exercises.forEach(ex => {
      total += ex.sets;
      const reps = logData[`w${weekNum}`]?.[ex.id]?.reps || [];
      reps.forEach(r => { if (r > 0) done++; });
    });
  });
  return total > 0 ? done / total : 0;
}

/**
 * Count how many sessions in the whole block are "complete" (>= 100%).
 * Used by the dashboard "Sessions done" stat.
 */
function countCompletedSessions(days, logData, totalWeeks) {
  let c = 0;
  for (let w = 1; w <= totalWeeks; w++) {
    (days || []).forEach(d => {
      if (getSessionCompletion(w, d.id, days, logData) >= 1) c++;
    });
  }
  return c;
}

// ══════════════════════════════════════════════════════════════
// END PURE GYM HELPERS
// ══════════════════════════════════════════════════════════════

function getGymWeekDates(weekNum) {
  const start = new Date(WEEK1_START);
  start.setDate(start.getDate() + (weekNum - 1) * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const fmt = d => d.toLocaleDateString("en-SE", { month: "short", day: "numeric" });
  return `${fmt(start)} – ${fmt(end)}`;
}

function getCurrentWeekNum() {
  const now = new Date();
  const diff = Math.floor((now - WEEK1_START) / (7 * 24 * 60 * 60 * 1000));
  return Math.max(1, Math.min(TOTAL_WEEKS, diff + 1));
}

// Calculate target weight for a given week based on logged data
// ─── Gym data shape (v2) ────────────────────────────────────────
// PERSISTED SHAPE: a flat array of log entries
//   { id, weekNum, dayId, exerciseId, reps, completed, createdAt, updatedAt }
// IN-MEMORY SHAPE (legacy, used by UI/helpers): a week-keyed map
//   { w1: { exerciseId: { reps: [...], ts } }, w2: {...}, ... }
//
// We persist the flat shape (backend-friendly, stable ids, easy to
// query/extend), but reconstruct the legacy in-memory shape on load
// so existing UI code keeps working unchanged. Slice 4 will replace
// the in-memory map with selectors that read directly from entries.

function entriesToWeekMap(entries) {
  const map = {};
  if (!Array.isArray(entries)) return map;
  for (const e of entries) {
    if (!e || typeof e.weekNum !== "number" || !e.exerciseId) continue;
    const key = `w${e.weekNum}`;
    if (!map[key]) map[key] = {};
    map[key][e.exerciseId] = { reps: e.reps || [], ts: e.ts || Date.parse(e.updatedAt || e.createdAt || 0) };
  }
  return map;
}

function weekMapToEntries(weekMap) {
  // Reverse: take legacy shape and produce flat entries.
  // Used by the migration on first load and by save() until UI is fully
  // refactored to write entries directly.
  // Entry IDs are deterministic (`gym-w{weekNum}-{exerciseId}`) so that
  // save/load round-trips don't churn identities — the same logical
  // entry always has the same id, which is what backend sync needs.
  const out = [];
  if (!weekMap || typeof weekMap !== "object") return out;
  for (const wkey of Object.keys(weekMap)) {
    const m = wkey.match(/^w(\d+)$/);
    if (!m) continue;
    const weekNum = parseInt(m[1], 10);
    const week = weekMap[wkey] || {};
    for (const exerciseId of Object.keys(week)) {
      const slot = week[exerciseId] || {};
      const reps = Array.isArray(slot.reps) ? slot.reps : [];
      const ts = slot.ts || Date.now();
      const iso = new Date(ts).toISOString();
      out.push({
        id: `gym-w${weekNum}-${exerciseId}`,
        weekNum,
        dayId: null, // backfilled by caller via findDayIdForExercise
        exerciseId,
        reps,
        completed: reps.length > 0,
        createdAt: iso,
        updatedAt: iso,
      });
    }
  }
  return out;
}

function findDayIdForExercise(exerciseId) {
  for (const day of GYM_DAYS) {
    if (day.exercises.some(e => e.id === exerciseId)) return day.id;
  }
  return null;
}


// ─── Storage ───
// loadGymData() returns the LEGACY in-memory shape (week-keyed map)
// for UI compatibility, but reads/writes the FLAT entries shape under
// the hood. Migration: if persisted data is the old week-keyed shape,
// convert to flat entries on first load and persist the new shape.
async function loadGymData() {
  try {
    const raw = await storage.get(GYM_STORAGE_KEY);
    if (!raw) return {};
    // Detect shape: array = new flat shape; object with w1/w2 keys = legacy
    if (Array.isArray(raw)) {
      // New shape — backfill any missing ids/timestamps just in case
      const { items, changed } = ensureIds(raw);
      // Also backfill missing dayId fields by exercise lookup
      let dayIdChanged = false;
      const fixed = items.map(e => {
        if (e.dayId) return e;
        const dayId = findDayIdForExercise(e.exerciseId);
        if (dayId) { dayIdChanged = true; return { ...e, dayId }; }
        return e;
      });
      if (changed || dayIdChanged) await storage.set(GYM_STORAGE_KEY, fixed);
      return entriesToWeekMap(fixed);
    }
    // Legacy shape — migrate to flat entries, persist, then return week map
    const entries = weekMapToEntries(raw).map(e => ({
      ...e,
      dayId: findDayIdForExercise(e.exerciseId),
    }));
    await storage.set(GYM_STORAGE_KEY, entries);
    return entriesToWeekMap(entries);
  } catch (e) {
    console.error("loadGymData failed:", e);
    return {};
  }
}

// saveGymData() takes the legacy in-memory shape and persists as flat
// entries. This keeps the existing UI save path working unchanged
// while the persisted data stays in the new shape.
async function saveGymData(weekMap) {
  try {
    const entries = weekMapToEntries(weekMap).map(e => ({
      ...e,
      dayId: findDayIdForExercise(e.exerciseId),
    }));
    await storage.set(GYM_STORAGE_KEY, entries);
  } catch (e) { console.error("saveGymData failed:", e); }
}

// ─── Components ───
function ProgressRing({ pct, color, size = 44, stroke = 4 }) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - Math.min(pct, 1));
  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={stroke} />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={stroke}
        strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 0.5s ease" }} />
    </svg>
  );
}

function OneRMBar({ label, current, goal, color }) {
  const pct = goal > 0 ? Math.min(current / goal, 1) : 0;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: GC.text }}>{label}</span>
        <span style={{ fontSize: 12, color: GC.dim }}>
          <span style={{ color, fontWeight: 700, fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16 }}>{current || "—"}</span>
          <span style={{ margin: "0 4px" }}>/</span>
          <span>{goal} kg</span>
        </span>
      </div>
      <div style={{ height: 8, background: "rgba(255,255,255,0.06)", borderRadius: 4, overflow: "hidden" }}>
        <div style={{
          height: "100%", width: `${pct * 100}%`, background: `linear-gradient(90deg, ${color}, ${color}cc)`,
          borderRadius: 4, transition: "width 0.6s cubic-bezier(0.4, 0, 0.2, 1)",
        }} />
      </div>
      <div style={{ fontSize: 10, color: GC.dimmer, marginTop: 3, textAlign: "right" }}>
        {current > 0 ? `${Math.round(pct * 100)}% of goal` : "No data yet"}
      </div>
    </div>
  );
}

function ExerciseCard({ exercise, weekNum, logData, onLog }) {
  const target = exercise.bodyweight ? "BW" : getTargetWeight(exercise, weekNum, logData);
  const lastReps = getLastWeekReps(exercise, weekNum, logData);
  const currentLog = logData[`w${weekNum}`]?.[exercise.id]?.reps || [];
  const allDone = currentLog.length === exercise.sets && currentLog.every(r => r > 0);

  const handleRepChange = (setIdx, value) => {
    const v = value === "" ? 0 : parseInt(value) || 0;
    const newReps = [...currentLog];
    while (newReps.length < exercise.sets) newReps.push(0);
    newReps[setIdx] = v;
    onLog(exercise.id, newReps);
  };

  return (
    <div style={{
      background: GC.card, border: `1px solid ${allDone ? GC.green + "40" : GC.border}`,
      borderRadius: 12, padding: 14, marginBottom: 8,
      transition: "border-color 0.3s ease",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: GC.text }}>{exercise.name}</div>
          <div style={{ fontSize: 11, color: GC.dim, marginTop: 2 }}>
            {exercise.sets}×{exercise.repRange[0]}{exercise.repRange[0] !== exercise.repRange[1] ? `–${exercise.repRange[1]}` : ""}
            {exercise.isTime ? "s" : ""}
            {!exercise.bodyweight && <span style={{ color: GC.accent, fontWeight: 600, marginLeft: 6 }}>@ {target} kg</span>}
          </div>
        </div>
        {allDone && <div style={{ fontSize: 16, color: GC.green }}>✓</div>}
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        {Array.from({ length: exercise.sets }).map((_, i) => {
          const val = currentLog[i] || 0;
          const hitTop = val >= exercise.repRange[1];
          return (
            <div key={i} style={{ flex: 1 }}>
              <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.06em", color: GC.dimmer, textTransform: "uppercase", marginBottom: 4, textAlign: "center" }}>
                Set {i + 1}
              </div>
              <input
                type="number"
                value={val > 0 ? val : ""}
                onChange={e => handleRepChange(i, e.target.value)}
                placeholder={exercise.isTime ? "sec" : "reps"}
                style={{
                  width: "100%", textAlign: "center",
                  background: val > 0 ? (hitTop ? GC.greenBg : "rgba(14,165,233,0.06)") : "rgba(0,0,0,0.3)",
                  border: `1px solid ${val > 0 ? (hitTop ? GC.green + "40" : GC.accentBorder) : "rgba(255,255,255,0.08)"}`,
                  borderRadius: 8, padding: "8px 4px",
                  fontSize: 16, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700,
                  color: val > 0 ? (hitTop ? GC.green : GC.accent) : GC.text,
                  outline: "none", transition: "all 0.2s ease",
                }}
              />
              {lastReps && lastReps[i] > 0 && (
                <div style={{ fontSize: 9, color: GC.dimmer, textAlign: "center", marginTop: 3 }}>
                  last: {lastReps[i]}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!exercise.bodyweight && allDone && currentLog.every(r => r >= exercise.repRange[1]) && (
        <div style={{
          marginTop: 8, padding: "6px 10px", borderRadius: 6,
          background: GC.greenBg, border: `1px solid ${GC.green}30`,
          fontSize: 10, color: GC.green, fontWeight: 600, textAlign: "center",
          animation: "fadeIn 0.3s ease",
        }}>
          ↑ +{INCREMENT}kg next week
        </div>
      )}
    </div>
  );
}

// ─── Main App ───
function GymApp() {
  const [logData, setLogData] = useState({});
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState("weeks");
  const [selectedWeek, setSelectedWeek] = useState(null);
  const [selectedDay, setSelectedDay] = useState(null);
  const [programOverrides, setProgramOverrides] = useState({});
  const [showEditor, setShowEditor] = useState(false);
  const [archive, setArchive] = useState([]);
  const [confirmNewBlock, setConfirmNewBlock] = useState(false);

  useEffect(() => {
    loadGymData().then(d => { setLogData(d); setLoading(false); });
    hybridGet(GYM_PROGRAM_KEY).then(r => { if (r) try { setProgramOverrides(JSON.parse(r)); } catch {} });
    hybridGet(GYM_ARCHIVE_KEY).then(async r => {
      if (!r) return;
      try {
        const raw = JSON.parse(r);
        const { items, changed } = ensureIds(raw);
        setArchive(items);
        if (changed) await hybridSet(GYM_ARCHIVE_KEY, JSON.stringify(items));
      } catch {}
    });
  }, []);

  // Merge overrides into GYM_DAYS for display
  const effectiveDays = GYM_DAYS.map(day => ({
    ...day,
    exercises: day.exercises.map(ex => ({ ...ex, ...(programOverrides[ex.id] || {}) })),
  }));

  const saveProgram = async (newOverrides) => {
    setProgramOverrides(newOverrides);
    await hybridSet(GYM_PROGRAM_KEY, JSON.stringify(newOverrides));
  };

  const startNewBlock = async () => {
    // Capture final weights from the block that just ended (uses current getTargetWeight logic)
    const finalWeights = {};
    effectiveDays.forEach(day => {
      day.exercises.forEach(ex => {
        if (!ex.bodyweight) {
          finalWeights[ex.id] = getTargetWeight(ex, TOTAL_WEEKS + 1, logData);
        }
      });
    });

    // Build archive entry
    const blockNumber = archive.length + 1;
    const nowIso = new Date().toISOString();
    const archiveEntry = {
      id: genId(),
      blockNumber,
      label: `Block ${blockNumber}`,
      startedAt: Date.now(),
      createdAt: nowIso,
      updatedAt: nowIso,
      logData: { ...logData },
      overrides: { ...programOverrides },
      finalWeights,
    };
    const newArchive = [...archive, archiveEntry];
    setArchive(newArchive);
    await hybridSet(GYM_ARCHIVE_KEY, JSON.stringify(newArchive));

    // Build new overrides: inherit final weights as new startWeight
    const newOverrides = { ...programOverrides };
    Object.keys(finalWeights).forEach(exId => {
      newOverrides[exId] = { ...(newOverrides[exId] || {}), startWeight: finalWeights[exId] };
    });
    await saveProgram(newOverrides);

    // Clear current block logData
    await save({});

    // Reset UI state
    setSelectedWeek(null);
    setSelectedDay(null);
    setConfirmNewBlock(false);
  };

  const save = useCallback(async (newData) => {
    setLogData(newData);
    await saveGymData(newData);
  }, []);

  const handleLog = async (weekNum, exerciseId, reps) => {
    const key = `w${weekNum}`;
    const newData = { ...logData, [key]: { ...logData[key], [exerciseId]: { reps, ts: Date.now() } } };
    await save(newData);
  };

  // 1RM data — pass effectiveDays so program edits via the editor are respected
  const squat1RM = getBest1RM("squat", logData, effectiveDays);
  const bench1RM = getBest1RM("bench", logData, effectiveDays);
  const dead1RM = getBest1RM("deadlift", logData, effectiveDays);

  const navItems = [
    { id: "weeks", label: "Program" },
    { id: "dashboard", label: "Dashboard" },
  ];

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", background: GC.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: GC.accent, fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 700 }}>LOADING...</div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: GC.bg, color: GC.text, fontFamily: "'Barlow', 'Helvetica Neue', sans-serif", paddingBottom: 60 }}>

      {/* Hero */}
      <div style={{
        background: "linear-gradient(180deg, #12141a 0%, #0b0c0f 100%)",
        borderBottom: `1px solid ${GC.border}`, padding: "24px 20px 18px",
        position: "relative", overflow: "hidden",
      }}>
        <div style={{ position: "absolute", top: -80, right: -60, width: 240, height: 240, background: `radial-gradient(circle, ${GC.accentBg} 0%, transparent 70%)`, pointerEvents: "none" }} />
        <button onClick={() => setShowEditor(true)} title="Edit program" style={{
          position:"absolute", top:18, right:18, zIndex:2,
          width:34, height:34, borderRadius:10,
          background:"rgba(255,255,255,0.04)", border:`1px solid ${GC.border}`,
          color:GC.dim, fontSize:16, cursor:"pointer",
          display:"flex", alignItems:"center", justifyContent:"center",
        }}>⚙</button>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.16em", color: GC.accent, textTransform: "uppercase", marginBottom: 6 }}>Strength Program</div>
        <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 28, fontWeight: 900, lineHeight: 1, marginBottom: 5 }}>
          {selectedDay ? effectiveDays.find(d => d.id === selectedDay)?.name.toUpperCase() + " DAY" :
            selectedWeek ? `WEEK ${selectedWeek}` : "GYM PROGRAM"}
        </div>
        <div style={{ fontSize: 12, color: GC.dim }}>
          {selectedWeek ? getGymWeekDates(selectedWeek) : `Apr 6 – Jun 1 · ${TOTAL_WEEKS} weeks · Upper / Lower / Full`}
        </div>
      </div>

      {/* Nav */}
      <nav style={{ display: "flex", background: "#12141a", borderBottom: `1px solid ${GC.border}` }}>
        {selectedDay ? (
          <button onClick={() => setSelectedDay(null)} style={{
            flex: 1, padding: "14px 8px", fontFamily: "'Barlow Condensed', sans-serif",
            fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
            color: GC.accent, background: "none", border: "none", cursor: "pointer",
          }}>← Back to Week {selectedWeek}</button>
        ) : selectedWeek ? (
          <button onClick={() => setSelectedWeek(null)} style={{
            flex: 1, padding: "14px 8px", fontFamily: "'Barlow Condensed', sans-serif",
            fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
            color: GC.accent, background: "none", border: "none", cursor: "pointer",
          }}>← Back to Weeks</button>
        ) : (
          navItems.map(item => (
            <button key={item.id} onClick={() => setPage(item.id)} style={{
              flex: 1, padding: "14px 8px", fontFamily: "'Barlow Condensed', sans-serif",
              fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
              color: page === item.id ? GC.accent : GC.dimmer, background: "none", border: "none",
              borderBottom: `2px solid ${page === item.id ? GC.accent : "transparent"}`,
              cursor: "pointer", transition: "all 0.2s ease",
            }}>{item.label}</button>
          ))
        )}
      </nav>

      <div style={{ maxWidth: 640, margin: "0 auto", padding: "18px 16px" }}>

        {/* ─── WEEKS OVERVIEW ─── */}
        {page === "weeks" && !selectedWeek && !selectedDay && (
          <div style={{ animation: "fadeIn 0.3s ease" }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", color: GC.dimmer, textTransform: "uppercase", margin: "4px 0 12px" }}>Select week</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {Array.from({ length: TOTAL_WEEKS }).map((_, i) => {
                const w = i + 1;
                const comp = getWeekCompletion(w, effectiveDays, logData);
                const isCurrent = w === getCurrentWeekNum();
                return (
                  <div key={w} onClick={() => setSelectedWeek(w)} style={{
                    background: isCurrent ? GC.accentBg : GC.card,
                    border: `1px solid ${isCurrent ? GC.accentBorder : GC.border}`,
                    borderRadius: 12, padding: "14px 16px",
                    display: "flex", alignItems: "center", gap: 14,
                    cursor: "pointer", transition: "all 0.2s ease",
                  }}>
                    <ProgressRing pct={comp} color={comp >= 1 ? GC.green : GC.accent} />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 900, color: isCurrent ? GC.accent : GC.text }}>Week {w}</span>
                        {isCurrent && <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 8px", borderRadius: 99, background: GC.accentBg, color: GC.accent, border: `1px solid ${GC.accentBorder}`, textTransform: "uppercase", letterSpacing: "0.06em" }}>Current</span>}
                        {comp >= 1 && <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 8px", borderRadius: 99, background: GC.greenBg, color: GC.green, border: `1px solid ${GC.green}40`, textTransform: "uppercase", letterSpacing: "0.06em" }}>Done</span>}
                      </div>
                      <div style={{ fontSize: 11, color: GC.dim, marginTop: 2 }}>{getGymWeekDates(w)}</div>
                    </div>
                    <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, fontWeight: 700, color: GC.dimmer }}>{Math.round(comp * 100)}%</div>
                    <div style={{ color: GC.dimmer, fontSize: 12 }}>›</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ─── WEEK DETAIL (day selection) ─── */}
        {page === "weeks" && selectedWeek && !selectedDay && (
          <div style={{ animation: "fadeIn 0.3s ease" }}>
            {/* Week progress bar */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                <span style={{ fontSize: 10, fontWeight: 600, color: GC.dim, textTransform: "uppercase", letterSpacing: "0.08em" }}>Week progress</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: GC.accent, fontFamily: "'Barlow Condensed', sans-serif" }}>{Math.round(getWeekCompletion(selectedWeek, effectiveDays, logData) * 100)}%</span>
              </div>
              <div style={{ height: 6, background: "rgba(255,255,255,0.06)", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${getWeekCompletion(selectedWeek, effectiveDays, logData) * 100}%`, background: GC.accent, borderRadius: 3, transition: "width 0.5s ease" }} />
              </div>
            </div>

            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", color: GC.dimmer, textTransform: "uppercase", margin: "4px 0 12px" }}>Training days</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {effectiveDays.map(day => {
                const comp = getSessionCompletion(selectedWeek, day.id, effectiveDays, logData);
                return (
                  <div key={day.id} onClick={() => setSelectedDay(day.id)} style={{
                    background: GC.card, border: `1px solid ${comp >= 1 ? GC.green + "40" : GC.border}`,
                    borderRadius: 12, padding: "16px", cursor: "pointer", transition: "all 0.2s ease",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                      <ProgressRing pct={comp} color={comp >= 1 ? GC.green : day.color} size={40} stroke={3.5} />
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 17, fontWeight: 800, color: day.color }}>{day.name}</span>
                          <span style={{ fontSize: 11, color: GC.dim }}>{day.day}</span>
                        </div>
                        <div style={{ fontSize: 11, color: GC.dimmer, marginTop: 2 }}>{day.exercises.length} exercises · {day.exercises.reduce((a, e) => a + e.sets, 0)} sets</div>
                      </div>
                      <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, fontWeight: 700, color: comp >= 1 ? GC.green : GC.dimmer }}>{Math.round(comp * 100)}%</div>
                      <div style={{ color: GC.dimmer, fontSize: 12 }}>›</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ─── DAY DETAIL (exercises) ─── */}
        {page === "weeks" && selectedWeek && selectedDay && (
          <div style={{ animation: "fadeIn 0.3s ease" }}>
            {/* Session progress */}
            {(() => {
              const comp = getSessionCompletion(selectedWeek, selectedDay, effectiveDays, logData);
              const day = effectiveDays.find(d => d.id === selectedDay);
              return (
                <>
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <span style={{ fontSize: 10, fontWeight: 600, color: GC.dim, textTransform: "uppercase", letterSpacing: "0.08em" }}>Session progress</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {comp >= 1 && <span style={{ fontSize: 10, fontWeight: 700, color: GC.green }}>Complete ✓</span>}
                        <span style={{ fontSize: 14, fontWeight: 700, color: day.color, fontFamily: "'Barlow Condensed', sans-serif" }}>{Math.round(comp * 100)}%</span>
                      </div>
                    </div>
                    <div style={{ height: 8, background: "rgba(255,255,255,0.06)", borderRadius: 4, overflow: "hidden" }}>
                      <div style={{
                        height: "100%", width: `${comp * 100}%`,
                        background: comp >= 1 ? GC.green : `linear-gradient(90deg, ${day.color}, ${day.color}cc)`,
                        borderRadius: 4, transition: "width 0.4s ease",
                      }} />
                    </div>
                  </div>

                  <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", color: GC.dimmer, textTransform: "uppercase", margin: "4px 0 10px" }}>Exercises</div>
                  {day.exercises.map(ex => (
                    <ExerciseCard
                      key={ex.id}
                      exercise={ex}
                      weekNum={selectedWeek}
                      logData={logData}
                      onLog={(exId, reps) => handleLog(selectedWeek, exId, reps)}
                    />
                  ))}
                </>
              );
            })()}
          </div>
        )}

        {/* ─── DASHBOARD ─── */}
        {page === "dashboard" && !selectedWeek && !selectedDay && (
          <div style={{ animation: "fadeIn 0.3s ease" }}>
            {/* 1RM Goals */}
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", color: GC.dimmer, textTransform: "uppercase", margin: "16px 0 12px" }}>1RM goals (estimated)</div>
            <div style={{
              background: GC.card, border: `1px solid ${GC.border}`,
              borderRadius: 12, padding: 16, marginBottom: 14,
            }}>
              <OneRMBar label="Squat" current={squat1RM} goal={GOALS.squat} color={GC.green} />
              <OneRMBar label="Bench Press" current={bench1RM} goal={GOALS.bench} color={GC.accent} />
              <OneRMBar label="Deadlift" current={dead1RM} goal={GOALS.deadlift} color={GC.orange} />
              <div style={{ fontSize: 10, color: GC.dimmer, lineHeight: 1.6, marginTop: 8, padding: "8px 0 0", borderTop: `1px solid ${GC.border}` }}>
                Estimated using Epley formula from your logged sets. As you lift heavier for fewer reps, these estimates become more accurate.
              </div>
            </div>

            {/* Overall progress */}
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", color: GC.dimmer, textTransform: "uppercase", margin: "16px 0 12px" }}>Program progress</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
              {[
                { label: "Current week", value: getCurrentWeekNum(), sub: `of ${TOTAL_WEEKS}`, color: GC.accent },
                { label: "Sessions done", value: countCompletedSessions(effectiveDays, logData, TOTAL_WEEKS), sub: `of ${TOTAL_WEEKS * 3}`, color: GC.text },
                { label: "Best squat set", value: (() => { let b = 0; for (let w = 1; w <= TOTAL_WEEKS; w++) { b = Math.max(b, getTargetWeight(effectiveDays[1].exercises[0], w, logData)); } return b > effectiveDays[1].exercises[0].startWeight ? `${b}kg` : `${effectiveDays[1].exercises[0].startWeight}kg`; })(), sub: "top set", color: GC.green },
                { label: "Best deadlift set", value: (() => { let b = 0; for (let w = 1; w <= TOTAL_WEEKS; w++) { b = Math.max(b, getTargetWeight(effectiveDays[2].exercises[0], w, logData)); } return b > effectiveDays[2].exercises[0].startWeight ? `${b}kg` : `${effectiveDays[2].exercises[0].startWeight}kg`; })(), sub: "top set", color: GC.orange },
              ].map((card, i) => (
                <div key={i} style={{ background: GC.card, border: `1px solid ${GC.border}`, borderRadius: 12, padding: 14 }}>
                  <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: GC.dimmer, marginBottom: 6 }}>{card.label}</div>
                  <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 26, fontWeight: 900, color: card.color, lineHeight: 1 }}>{card.value}</div>
                  <div style={{ fontSize: 11, color: GC.dim, marginTop: 4 }}>{card.sub}</div>
                </div>
              ))}
            </div>

            {/* Weight progression per exercise */}
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", color: GC.dimmer, textTransform: "uppercase", margin: "16px 0 12px" }}>Weight progression</div>
            <div style={{ background: GC.card, border: `1px solid ${GC.border}`, borderRadius: 12, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "rgba(255,255,255,0.03)" }}>
                    {["Exercise", "Start", "Current", "Δ"].map((h, i) => (
                      <th key={i} style={{ textAlign: "left", fontSize: 9, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: GC.dimmer, padding: "10px 10px", borderBottom: `1px solid ${GC.border}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {effectiveDays.flatMap(day => day.exercises.filter(e => !e.bodyweight)).map((ex, i) => {
                    const current = getTargetWeight(ex, getCurrentWeekNum(), logData);
                    const diff = current - ex.startWeight;
                    return (
                      <tr key={ex.id} style={{ animation: `fadeIn 0.3s ease ${i * 0.03}s both` }}>
                        <td style={{ padding: "8px 10px", borderBottom: `1px solid rgba(255,255,255,0.04)`, color: GC.dim, fontSize: 11 }}>{ex.name}</td>
                        <td style={{ padding: "8px 10px", borderBottom: `1px solid rgba(255,255,255,0.04)`, color: GC.dimmer, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700 }}>{ex.startWeight}</td>
                        <td style={{ padding: "8px 10px", borderBottom: `1px solid rgba(255,255,255,0.04)`, color: GC.accent, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700 }}>{current}</td>
                        <td style={{ padding: "8px 10px", borderBottom: `1px solid rgba(255,255,255,0.04)`, color: diff > 0 ? GC.green : GC.dimmer, fontWeight: 700, fontSize: 11 }}>{diff > 0 ? `+${diff}` : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Clear data */}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
              <button onClick={async () => { if (confirm("Clear all logged data?")) { await save({}); } }} style={{
                background: "none", border: `1px solid ${GC.border}`, borderRadius: 6,
                color: GC.dimmer, fontSize: 11, padding: "5px 10px", cursor: "pointer",
              }}>Clear all data</button>
            </div>
          </div>
        )}
      </div>

      {/* Program Editor Modal */}
      {showEditor && (
        <div onClick={()=>setShowEditor(false)} style={{
          position:"fixed",inset:0,zIndex:200,background:"rgba(0,0,0,0.8)",
          display:"flex",alignItems:"center",justifyContent:"center",padding:16,
          animation:"fadeIn 0.2s ease",
        }}>
          <div onClick={e=>e.stopPropagation()} style={{
            background:"#141416",border:`1px solid ${GC.borderLight}`,borderRadius:16,
            maxWidth:640,width:"100%",maxHeight:"88vh",overflow:"auto",padding:"22px 20px",
          }}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
              <div>
                <div style={{fontSize:9,fontWeight:700,letterSpacing:"0.14em",color:GC.accent,textTransform:"uppercase"}}>Edit Program</div>
                <div style={{fontSize:16,fontWeight:700,color:GC.text,fontFamily:"'Barlow Condensed',sans-serif",marginTop:2}}>Exercises & starting weights</div>
              </div>
              <button onClick={()=>setShowEditor(false)} style={{background:"none",border:"none",color:GC.dim,fontSize:20,cursor:"pointer"}}>✕</button>
            </div>
            {effectiveDays.map(day => (
              <div key={day.id} style={{marginBottom:16}}>
                <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",color:day.color,textTransform:"uppercase",marginBottom:8}}>{day.name} · {day.day}</div>
                {day.exercises.map(ex => (
                  <div key={ex.id} style={{
                    background:"rgba(255,255,255,0.03)",border:`1px solid ${GC.border}`,borderRadius:10,
                    padding:12,marginBottom:6,
                  }}>
                    <input value={ex.name} onChange={e=>saveProgram({...programOverrides,[ex.id]:{...programOverrides[ex.id],name:e.target.value}})}
                      style={{width:"100%",background:"rgba(0,0,0,0.3)",border:`1px solid ${GC.border}`,borderRadius:6,padding:"7px 10px",fontSize:13,color:GC.text,outline:"none",marginBottom:8,fontFamily:"'Barlow',sans-serif"}}/>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:6}}>
                      {[
                        {k:"sets",label:"Sets",val:ex.sets,type:"number"},
                        {k:"repLow",label:"Rep min",val:ex.repRange[0],type:"number"},
                        {k:"repHigh",label:"Rep max",val:ex.repRange[1],type:"number"},
                        {k:"startWeight",label:ex.bodyweight?"BW":"Weight",val:ex.startWeight,type:"number",disabled:ex.bodyweight},
                      ].map(f => (
                        <div key={f.k}>
                          <div style={{fontSize:8,fontWeight:700,letterSpacing:"0.06em",textTransform:"uppercase",color:GC.dimmer,marginBottom:3}}>{f.label}</div>
                          <input type="number" value={f.val} disabled={f.disabled} onChange={e=>{
                            const v = parseFloat(e.target.value)||0;
                            const current = programOverrides[ex.id] || {};
                            let next;
                            if (f.k === "repLow") next = {...current, repRange:[v, ex.repRange[1]]};
                            else if (f.k === "repHigh") next = {...current, repRange:[ex.repRange[0], v]};
                            else next = {...current, [f.k]:v};
                            saveProgram({...programOverrides,[ex.id]:next});
                          }} style={{
                            width:"100%",background:f.disabled?"rgba(0,0,0,0.1)":"rgba(0,0,0,0.3)",
                            border:`1px solid ${GC.border}`,borderRadius:6,padding:"7px 8px",
                            fontSize:13,color:f.disabled?GC.dimmer:GC.text,outline:"none",
                            fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,textAlign:"center",
                          }}/>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ))}
            {/* Previous blocks */}
            {archive.length > 0 && (
              <div style={{marginTop:4,marginBottom:16}}>
                <div style={{fontSize:9,fontWeight:700,letterSpacing:"0.14em",color:GC.dimmer,textTransform:"uppercase",marginBottom:8}}>Previous blocks</div>
                {archive.map(block => {
                  const totalSessions = Object.keys(block.logData || {}).length;
                  return (
                    <div key={block.id} style={{
                      background:"rgba(255,255,255,0.02)",border:`1px solid ${GC.border}`,borderRadius:8,
                      padding:"10px 12px",marginBottom:6,
                    }}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                        <div style={{fontSize:12,fontWeight:700,color:GC.text,fontFamily:"'Barlow Condensed',sans-serif"}}>{block.label}</div>
                        <div style={{fontSize:10,color:GC.dimmer}}>{new Date(block.startedAt).toLocaleDateString("en-SE",{month:"short",day:"numeric",year:"numeric"})}</div>
                      </div>
                      <div style={{fontSize:10,color:GC.dim,lineHeight:1.5}}>
                        Final weights: {Object.entries(block.finalWeights || {}).slice(0,4).map(([id,w])=>{
                          const ex = GYM_DAYS.flatMap(d=>d.exercises).find(e=>e.id===id);
                          return ex ? `${ex.name.split("(")[0].trim()} ${w}kg` : null;
                        }).filter(Boolean).join(" · ")}
                        {Object.keys(block.finalWeights||{}).length > 4 && " …"}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Start new block */}
            <div style={{
              background:"rgba(34,197,94,0.05)",border:`1px solid ${GC.green}30`,borderRadius:10,
              padding:12,marginBottom:10,
            }}>
              <div style={{fontSize:11,color:GC.text,lineHeight:1.5,marginBottom:8}}>
                Done with this block? Archive current progress and start fresh. Final weights become next block's starting weights.
              </div>
              {confirmNewBlock ? (
                <div style={{display:"flex",gap:6}}>
                  <button onClick={startNewBlock} style={{
                    flex:1,padding:"9px",background:GC.green,border:"none",borderRadius:8,
                    color:"#fff",fontSize:12,fontWeight:900,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:"0.05em",
                  }}>CONFIRM NEW BLOCK</button>
                  <button onClick={()=>setConfirmNewBlock(false)} style={{
                    padding:"9px 14px",background:"none",border:`1px solid ${GC.border}`,borderRadius:8,
                    color:GC.dim,fontSize:11,cursor:"pointer",
                  }}>Cancel</button>
                </div>
              ) : (
                <button onClick={()=>setConfirmNewBlock(true)} style={{
                  width:"100%",padding:"9px",background:"none",border:`1px solid ${GC.green}50`,borderRadius:8,
                  color:GC.green,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:"0.05em",textTransform:"uppercase",
                }}>Archive & start new block</button>
              )}
            </div>

            <div style={{display:"flex",gap:8,marginTop:8}}>
              <button onClick={async()=>{await saveProgram({});}} style={{
                flex:1,padding:"10px",background:"none",border:`1px solid ${GC.border}`,borderRadius:10,
                color:GC.dim,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",
              }}>Reset to defaults</button>
              <button onClick={()=>setShowEditor(false)} style={{
                flex:1,padding:"10px",background:GC.accent,border:"none",borderRadius:10,
                color:"#fff",fontSize:13,fontWeight:900,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:"0.05em",
              }}>DONE</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// BJJ APP
// ══════════════════════════════════════════════════════════════


const BJJ_STORAGE_KEY = "v2-bjj-sessions";

const BC = {
  bg: "#09090b", surface: "#111113", card: "rgba(255,255,255,0.03)",
  border: "rgba(255,255,255,0.06)", borderLight: "rgba(255,255,255,0.1)",
  accent: "#6ba3be", accentBg: "rgba(107,163,190,0.1)", accentBorder: "rgba(107,163,190,0.25)",
  green: "#7c9a72", greenBg: "rgba(124,154,114,0.1)", greenBorder: "rgba(124,154,114,0.25)",
  yellow: "#c4a44a", yellowBg: "rgba(196,164,74,0.1)",
  red: "#c45c4a", redBg: "rgba(196,92,74,0.08)",
  text: "#e8e8e6", dim: "rgba(255,255,255,0.35)", dimmer: "rgba(255,255,255,0.18)",
};

const INTENSITY = [
  { id: "light", label: "Light", color: BC.green, bg: BC.greenBg },
  { id: "medium", label: "Medium", color: BC.yellow, bg: BC.yellowBg },
  { id: "hard", label: "Hard", color: BC.red, bg: BC.redBg },
];

// Each class: { time, dur, gym: "stark"|"stt", type: "gi"|"nogi", name }
// STT wrestling sessions keep their real name but count as "nogi" in filters
const SCHEDULE = [
  { day: 0, label: "Mon", classes: [
    { time: "11:00", dur: 60, gym: "stt", type: "nogi", name: "NoGi" },
    { time: "17:00", dur: 60, gym: "stark", type: "nogi", name: "No-Gi" },
    { time: "20:30", dur: 60, gym: "stt", type: "nogi", name: "Submission Grappling" },
  ]},
  { day: 1, label: "Tue", classes: [
    { time: "12:00", dur: 60, gym: "stark", type: "nogi", name: "No-Gi" },
    { time: "17:30", dur: 60, gym: "stark", type: "nogi", name: "No-Gi" },
    { time: "19:15", dur: 75, gym: "stt", type: "nogi", name: "MMA/Freestyle Wrestling" },
  ]},
  { day: 2, label: "Wed", classes: [
    { time: "11:00", dur: 60, gym: "stt", type: "nogi", name: "NoGi" },
    { time: "17:00", dur: 60, gym: "stark", type: "nogi", name: "No-Gi" },
    { time: "19:30", dur: 60, gym: "stt", type: "nogi", name: "Submission Grappling" },
  ]},
  { day: 3, label: "Thu", classes: [
    { time: "12:00", dur: 60, gym: "stark", type: "nogi", name: "No-Gi" },
    { time: "17:30", dur: 60, gym: "stark", type: "nogi", name: "No-Gi" },
    { time: "19:15", dur: 75, gym: "stt", type: "nogi", name: "MMA/Freestyle Wrestling" },
  ]},
  { day: 4, label: "Fri", classes: [
    { time: "10:00", dur: 90, gym: "stark", type: "nogi", name: "No-Gi" },
    { time: "11:00", dur: 60, gym: "stt", type: "nogi", name: "NoGi" },
  ]},
  { day: 5, label: "Sat", classes: [
    { time: "11:00", dur: 60, gym: "stt", type: "nogi", name: "Submission Grappling" },
    { time: "13:00", dur: 90, gym: "stark", type: "nogi", name: "No-Gi" },
  ]},
  { day: 6, label: "Sun", classes: [
    { time: "12:00", dur: 75, gym: "stt", type: "nogi", name: "MMA/Freestyle Wrestling" },
    { time: "14:15", dur: 105, gym: "stt", type: "nogi", name: "Open Mat" },
    { time: "20:00", dur: 60, gym: "stark", type: "nogi", name: "No-Gi" },
  ]},
];

const GYM_META = {
  stark: { label: "Stark", color: "#6ba3be" },
  stt:   { label: "STT",   color: "#c4a44a" },
};

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function getWeekStart(date) {
  const d = new Date(date); const day = d.getDay();
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  d.setHours(0, 0, 0, 0); return d;
}
function dateKey(d) { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}-${String(x.getDate()).padStart(2,"0")}`; }
function fmtShort(d) { return new Date(d).toLocaleDateString("en-SE", { month: "short", day: "numeric" }); }
function getWeekDates(ws) { const r = []; for (let i = 0; i < 7; i++) { const d = new Date(ws); d.setDate(d.getDate()+i); r.push(d); } return r; }
function getMonthDays(y, m) {
  const f = new Date(y,m,1), sd = f.getDay()===0?6:f.getDay()-1, dim = new Date(y,m+1,0).getDate(), r = [];
  for (let i=0;i<sd;i++) r.push(null);
  for (let i=1;i<=dim;i++) r.push(new Date(y,m,i));
  return r;
}
function isToday(d) { const t=new Date(),x=new Date(d); return x.getFullYear()===t.getFullYear()&&x.getMonth()===t.getMonth()&&x.getDate()===t.getDate(); }

const PRE_SESSIONS = [
  { dateKey:"2026-03-17", time:"17:30", dur:60, rounds:0, intensity:null, notes:null, ts:1742230680000 },
  { dateKey:"2026-03-10", time:"17:30", dur:60, rounds:0, intensity:null, notes:null, ts:1741625100000 },
  { dateKey:"2026-02-03", time:"17:30", dur:60, rounds:0, intensity:null, notes:null, ts:1738609080000 },
  { dateKey:"2026-01-26", time:"17:00", dur:60, rounds:0, intensity:null, notes:null, ts:1737906180000 },
  { dateKey:"2026-01-20", time:"17:30", dur:60, rounds:0, intensity:null, notes:null, ts:1737392040000 },
  { dateKey:"2026-01-15", time:"17:30", dur:60, rounds:0, intensity:null, notes:null, ts:1736960460000 },
  { dateKey:"2026-01-11", time:"20:00", dur:60, rounds:0, intensity:null, notes:null, ts:1736600400000 },
  { dateKey:"2026-01-08", time:"17:30", dur:60, rounds:0, intensity:null, notes:null, ts:1736362320000 },
];

async function loadBJJData() {
  try {
    const r = await hybridGet(BJJ_STORAGE_KEY);
    if (r) {
      const parsed = JSON.parse(r);
      const { items, changed } = ensureIds(parsed.sessions || []);
      const out = { ...parsed, sessions: items };
      if (changed) await hybridSet(BJJ_STORAGE_KEY, JSON.stringify(out));
      return out;
    }
    return { sessions: [] };
  } catch { return { sessions: [] }; }
}
async function saveBJJData(data) { try { await hybridSet(BJJ_STORAGE_KEY, JSON.stringify(data)); } catch (e) { console.error(e); } }

function LogPanel({ date, classInfo, existing, onSave, onDelete, onClose }) {
  const [rounds, setRounds] = useState(existing?.rounds || 0);
  const [intensity, setIntensity] = useState(existing?.intensity || null);
  const [notes, setNotes] = useState(existing?.notes || "");

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "flex-end", justifyContent: "center", animation: "fadeIn 0.2s ease" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "#141416", borderTop: `1px solid ${BC.borderLight}`, borderRadius: "16px 16px 0 0",
        width: "100%", maxWidth: 640, padding: "20px 20px 36px", animation: "slideUp 0.3s cubic-bezier(0.34, 1.4, 0.64, 1)",
      }}>
        <div style={{ width: 32, height: 3, borderRadius: 2, background: BC.dimmer, margin: "0 auto 16px" }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", color: BC.accent, textTransform: "uppercase" }}>Log Session</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: BC.text, fontFamily: "'Barlow Condensed', sans-serif", marginTop: 3 }}>
              {fmtShort(date)} · {classInfo.time} · {classInfo.name || "Session"} · {classInfo.dur} min
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: BC.dim, fontSize: 18, cursor: "pointer" }}>✕</button>
        </div>

        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: BC.dim, marginBottom: 8 }}>Open rounds</div>
          <div style={{ display: "flex", gap: 6 }}>
            {[0,1,2,3,4,5,6].map(n => (
              <button key={n} onClick={() => setRounds(n)} style={{
                width: 40, height: 40, borderRadius: 8,
                border: `1px solid ${rounds===n ? BC.accentBorder : "rgba(255,255,255,0.08)"}`,
                background: rounds===n ? BC.accentBg : "rgba(0,0,0,0.3)",
                color: rounds===n ? BC.accent : BC.dim,
                fontSize: 15, fontWeight: 700, fontFamily: "'Barlow Condensed', sans-serif",
                cursor: "pointer", transition: "all 0.15s ease",
                transform: rounds===n ? "scale(1.1)" : "scale(1)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>{n}</button>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: BC.dim, marginBottom: 8 }}>Intensity</div>
          <div style={{ display: "flex", gap: 8 }}>
            {INTENSITY.map(int => (
              <button key={int.id} onClick={() => setIntensity(int.id)} style={{
                flex: 1, padding: "10px 8px", borderRadius: 10,
                border: `1px solid ${intensity===int.id ? int.color+"40" : "rgba(255,255,255,0.08)"}`,
                background: intensity===int.id ? int.bg : "rgba(0,0,0,0.3)",
                color: intensity===int.id ? int.color : BC.dim,
                fontSize: 13, fontWeight: 700, fontFamily: "'Barlow Condensed', sans-serif",
                cursor: "pointer", transition: "all 0.15s ease",
              }}>{int.label}</button>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: BC.dim, marginBottom: 8 }}>Notes (optional)</div>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Worked on underhooks, got swept from half guard..."
            rows={3} style={{
              width: "100%", background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 10, padding: "10px 12px", fontSize: 13, fontFamily: "'Barlow', sans-serif",
              color: BC.text, outline: "none", resize: "none", lineHeight: 1.5,
            }} />
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => onSave({ rounds, intensity, notes: notes.trim()||null })} style={{
            flex: 1, padding: "13px", background: BC.accent, border: "none", borderRadius: 12,
            fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, fontWeight: 900,
            letterSpacing: "0.05em", color: "#fff", cursor: "pointer",
          }}>{existing ? "UPDATE" : "LOG SESSION"} →</button>
          {existing && (
            <button onClick={onDelete} style={{
              padding: "13px 16px", background: "none", border: `1px solid ${BC.border}`,
              borderRadius: 12, color: BC.dim, fontSize: 13, fontWeight: 700, cursor: "pointer",
              fontFamily: "'Barlow Condensed', sans-serif",
            }}>Remove</button>
          )}
        </div>
      </div>
    </div>
  );
}

function Heatmap({ sessions, year, month }) {
  const days = getMonthDays(year, month);
  const sMap = {}; sessions.forEach(s => { sMap[s.dateKey] = s; });
  const getCol = dk => {
    const s = sMap[dk]; if (!s) return "rgba(107,163,190,0.04)";
    if (s.intensity==="hard") return BC.red;
    if (s.intensity==="medium") return BC.yellow;
    return BC.green;
  };
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 3, marginBottom: 3 }}>
        {DAY_NAMES.map(d => <div key={d} style={{ fontSize: 9, fontWeight: 600, color: BC.dimmer, textAlign: "center" }}>{d}</div>)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 3 }}>
        {days.map((d,i) => {
          if (!d) return <div key={`e${i}`}/>;
          const dk=dateKey(d), has=!!sMap[dk], today=isToday(d);
          return <div key={dk} style={{
            aspectRatio: "1", borderRadius: 4, background: getCol(dk),
            border: today?`1.5px solid ${BC.text}`:"1px solid transparent",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 9, color: has?"#fff":BC.dimmer, fontWeight: has?700:400,
          }}>{d.getDate()}</div>;
        })}
      </div>
    </div>
  );
}

// ─── Competition Data ───
const COMP_STORAGE = "v2-bjj-comps";

const PRE_LOADED = [
  {
    id: "nordic-open-11",
    name: "Nordic Open Grappling #11",
    date: "2026-02-07",
    weightClass: "+91 kg",
    placement: "silver",
    matches: [
      { result: "win", method: "points", score: "7–0" },
      { result: "win", method: "submission" },
      { result: "loss", method: "submission" },
    ],
  },
  {
    id: "bjj-nation-8",
    name: "BJJ Nation Tournament #8",
    date: "2024-06-08",
    weightClass: "-91.5 kg",
    placement: "4th",
    matches: [
      { result: "win", method: "points", score: "7–0" },
      { result: "loss", method: "submission" },
      { result: "loss", method: "submission" },
    ],
  },
];

async function loadComps() {
  try {
    const r = await hybridGet(COMP_STORAGE);
    if (!r) return [];
    const raw = JSON.parse(r);
    // Backfill comp ids/timestamps + nested match ids
    const { items: comps, changed: compsChanged } = ensureIds(raw);
    let nestedChanged = false;
    const out = comps.map(c => {
      if (!Array.isArray(c.matches)) return c;
      const { items: matches, changed } = ensureIds(c.matches);
      if (changed) nestedChanged = true;
      return changed ? { ...c, matches } : c;
    });
    if (compsChanged || nestedChanged) {
      await hybridSet(COMP_STORAGE, JSON.stringify(out));
    }
    return out;
  } catch { return []; }
}
async function saveComps(d) { try { await hybridSet(COMP_STORAGE, JSON.stringify(d)); } catch(e) { console.error(e); } }

// ══════════════════════════════════════════════════════════════
// PURE BJJ COMP HELPERS
// ──────────────────────────────────────────────────────────────
// Same purity contract as the gym helpers section: no side effects,
// no React state, no storage calls. Take comps array as input and
// return derived data. All lookups use stable ids (slice 5).
// ══════════════════════════════════════════════════════════════

/** Find a competition by stable id. */
function findComp(comps, compId) {
  return (comps || []).find(c => c.id === compId) || null;
}

/** Find a match anywhere in the comps array by its stable id.
 *  Returns { comp, match } or null. */
function findMatch(comps, matchId) {
  for (const c of (comps || [])) {
    const m = (c.matches || []).find(x => x.id === matchId);
    if (m) return { comp: c, match: m };
  }
  return null;
}

/** Immutable update: replace a match by id within the comps array. */
function updateMatchById(comps, matchId, patch) {
  const nowIso = new Date().toISOString();
  return (comps || []).map(c => {
    if (!Array.isArray(c.matches)) return c;
    let touched = false;
    const matches = c.matches.map(m => {
      if (m.id !== matchId) return m;
      touched = true;
      return { ...m, ...patch, updatedAt: nowIso };
    });
    return touched ? { ...c, matches, updatedAt: nowIso } : c;
  });
}

/** Immutable update: remove a match by id within the comps array. */
function removeMatchById(comps, matchId) {
  const nowIso = new Date().toISOString();
  return (comps || []).map(c => {
    if (!Array.isArray(c.matches)) return c;
    const before = c.matches.length;
    const matches = c.matches.filter(m => m.id !== matchId);
    return matches.length !== before
      ? { ...c, matches, updatedAt: nowIso }
      : c;
  });
}

/** Immutable update: replace a competition by id (for editing later). */
function updateCompById(comps, compId, patch) {
  const nowIso = new Date().toISOString();
  return (comps || []).map(c => c.id === compId
    ? { ...c, ...patch, updatedAt: nowIso }
    : c);
}

/** Compute aggregate stats from a comps array.
 *  Returns { wins, losses, total, winPct, winsBySub, winsByPts,
 *  winsByDec, lossBySub, lossByPts, lossByDec, medals }. */
function computeCompStats(comps) {
  const allMatches = (comps || []).flatMap(c => c.matches || []);
  const isResult = (r) => (m) => m.result === r;
  const isWinBy = (method) => (m) => m.result === "win" && m.method === method;
  const isLossBy = (method) => (m) => m.result === "loss" && m.method === method;

  const wins = allMatches.filter(isResult("win")).length;
  const losses = allMatches.filter(isResult("loss")).length;
  const total = wins + losses;
  const winPct = total > 0 ? Math.round((wins / total) * 100) : 0;

  return {
    allMatches,
    wins, losses, total, winPct,
    winsBySub: allMatches.filter(isWinBy("submission")).length,
    winsByPts: allMatches.filter(isWinBy("points")).length,
    winsByDec: allMatches.filter(isWinBy("decision")).length,
    lossBySub: allMatches.filter(isLossBy("submission")).length,
    lossByPts: allMatches.filter(isLossBy("points")).length,
    lossByDec: allMatches.filter(isLossBy("decision")).length,
    medals: {
      gold:   (comps || []).filter(c => c.placement === "gold").length,
      silver: (comps || []).filter(c => c.placement === "silver").length,
      bronze: (comps || []).filter(c => c.placement === "bronze").length,
    },
  };
}

// ══════════════════════════════════════════════════════════════
// END PURE BJJ COMP HELPERS
// ══════════════════════════════════════════════════════════════

function ResultsPage() {
  const [comps, setComps] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addingMatch, setAddingMatch] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  // New tournament form
  const [tName, setTName] = useState("");
  const [tDate, setTDate] = useState("");
  const [tWeight, setTWeight] = useState("");
  const [tPlacement, setTPlacement] = useState("");

  // New match form
  const [mResult, setMResult] = useState(null);
  const [mMethod, setMMethod] = useState(null);
  const [mScore, setMScore] = useState("");

  useEffect(() => { loadComps().then(d => { setComps(d); setLoaded(true); }); }, []);

  const save = async (nd) => { setComps(nd); await saveComps(nd); };

  const addTournament = async () => {
    if (!tName.trim() || !tDate) return;
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const t = {
      id: genId(),
      name: tName.trim(),
      date: tDate,
      weightClass: tWeight.trim() || "Open",
      placement: tPlacement.trim() || null,
      matches: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const nd = [t, ...comps];
    await save(nd);
    setTName(""); setTDate(""); setTWeight(""); setTPlacement(""); setAdding(false);
  };

  const addMatch = async (compId) => {
    if (!mResult || !mMethod) return;
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const match = {
      id: genId(),
      result: mResult,
      method: mMethod,
      score: mMethod === "points" ? mScore.trim() || null : null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const nd = comps.map(c => c.id === compId
      ? { ...c, matches: [...c.matches, match], updatedAt: nowIso }
      : c);
    await save(nd);
    setMResult(null); setMMethod(null); setMScore(""); setAddingMatch(null);
  };

  const deleteTournament = async (id) => {
    await save(comps.filter(c => c.id !== id));
    setConfirmDelete(null);
  };

  // Stats — derived from comps via pure helper. Spread the result so
  // existing template references (wins, losses, winPct, medals, etc.)
  // keep working unchanged.
  const {
    allMatches, wins, losses, total, winPct,
    winsBySub, winsByPts, winsByDec,
    lossBySub, lossByPts, lossByDec,
    medals,
  } = computeCompStats(comps);

  const SL = ({children}) => <div style={{fontSize:9,fontWeight:700,letterSpacing:"0.14em",color:BC.dimmer,textTransform:"uppercase",margin:"20px 0 10px"}}>{children}</div>;

  const placementColors = { gold: "#eab308", silver: "#94a3b8", bronze: "#cd7f32", "4th": BC.dim };
  const placementEmoji = { gold: "🥇", silver: "🥈", bronze: "🥉" };

  if (!loaded) return null;

  return (
    <div style={{animation:"fadeIn 0.3s ease"}}>
      {/* Profile header */}
      <div style={{
        background:`linear-gradient(135deg, ${BC.accentBg}, rgba(255,255,255,0.02))`,
        border:`1px solid ${BC.accentBorder}`,borderRadius:14,padding:"24px 20px",marginTop:16,
        position:"relative",overflow:"hidden",
      }}>
        <div style={{position:"absolute",top:-30,right:-30,width:140,height:140,background:`radial-gradient(circle,${BC.accentBg} 0%,transparent 70%)`,pointerEvents:"none"}}/>
        
        <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:16}}>
          {/* Avatar */}
          <div style={{
            width:64,height:64,borderRadius:16,flexShrink:0,
            background:`linear-gradient(135deg, ${BC.accent}30, ${BC.accent}10)`,
            border:`2px solid ${BC.accentBorder}`,
            display:"flex",alignItems:"center",justifyContent:"center",
            fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:900,color:BC.accent,
            letterSpacing:"0.02em",
          }}>LN</div>
          
          <div style={{flex:1}}>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:24,fontWeight:900,color:BC.text,lineHeight:1.1}}>Ludwig Norrmén</div>
            <div style={{fontSize:12,color:BC.dim,marginTop:4,display:"flex",alignItems:"center",gap:8}}>
              <span style={{display:"inline-flex",alignItems:"center",gap:4}}>
                <span style={{width:8,height:3,borderRadius:1,background:"#f0f0ee",display:"inline-block"}}/>
                White Belt
              </span>
              <span style={{color:BC.dimmer}}>·</span>
              <span>No-Gi</span>
            </div>
          </div>
        </div>

        {/* Info row */}
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:16}}>
          {[
            {label:"Gym",value:"Stark IF"},
            {label:"Team",value:"Checkmat"},
          ].map((item,i) => (
            <div key={i} style={{
              padding:"6px 12px",borderRadius:8,
              background:"rgba(0,0,0,0.2)",border:`1px solid ${BC.border}`,
              fontSize:11,color:BC.dim,
            }}>
              <span style={{color:BC.dimmer,marginRight:4}}>{item.label}:</span>
              <span style={{color:BC.text,fontWeight:600}}>{item.value}</span>
            </div>
          ))}
        </div>

        {/* Record bar */}
        <div style={{display:"flex",alignItems:"center",gap:14}}>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:900,color:BC.accent,lineHeight:1}}>{wins}W–{losses}L</div>
          <div style={{flex:1,height:1,background:BC.border}}/>
          <div style={{fontSize:11,color:BC.dim}}>{comps.length} tournament{comps.length!==1?"s":""}</div>
        </div>
      </div>

      {/* Record */}
      <SL>Record</SL>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:10,marginBottom:6}}>
        <div style={{background:BC.card,border:`1px solid ${BC.border}`,borderRadius:12,padding:14,textAlign:"center"}}>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:32,fontWeight:900,color:BC.green,lineHeight:1}}>{wins}</div>
          <div style={{fontSize:10,color:BC.dim,marginTop:4}}>Wins</div>
        </div>
        <div style={{background:BC.card,border:`1px solid ${BC.border}`,borderRadius:12,padding:14,textAlign:"center"}}>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:32,fontWeight:900,color:BC.red,lineHeight:1}}>{losses}</div>
          <div style={{fontSize:10,color:BC.dim,marginTop:4}}>Losses</div>
        </div>
        <div style={{background:BC.card,border:`1px solid ${BC.border}`,borderRadius:12,padding:14,textAlign:"center"}}>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:32,fontWeight:900,color:BC.accent,lineHeight:1}}>{winPct}%</div>
          <div style={{fontSize:10,color:BC.dim,marginTop:4}}>Win rate</div>
        </div>
        <div style={{background:BC.card,border:`1px solid ${BC.border}`,borderRadius:12,padding:14,textAlign:"center"}}>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:32,fontWeight:900,color:BC.yellow,lineHeight:1}}>{wins>0?Math.round((winsBySub/wins)*100):0}%</div>
          <div style={{fontSize:10,color:BC.dim,marginTop:4}}>Sub rate</div>
        </div>
      </div>

      {/* Win/Loss breakdown */}
      {total > 0 && (
        <div style={{background:BC.card,border:`1px solid ${BC.border}`,borderRadius:12,padding:16,marginBottom:6}}>
          {/* Win/loss bar */}
          <div style={{display:"flex",height:10,borderRadius:5,overflow:"hidden",marginBottom:14,gap:2}}>
            {wins>0&&<div style={{flex:wins,background:BC.green,borderRadius:5,transition:"flex 0.4s"}}/>}
            {losses>0&&<div style={{flex:losses,background:BC.red,borderRadius:5,transition:"flex 0.4s"}}/>}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
            <div>
              <div style={{fontSize:10,fontWeight:700,color:BC.green,letterSpacing:"0.06em",textTransform:"uppercase",marginBottom:8}}>Wins by</div>
              {[{l:"Submission",v:winsBySub},{l:"Points",v:winsByPts},{l:"Decision",v:winsByDec}].filter(x=>x.v>0).map(x=>(
                <div key={x.l} style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"4px 0",borderBottom:`1px solid ${BC.border}`}}>
                  <span style={{color:BC.dim}}>{x.l}</span>
                  <span style={{fontWeight:700,color:BC.green,fontFamily:"'Barlow Condensed',sans-serif",fontSize:14}}>{x.v}</span>
                </div>
              ))}
              {winsBySub===0&&winsByPts===0&&winsByDec===0&&<div style={{fontSize:11,color:BC.dimmer}}>—</div>}
            </div>
            <div>
              <div style={{fontSize:10,fontWeight:700,color:BC.red,letterSpacing:"0.06em",textTransform:"uppercase",marginBottom:8}}>Losses by</div>
              {[{l:"Submission",v:lossBySub},{l:"Points",v:lossByPts},{l:"Decision",v:lossByDec}].filter(x=>x.v>0).map(x=>(
                <div key={x.l} style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"4px 0",borderBottom:`1px solid ${BC.border}`}}>
                  <span style={{color:BC.dim}}>{x.l}</span>
                  <span style={{fontWeight:700,color:BC.red,fontFamily:"'Barlow Condensed',sans-serif",fontSize:14}}>{x.v}</span>
                </div>
              ))}
              {lossBySub===0&&lossByPts===0&&lossByDec===0&&<div style={{fontSize:11,color:BC.dimmer}}>—</div>}
            </div>
          </div>
        </div>
      )}

      {/* Medals */}
      {(medals.gold>0||medals.silver>0||medals.bronze>0) && (
        <>
          <SL>Medals</SL>
          <div style={{display:"flex",gap:10,marginBottom:6}}>
            {[{l:"Gold",v:medals.gold,e:"🥇",c:"#eab308"},{l:"Silver",v:medals.silver,e:"🥈",c:"#94a3b8"},{l:"Bronze",v:medals.bronze,e:"🥉",c:"#cd7f32"}].map(m=>(
              <div key={m.l} style={{flex:1,background:BC.card,border:`1px solid ${BC.border}`,borderRadius:12,padding:14,textAlign:"center"}}>
                <div style={{fontSize:24,marginBottom:4}}>{m.e}</div>
                <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:24,fontWeight:900,color:m.c,lineHeight:1}}>{m.v}</div>
                <div style={{fontSize:10,color:BC.dim,marginTop:3}}>{m.l}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Tournaments */}
      <SL>Tournaments</SL>
      <button onClick={()=>setAdding(!adding)} style={{
        width:"100%",padding:"10px",background:adding?BC.accentBg:BC.card,
        border:`1px solid ${adding?BC.accentBorder:BC.border}`,borderRadius:10,
        color:adding?BC.accent:BC.dim,fontSize:12,fontWeight:600,cursor:"pointer",
        fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:"0.05em",
        marginBottom:10,transition:"all 0.2s ease",
      }}>{adding?"Cancel":"+ Add tournament"}</button>

      {/* Add tournament form */}
      {adding && (
        <div style={{background:BC.card,border:`1px solid ${BC.accentBorder}`,borderRadius:12,padding:16,marginBottom:10,animation:"fadeIn 0.2s ease"}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
            <div>
              <div style={{fontSize:9,fontWeight:600,letterSpacing:"0.08em",textTransform:"uppercase",color:BC.dim,marginBottom:6}}>Tournament name</div>
              <input value={tName} onChange={e=>setTName(e.target.value)} placeholder="e.g. Nordic Open #12" style={{
                width:"100%",background:"rgba(0,0,0,0.3)",border:`1px solid rgba(255,255,255,0.08)`,borderRadius:8,
                padding:"9px 11px",fontSize:13,fontFamily:"'Barlow',sans-serif",color:BC.text,outline:"none",
              }}/>
            </div>
            <div>
              <div style={{fontSize:9,fontWeight:600,letterSpacing:"0.08em",textTransform:"uppercase",color:BC.dim,marginBottom:6}}>Date</div>
              <input type="date" value={tDate} onChange={e=>setTDate(e.target.value)} style={{
                width:"100%",background:"rgba(0,0,0,0.3)",border:`1px solid rgba(255,255,255,0.08)`,borderRadius:8,
                padding:"9px 11px",fontSize:13,fontFamily:"'Barlow',sans-serif",color:BC.text,outline:"none",
                colorScheme:"dark",
              }}/>
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
            <div>
              <div style={{fontSize:9,fontWeight:600,letterSpacing:"0.08em",textTransform:"uppercase",color:BC.dim,marginBottom:6}}>Weight class</div>
              <input value={tWeight} onChange={e=>setTWeight(e.target.value)} placeholder="e.g. +91 kg" style={{
                width:"100%",background:"rgba(0,0,0,0.3)",border:`1px solid rgba(255,255,255,0.08)`,borderRadius:8,
                padding:"9px 11px",fontSize:13,fontFamily:"'Barlow',sans-serif",color:BC.text,outline:"none",
              }}/>
            </div>
            <div>
              <div style={{fontSize:9,fontWeight:600,letterSpacing:"0.08em",textTransform:"uppercase",color:BC.dim,marginBottom:6}}>Placement</div>
              <div style={{display:"flex",gap:4}}>
                {["gold","silver","bronze","4th"].map(p=>(
                  <button key={p} onClick={()=>setTPlacement(tPlacement===p?"":p)} style={{
                    flex:1,padding:"8px 4px",borderRadius:8,fontSize:11,fontWeight:700,cursor:"pointer",
                    border:`1px solid ${tPlacement===p?(placementColors[p]||BC.dim)+"40":"rgba(255,255,255,0.08)"}`,
                    background:tPlacement===p?`${placementColors[p]||BC.dim}15`:"rgba(0,0,0,0.3)",
                    color:tPlacement===p?placementColors[p]||BC.dim:BC.dimmer,
                    fontFamily:"'Barlow Condensed',sans-serif",transition:"all 0.15s ease",
                  }}>{placementEmoji[p]||""}{p==="4th"?"4th":""}</button>
                ))}
              </div>
            </div>
          </div>
          <button onClick={addTournament} style={{
            width:"100%",padding:"11px",background:BC.accent,border:"none",borderRadius:10,
            fontFamily:"'Barlow Condensed',sans-serif",fontSize:14,fontWeight:900,color:"#fff",cursor:"pointer",
          }}>ADD TOURNAMENT →</button>
        </div>
      )}

      {/* Tournament list */}
      {comps.sort((a,b)=>b.date.localeCompare(a.date)).map((comp,ci) => {
        const cWins = comp.matches.filter(m=>m.result==="win").length;
        const cLosses = comp.matches.filter(m=>m.result==="loss").length;
        const pColor = placementColors[comp.placement] || BC.dim;

        return (
          <div key={comp.id} style={{
            background:BC.card,border:`1px solid ${BC.border}`,borderRadius:12,
            overflow:"hidden",marginBottom:8,animation:`fadeIn 0.3s ease ${ci*0.05}s both`,
          }}>
            {/* Tournament header */}
            <div style={{padding:"14px 16px",borderBottom:`1px solid ${BC.border}`}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                <div>
                  <div style={{fontSize:14,fontWeight:700,color:BC.text}}>{comp.name}</div>
                  <div style={{fontSize:11,color:BC.dim,marginTop:2}}>
                    {new Date(comp.date).toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"})} · {comp.weightClass}
                  </div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  {comp.placement && (
                    <div style={{
                      fontSize:comp.placement.length<=6?16:12,fontWeight:700,
                      color:pColor,display:"flex",alignItems:"center",gap:4,
                    }}>
                      {placementEmoji[comp.placement]||""}<span style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:14,textTransform:"uppercase"}}>{comp.placement}</span>
                    </div>
                  )}
                  {confirmDelete === comp.id ? (
                    <>
                      <button onClick={(e)=>{e.stopPropagation();deleteTournament(comp.id);}} style={{background:"none",border:`1px solid ${BC.red}`,borderRadius:6,color:BC.red,fontSize:10,padding:"3px 8px",cursor:"pointer",fontWeight:700}}>Confirm</button>
                      <button onClick={(e)=>{e.stopPropagation();setConfirmDelete(null);}} style={{background:"none",border:"none",color:BC.dimmer,fontSize:14,cursor:"pointer",padding:2,marginLeft:4}}>✕</button>
                    </>
                  ) : (
                    <button onClick={(e)=>{e.stopPropagation();setConfirmDelete(comp.id);}} style={{background:"none",border:"none",color:BC.dimmer,fontSize:14,cursor:"pointer",padding:2}}>✕</button>
                  )}
                </div>
              </div>
              <div style={{display:"flex",gap:6,marginTop:8}}>
                <span style={{fontSize:12,fontWeight:700,color:BC.green,fontFamily:"'Barlow Condensed',sans-serif"}}>{cWins}W</span>
                <span style={{fontSize:12,color:BC.dimmer}}>–</span>
                <span style={{fontSize:12,fontWeight:700,color:BC.red,fontFamily:"'Barlow Condensed',sans-serif"}}>{cLosses}L</span>
              </div>
            </div>

            {/* Matches */}
            <div style={{padding:"8px 12px"}}>
              {comp.matches.map((m,mi) => (
                <div key={mi} style={{
                  display:"flex",alignItems:"center",gap:10,padding:"8px 6px",
                  borderBottom:mi<comp.matches.length-1?`1px solid ${BC.border}`:"none",
                }}>
                  <div style={{
                    width:10,height:10,borderRadius:"50%",flexShrink:0,
                    background:m.result==="win"?BC.green:BC.red,
                  }}/>
                  <div style={{fontSize:12,fontWeight:600,color:m.result==="win"?BC.green:BC.red,width:32,fontFamily:"'Barlow Condensed',sans-serif",fontSize:14}}>
                    {m.result==="win"?"WIN":"LOSS"}
                  </div>
                  <div style={{fontSize:12,color:BC.dim,textTransform:"capitalize"}}>{m.method}</div>
                  {m.score && <div style={{marginLeft:"auto",fontSize:13,fontWeight:700,color:BC.text,fontFamily:"'Barlow Condensed',sans-serif"}}>{m.score}</div>}
                </div>
              ))}

              {/* Add match button / form */}
              {addingMatch===comp.id ? (
                <div style={{padding:"10px 4px",animation:"fadeIn 0.2s ease"}}>
                  <div style={{display:"flex",gap:6,marginBottom:8}}>
                    {["win","loss"].map(r=>(
                      <button key={r} onClick={()=>setMResult(r)} style={{
                        flex:1,padding:"8px",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",
                        fontFamily:"'Barlow Condensed',sans-serif",textTransform:"uppercase",
                        border:`1px solid ${mResult===r?(r==="win"?BC.green:BC.red)+"40":"rgba(255,255,255,0.08)"}`,
                        background:mResult===r?(r==="win"?BC.greenBg:BC.redBg):"rgba(0,0,0,0.3)",
                        color:mResult===r?(r==="win"?BC.green:BC.red):BC.dimmer,
                      }}>{r}</button>
                    ))}
                  </div>
                  <div style={{display:"flex",gap:6,marginBottom:8}}>
                    {["submission","points","decision","DQ"].map(m=>(
                      <button key={m} onClick={()=>setMMethod(m)} style={{
                        flex:1,padding:"8px 4px",borderRadius:8,fontSize:11,fontWeight:600,cursor:"pointer",
                        border:`1px solid ${mMethod===m?BC.accentBorder:"rgba(255,255,255,0.08)"}`,
                        background:mMethod===m?BC.accentBg:"rgba(0,0,0,0.3)",
                        color:mMethod===m?BC.accent:BC.dimmer,textTransform:"capitalize",
                      }}>{m}</button>
                    ))}
                  </div>
                  {mMethod==="points" && (
                    <input value={mScore} onChange={e=>setMScore(e.target.value)} placeholder="Score e.g. 7–0" style={{
                      width:"100%",background:"rgba(0,0,0,0.3)",border:`1px solid rgba(255,255,255,0.08)`,borderRadius:8,
                      padding:"8px 11px",fontSize:13,fontFamily:"'Barlow',sans-serif",color:BC.text,outline:"none",marginBottom:8,
                    }}/>
                  )}
                  <div style={{display:"flex",gap:6}}>
                    <button onClick={()=>addMatch(comp.id)} style={{
                      flex:1,padding:"9px",background:BC.accent,border:"none",borderRadius:8,
                      fontFamily:"'Barlow Condensed',sans-serif",fontSize:13,fontWeight:900,color:"#fff",cursor:"pointer",
                    }}>ADD MATCH</button>
                    <button onClick={()=>{setAddingMatch(null);setMResult(null);setMMethod(null);setMScore("");}} style={{
                      padding:"9px 14px",background:"none",border:`1px solid ${BC.border}`,borderRadius:8,
                      color:BC.dim,fontSize:12,cursor:"pointer",
                    }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button onClick={()=>{setAddingMatch(comp.id);setMResult(null);setMMethod(null);setMScore("");}} style={{
                  width:"100%",padding:"8px",background:"none",border:`1px dashed ${BC.border}`,borderRadius:8,
                  color:BC.dimmer,fontSize:11,cursor:"pointer",marginTop:6,transition:"all 0.15s ease",
                }}>+ Add match</button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BJJApp() {
  const [data, setData] = useState({ sessions: [] });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState("week");
  const [weekOffset, setWeekOffset] = useState(0);
  const [filterGym, setFilterGym] = useState("all"); // all | stark | stt
  const [monthOffset, setMonthOffset] = useState(0);
  const [logTarget, setLogTarget] = useState(null);

  useEffect(() => { loadBJJData().then(d => { setData(d); setLoading(false); }); }, []);
  const save = useCallback(async nd => { setData(nd); await saveBJJData(nd); }, []);

  const cwStart = getWeekStart(new Date());
  const vwStart = new Date(cwStart); vwStart.setDate(vwStart.getDate()+weekOffset*7);
  const weekDates = getWeekDates(vwStart);
  const now = new Date();
  const viewMonth = new Date(now.getFullYear(), now.getMonth()+monthOffset, 1);

  const getSession = (dk,time) => data.sessions.find(s => s.dateKey===dk && s.time===time);
  const getSessionsForDate = dk => data.sessions.filter(s => s.dateKey===dk);

  const handleSave = async info => {
    const {date,classInfo}=logTarget, dk=dateKey(date);
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const exists = getSession(dk,classInfo.time);
    const entry = exists
      ? { ...exists, dateKey:dk, time:classInfo.time, dur:classInfo.dur, gym:classInfo.gym, type:classInfo.type, name:classInfo.name, ...info, ts:now, updatedAt:nowIso }
      : { id:genId(), dateKey:dk, time:classInfo.time, dur:classInfo.dur, gym:classInfo.gym, type:classInfo.type, name:classInfo.name, ...info, ts:now, createdAt:nowIso, updatedAt:nowIso };
    const ns = exists ? data.sessions.map(s=>(s.dateKey===dk&&s.time===classInfo.time)?entry:s) : [...data.sessions,entry];
    await save({...data,sessions:ns}); setLogTarget(null);
  };
  const handleDelete = async () => {
    const {date,classInfo}=logTarget, dk=dateKey(date);
    await save({...data,sessions:data.sessions.filter(s=>!(s.dateKey===dk&&s.time===classInfo.time))}); setLogTarget(null);
  };

  const all = data.sessions;
  const thisWeek = all.filter(s => { const d=new Date(s.dateKey); return d>=cwStart && d<new Date(cwStart.getTime()+7*86400000); });
  const thisMonth = all.filter(s => { const d=new Date(s.dateKey); return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear(); });
  const totalMins = all.reduce((a,s)=>a+(s.dur||60),0);
  const weekMins = thisWeek.reduce((a,s)=>a+(s.dur||60),0);
  const monthMins = thisMonth.reduce((a,s)=>a+(s.dur||60),0);
  const totalRounds = all.reduce((a,s)=>a+(s.rounds||0),0);
  const weekRounds = thisWeek.reduce((a,s)=>a+(s.rounds||0),0);
  const monthRounds = thisMonth.reduce((a,s)=>a+(s.rounds||0),0);
  const intBreak = {light:0,medium:0,hard:0}; all.forEach(s=>{if(s.intensity)intBreak[s.intensity]++;});
  const intTotal = intBreak.light+intBreak.medium+intBreak.hard;

  const getStreak = () => {
    let streak=0, ws=new Date(cwStart);
    while(true) {
      const we=new Date(ws.getTime()+6*86400000);
      if(all.some(s=>{const d=new Date(s.dateKey);return d>=ws&&d<=we;})){streak++;ws.setDate(ws.getDate()-7);}
      else break;
    } return streak;
  };

  const weeklyHours = [];
  for (let i=11;i>=0;i--) {
    const ws=new Date(cwStart); ws.setDate(ws.getDate()-i*7);
    const we=new Date(ws.getTime()+6*86400000);
    const mins=all.filter(s=>{const d=new Date(s.dateKey);return d>=ws&&d<=we;}).reduce((a,s)=>a+(s.dur||60),0);
    weeklyHours.push({mins});
  }
  const maxWM = Math.max(...weeklyHours.map(w=>w.mins),60);

  const weeklyRounds = [];
  for (let i=11;i>=0;i--) {
    const ws=new Date(cwStart); ws.setDate(ws.getDate()-i*7);
    const we=new Date(ws.getTime()+6*86400000);
    const r=all.filter(s=>{const d=new Date(s.dateKey);return d>=ws&&d<=we;}).reduce((a,s)=>a+(s.rounds||0),0);
    weeklyRounds.push({rounds:r});
  }
  const maxR = Math.max(...weeklyRounds.map(w=>w.rounds),1);

  const SL = ({children}) => <div style={{fontSize:9,fontWeight:700,letterSpacing:"0.14em",color:BC.dimmer,textTransform:"uppercase",margin:"20px 0 10px"}}>{children}</div>;

  if (loading) return <div style={{minHeight:"100vh",background:BC.bg,display:"flex",alignItems:"center",justifyContent:"center"}}><div style={{color:BC.accent,fontFamily:"'Barlow Condensed',sans-serif",fontSize:18,fontWeight:700}}>LOADING...</div></div>;

  return (
    <div style={{minHeight:"100vh",background:BC.bg,color:BC.text,fontFamily:"'Barlow','Helvetica Neue',sans-serif",paddingBottom:60}}>

      {/* Hero */}
      <div style={{background:"linear-gradient(180deg,#111113 0%,#09090b 100%)",borderBottom:`1px solid ${BC.border}`,padding:"24px 20px 18px",position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",top:-80,right:-60,width:240,height:240,background:`radial-gradient(circle,${BC.accentBg} 0%,transparent 70%)`,pointerEvents:"none"}}/>
        <div style={{fontSize:9,fontWeight:700,letterSpacing:"0.16em",color:BC.accent,textTransform:"uppercase",marginBottom:6}}>Start Jiu Jitsu · Stockholm</div>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:900,lineHeight:1,marginBottom:5}}>BJJ TRACKER</div>
        <div style={{fontSize:12,color:BC.dim}}>Stark IF · Sweden Top Team</div>
      </div>

      {/* Stats bar */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",borderBottom:`1px solid ${BC.border}`}}>
        {[
          {label:"This week",value:thisWeek.length,color:BC.accent},
          {label:"This month",value:thisMonth.length,color:BC.text},
          {label:"Total",value:all.length,color:BC.text},
          {label:"Streak",value:`${getStreak()}w`,color:BC.yellow},
        ].map((s,i)=>(
          <div key={i} style={{background:BC.surface,padding:"12px 14px",borderRight:i<3?`1px solid ${BC.border}`:"none"}}>
            <div style={{fontSize:9,color:BC.dimmer,textTransform:"uppercase",letterSpacing:"0.08em",fontWeight:600,marginBottom:3}}>{s.label}</div>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:17,fontWeight:700,color:s.color}}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Nav */}
      <nav style={{display:"flex",background:BC.surface,borderBottom:`1px solid ${BC.border}`}}>
        {[{id:"week",label:"Week"},{id:"month",label:"Month"},{id:"dashboard",label:"Dashboard"},{id:"results",label:"Results"}].map(item=>(
          <button key={item.id} onClick={()=>setPage(item.id)} style={{
            flex:1,padding:"14px 8px",fontFamily:"'Barlow Condensed',sans-serif",fontSize:12,fontWeight:700,
            letterSpacing:"0.08em",textTransform:"uppercase",
            color:page===item.id?BC.accent:BC.dimmer,background:"none",border:"none",
            borderBottom:`2px solid ${page===item.id?BC.accent:"transparent"}`,
            cursor:"pointer",transition:"all 0.2s ease",
          }}>{item.label}</button>
        ))}
      </nav>

      <div style={{maxWidth:640,margin:"0 auto",padding:"18px 16px"}}>

        {/* ─── WEEK ─── */}
        {page==="week" && (
          <div style={{animation:"fadeIn 0.3s ease"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",margin:"4px 0 16px"}}>
              <button onClick={()=>setWeekOffset(weekOffset-1)} style={{background:"none",border:`1px solid ${BC.border}`,borderRadius:8,color:BC.dim,padding:"6px 12px",cursor:"pointer",fontSize:14}}>‹</button>
              <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:16,fontWeight:800,color:weekOffset===0?BC.accent:BC.text}}>
                {weekOffset===0?"This Week":`${fmtShort(vwStart)} – ${fmtShort(weekDates[6])}`}
              </div>
              <button onClick={()=>setWeekOffset(weekOffset+1)} style={{background:"none",border:`1px solid ${BC.border}`,borderRadius:8,color:BC.dim,padding:"6px 12px",cursor:"pointer",fontSize:14}}>›</button>
            </div>

            {/* Filters */}
            <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap"}}>
              <div style={{display:"flex",gap:3,background:"rgba(255,255,255,0.03)",border:`1px solid ${BC.border}`,borderRadius:8,padding:3}}>
                {[["all","All gyms"],["stark","Stark"],["stt","STT"]].map(([v,l]) => (
                  <button key={v} onClick={()=>setFilterGym(v)} style={{
                    padding:"5px 10px",borderRadius:6,border:"none",cursor:"pointer",
                    fontSize:10,fontWeight:700,letterSpacing:"0.05em",textTransform:"uppercase",
                    fontFamily:"'Barlow Condensed',sans-serif",
                    background:filterGym===v?BC.accentBg:"transparent",
                    color:filterGym===v?BC.accent:BC.dimmer,
                    transition:"all 0.15s ease",
                  }}>{l}</button>
                ))}
              </div>
            </div>

            {weekDates.map((date,di) => {
              const sched=SCHEDULE[di], dk=dateKey(date), today=isToday(date);
              const daySessions=getSessionsForDate(dk);
              const isPast = date < new Date(new Date().setHours(0,0,0,0)) && !today;

              return (
                <div key={di} style={{
                  marginBottom:6,background:today?BC.accentBg:BC.card,
                  border:`1px solid ${today?BC.accentBorder:BC.border}`,
                  borderRadius:12,overflow:"hidden",
                  opacity:isPast&&daySessions.length===0?0.45:1,
                  animation:`fadeIn 0.3s ease ${di*0.04}s both`,transition:"opacity 0.3s ease",
                }}>
                  <div style={{padding:"10px 14px",display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${BC.border}`}}>
                    <div style={{
                      width:36,height:36,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",
                      fontFamily:"'Barlow Condensed',sans-serif",fontSize:13,fontWeight:900,
                      background:today?BC.accentBg:"rgba(255,255,255,0.04)",
                      color:today?BC.accent:BC.dim,border:`1px solid ${today?BC.accentBorder:"rgba(255,255,255,0.06)"}`,
                    }}>{sched.label}</div>
                    <div>
                      <div style={{fontSize:13,fontWeight:600,color:today?BC.text:BC.dim}}>{fmtShort(date)}</div>
                      <div style={{fontSize:10,color:BC.dimmer}}>{sched.classes.length} class{sched.classes.length>1?"es":""}</div>
                    </div>
                    {daySessions.length>0 && (
                      <div style={{marginLeft:"auto",display:"flex",gap:4,alignItems:"center"}}>
                        {daySessions.map((s,si) => {
                          const int=INTENSITY.find(i=>i.id===s.intensity);
                          return <div key={si} style={{width:8,height:8,borderRadius:"50%",background:int?.color||BC.accent}}/>;
                        })}
                        <div style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:99,background:BC.accentBg,color:BC.accent,border:`1px solid ${BC.accentBorder}`,marginLeft:4}}>{daySessions.length} logged</div>
                      </div>
                    )}
                  </div>
                  <div style={{padding:"6px 8px"}}>
                    {sched.classes.filter(cls => filterGym==="all"||cls.gym===filterGym).map((cls,ci,arr) => {
                      const session=getSession(dk,cls.time);
                      const gymMeta = GYM_META[cls.gym];
                      return (
                        <div key={ci} onClick={()=>setLogTarget({date,classInfo:cls})} style={{
                          display:"flex",alignItems:"center",gap:12,padding:"10px 10px",borderRadius:8,cursor:"pointer",
                          background:session?"rgba(124,154,114,0.04)":"transparent",
                          transition:"background 0.15s ease",marginBottom:ci<arr.length-1?4:0,
                        }}>
                          <div style={{
                            width:22,height:22,borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center",
                            border:`1.5px solid ${session?BC.accent:"rgba(255,255,255,0.1)"}`,
                            background:session?BC.accentBg:"transparent",color:session?BC.accent:"transparent",fontSize:12,fontWeight:700,
                          }}>{session?"✓":""}</div>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontSize:13,fontWeight:600,color:session?BC.text:BC.dim,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                              <span style={{fontSize:8,fontWeight:800,padding:"1px 6px",borderRadius:4,background:`${gymMeta.color}15`,color:gymMeta.color,border:`1px solid ${gymMeta.color}35`,letterSpacing:"0.06em"}}>{gymMeta.label.toUpperCase()}</span>
                              <span>{cls.name}</span>
                              <span style={{fontWeight:400,color:BC.dimmer,fontSize:11}}>· {cls.dur} min</span>
                            </div>
                            {session?.notes && <div style={{fontSize:10,color:BC.dimmer,marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:240}}>{session.notes}</div>}
                          </div>
                          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:15,fontWeight:700,color:session?BC.text:BC.dimmer}}>{cls.time}</div>
                          {session?.intensity && (() => {
                            const int=INTENSITY.find(i=>i.id===session.intensity);
                            return <div style={{fontSize:9,fontWeight:700,padding:"2px 7px",borderRadius:99,background:int?.bg,color:int?.color}}>{int?.label}</div>;
                          })()}
                          {session && session.rounds>0 && <div style={{fontSize:11,color:BC.dim,fontWeight:600}}>{session.rounds}r</div>}
                          {!session && <div style={{fontSize:11,color:BC.dimmer,fontWeight:500}}>+ Log</div>}
                        </div>
                      );
                    })}
                    {sched.classes.filter(cls => filterGym==="all"||cls.gym===filterGym).length===0 && (
                      <div style={{fontSize:11,color:BC.dimmer,padding:"8px 10px",fontStyle:"italic"}}>No classes match filter</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ─── MONTH ─── */}
        {page==="month" && (
          <div style={{animation:"fadeIn 0.3s ease"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",margin:"4px 0 16px"}}>
              <button onClick={()=>setMonthOffset(monthOffset-1)} style={{background:"none",border:`1px solid ${BC.border}`,borderRadius:8,color:BC.dim,padding:"6px 12px",cursor:"pointer",fontSize:14}}>‹</button>
              <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:16,fontWeight:800,color:monthOffset===0?BC.accent:BC.text}}>
                {MONTH_NAMES[viewMonth.getMonth()]} {viewMonth.getFullYear()}
              </div>
              <button onClick={()=>setMonthOffset(monthOffset+1)} style={{background:"none",border:`1px solid ${BC.border}`,borderRadius:8,color:BC.dim,padding:"6px 12px",cursor:"pointer",fontSize:14}}>›</button>
            </div>

            <div style={{background:BC.card,border:`1px solid ${BC.border}`,borderRadius:12,padding:16,marginBottom:14}}>
              <Heatmap sessions={all} year={viewMonth.getFullYear()} month={viewMonth.getMonth()}/>
            </div>

            <div style={{display:"flex",gap:10,justifyContent:"center",marginBottom:16}}>
              {[{l:"Light",c:BC.green},{l:"Medium",c:BC.yellow},{l:"Hard",c:BC.red}].map(x=>(
                <div key={x.l} style={{display:"flex",alignItems:"center",gap:4,fontSize:10,color:BC.dim}}>
                  <div style={{width:10,height:10,borderRadius:3,background:x.c}}/>{x.l}
                </div>
              ))}
            </div>

            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
              {[
                {l:"Sessions",v:thisMonth.length,c:BC.accent},
                {l:"Hours",v:`${(monthMins/60).toFixed(1)}`,c:BC.accent},
                {l:"Rounds",v:monthRounds,c:BC.yellow},
              ].map((s,i)=>(
                <div key={i} style={{background:BC.card,border:`1px solid ${BC.border}`,borderRadius:10,padding:12,textAlign:"center"}}>
                  <div style={{fontSize:9,fontWeight:600,color:BC.dimmer,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:4}}>{s.l}</div>
                  <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:24,fontWeight:900,color:s.c}}>{s.v}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ─── DASHBOARD ─── */}
        {page==="dashboard" && (
          <div style={{animation:"fadeIn 0.3s ease"}}>
            {/* Current vs Total metrics */}
            <SL>Sessions</SL>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:6}}>
              {[
                {l:"This week",v:thisWeek.length,c:BC.accent},
                {l:"This month",v:thisMonth.length,c:BC.text},
                {l:"This year",v:all.length,c:BC.text},
              ].map((s,i)=>(
                <div key={i} style={{background:BC.card,border:`1px solid ${BC.border}`,borderRadius:12,padding:14,textAlign:"center"}}>
                  <div style={{fontSize:9,fontWeight:600,color:BC.dimmer,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6}}>{s.l}</div>
                  <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:900,color:s.c,lineHeight:1}}>{s.v}</div>
                </div>
              ))}
            </div>

            <SL>Mat hours</SL>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:6}}>
              {[
                {l:"This week",v:`${(weekMins/60).toFixed(1)}`,c:BC.accent},
                {l:"This month",v:`${(monthMins/60).toFixed(1)}`,c:BC.text},
                {l:"This year",v:`${(totalMins/60).toFixed(1)}`,c:BC.text},
              ].map((s,i)=>(
                <div key={i} style={{background:BC.card,border:`1px solid ${BC.border}`,borderRadius:12,padding:14,textAlign:"center"}}>
                  <div style={{fontSize:9,fontWeight:600,color:BC.dimmer,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6}}>{s.l}</div>
                  <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:900,color:s.c,lineHeight:1}}>{s.v}</div>
                  <div style={{fontSize:10,color:BC.dimmer,marginTop:4}}>hours</div>
                </div>
              ))}
            </div>

            <SL>Rounds</SL>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:6}}>
              {[
                {l:"This week",v:weekRounds,c:BC.accent},
                {l:"This month",v:monthRounds,c:BC.text},
                {l:"This year",v:totalRounds,c:BC.text},
              ].map((s,i)=>(
                <div key={i} style={{background:BC.card,border:`1px solid ${BC.border}`,borderRadius:12,padding:14,textAlign:"center"}}>
                  <div style={{fontSize:9,fontWeight:600,color:BC.dimmer,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6}}>{s.l}</div>
                  <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:900,color:s.c,lineHeight:1}}>{s.v}</div>
                </div>
              ))}
            </div>

            {/* Intensity */}
            <SL>Intensity</SL>
            <div style={{background:BC.card,border:`1px solid ${BC.border}`,borderRadius:12,padding:16,marginBottom:6}}>
              {intTotal===0 ? (
                <div style={{textAlign:"center",padding:"24px 0",color:BC.dimmer,fontSize:12}}>No data yet</div>
              ) : (
                <>
                  <div style={{display:"flex",height:10,borderRadius:5,overflow:"hidden",marginBottom:14,gap:2}}>
                    {intBreak.light>0&&<div style={{flex:intBreak.light,background:BC.green,borderRadius:5}}/>}
                    {intBreak.medium>0&&<div style={{flex:intBreak.medium,background:BC.yellow,borderRadius:5}}/>}
                    {intBreak.hard>0&&<div style={{flex:intBreak.hard,background:BC.red,borderRadius:5}}/>}
                  </div>
                  <div style={{display:"flex",justifyContent:"space-around"}}>
                    {INTENSITY.map(int=>(
                      <div key={int.id} style={{textAlign:"center"}}>
                        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:900,color:int.color}}>{intBreak[int.id]}</div>
                        <div style={{fontSize:10,color:BC.dim}}>{int.label}</div>
                        <div style={{fontSize:9,color:BC.dimmer}}>{Math.round((intBreak[int.id]/intTotal)*100)}%</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Recent notes */}
            <SL>Recent notes</SL>
            <div style={{marginBottom:14}}>
              {all.filter(s=>s.notes).length===0 ? (
                <div style={{background:BC.card,border:`1px solid ${BC.border}`,borderRadius:12,padding:24,textAlign:"center",color:BC.dimmer,fontSize:12}}>Session notes will show here</div>
              ) : (
                <div style={{display:"flex",flexDirection:"column",gap:6}}>
                  {[...all].filter(s=>s.notes).sort((a,b)=>b.ts-a.ts).slice(0,15).map((s,i)=>{
                    const int=INTENSITY.find(x=>x.id===s.intensity);
                    return (
                      <div key={i} style={{
                        padding:"12px 14px",borderRadius:10,background:BC.card,border:`1px solid ${BC.border}`,
                        borderLeft:`3px solid ${int?.color||BC.accent}`,animation:`fadeIn 0.3s ease ${i*0.04}s both`,
                      }}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                          <span style={{fontSize:11,fontWeight:600,color:BC.dim}}>
                            {new Date(s.dateKey).toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"})}
                            <span style={{color:BC.dimmer,marginLeft:6}}>{s.time}</span>
                          </span>
                          <div style={{display:"flex",gap:6,alignItems:"center"}}>
                            {s.rounds>0&&<span style={{fontSize:10,color:BC.dim}}>{s.rounds} rounds</span>}
                            {int&&<span style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:99,background:int.bg,color:int.color}}>{int.label}</span>}
                          </div>
                        </div>
                        <div style={{fontSize:12,color:BC.text,lineHeight:1.5}}>{s.notes}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div style={{display:"flex",justifyContent:"flex-end",marginTop:12}}>
              <button onClick={async()=>{if(confirm("Clear all data?")){await save({sessions:[]});}}} style={{background:"none",border:`1px solid ${BC.border}`,borderRadius:6,color:BC.dimmer,fontSize:11,padding:"5px 10px",cursor:"pointer"}}>Clear all data</button>
            </div>
          </div>
        )}

        {/* ─── RESULTS ─── */}
        {page==="results" && <ResultsPage />}
      </div>

      {logTarget && <LogPanel date={logTarget.date} classInfo={logTarget.classInfo} existing={getSession(dateKey(logTarget.date),logTarget.classInfo.time)} onSave={handleSave} onDelete={handleDelete} onClose={()=>setLogTarget(null)}/>}

    </div>
  );
}



// ══════════════════════════════════════════════════════════════
// MAIN SHELL
// ══════════════════════════════════════════════════════════════

export default function App() {
  const [activeApp, setActiveApp] = useState("conditioning");

  return (
    <div style={{ minHeight: "100vh", background: "#09090b", fontFamily: "'Barlow', 'Helvetica Neue', sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;900&family=Barlow:wght@400;500;600&display=swap" rel="stylesheet" />

      <div style={{
        display: "flex", background: "#050506",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        position: "sticky", top: 0, zIndex: 50,
      }}>
        {APP_TABS.map(tab => (
          <button key={tab.id} onClick={() => setActiveApp(tab.id)} style={{
            flex: 1, padding: "12px 6px",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
            background: activeApp === tab.id ? `${tab.color}08` : "transparent",
            border: "none",
            borderBottom: `2px solid ${activeApp === tab.id ? tab.color : "transparent"}`,
            cursor: "pointer", transition: "all 0.2s ease",
          }}>
            <span style={{ fontSize: 16 }}>{tab.icon}</span>
            <span style={{
              fontFamily: "'Barlow Condensed', sans-serif", fontSize: 10, fontWeight: 700,
              letterSpacing: "0.1em", textTransform: "uppercase",
              color: activeApp === tab.id ? tab.color : "rgba(255,255,255,0.2)",
              transition: "color 0.2s ease",
            }}>{tab.label}</span>
          </button>
        ))}
        <div style={{
          padding: "12px 10px", display: "flex", alignItems: "center",
          fontSize: 8, fontWeight: 800, letterSpacing: "0.1em",
          color: "rgba(255,255,255,0.25)", fontFamily: "'Barlow Condensed', sans-serif",
        }}>V2</div>
      </div>

      <div key={activeApp} style={{ animation: "fadeIn 0.25s ease" }}>
        {activeApp === "conditioning" && <ConditioningApp />}
        {activeApp === "gym" && <GymApp />}
        {activeApp === "bjj" && <BJJApp />}
      </div>

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes slideDown { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: translateY(0); } }
        input::placeholder { color: rgba(255,255,255,0.15); }
        textarea::placeholder { color: rgba(255,255,255,0.15); }
        input:focus, textarea:focus { border-color: rgba(255,255,255,0.2) !important; }
        input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
        input[type=number] { -moz-appearance: textfield; }
        button:hover { opacity: 0.85; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { display: none; }
      `}</style>
    </div>
  );
}
