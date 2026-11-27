// Daebot Studio: the user's bots as workers in a dark isometric office (the view behind the Studio tab). Studio 5: the floor is drawn
// from the account's own layout (GET /studio .layout + each department's palette, slot and card stats), which the Studio Builder on the
// server builds from the account's bots and keeps current; this file is the one renderer every account shares. One department is one island;
// each bot is a desk on its island, drawn with its own face and LED colour; the main Daebot sits in the Manager office; MIND is the
// Brain in the middle (THE BRAIN, a node graph on a grey platform, walkways to every island); dotted arcs are bot_talk traffic between
// islands with dots walking them. A card floats over each island (name, N agents, the two stats its layout picked, doing · next · done,
// a yellow "N waiting approval" pill that opens the task board). The top bar shows the workspace, the apps it is connected to, what it
// runs headless on and a live clock; the rooms are tabs under it. The right column is the task status (a new-task box, six filter
// pills with counts, cards with a progress pill) or the bot talk log. Everything is built with createElement/createElementNS and
// textContent: no innerHTML anywhere. Pure helpers are exported for tests; the DOM lives in initStudio.
import { faceSvg } from "./faces.js";
import { proofChips } from "./board.js";
import { markFor } from "./apps-icons.js";

const NS = "http://www.w3.org/2000/svg";
export const REFRESH_MS = 10000;
export const VIEW_W = 1000, VIEW_H = 640;
export const STATUS = { idle: "Idle", working: "Working", blocked: "Needs you" };
export const FILTERS = [["all", "All"], ["waiting", "Waiting"], ["in_progress", "In progress"], ["not_started", "Backlog"], ["ready_to_test", "Done"]];
export const LIGHT = { not_started: "red", in_progress: "yellow", ready_to_test: "green", stopped: "red", cancelled: "grey" };
export const ROOMS = [["overview", "Overview"], ["live", "Live"], ["office", "Manager office"], ["meeting", "Meeting room"], ["lounge", "Lounge"], ["workspaces", "Workspaces"], ["team", "Token team"], ["pipelines", "Pipelines"]];
/** Stage marks for an island: done ✓, running ◐, failed ✗, todo ○. */
/** The Live room (helpers and loops, agents/hub.ts) refreshes this often while something runs or the room is open. */
export const LIVE_MS = 2000;
/** Rooms every office has, whatever its saved layout lists. */
export const ALWAYS_ROOMS = ["overview", "live"];
export const KIND_LABEL = { explore: "Explore", research: "Research", review: "Review", plan: "Plan", build: "Build", grade: "Grade", draft: "Draft" };
export const PHASE_LABEL = { study: "Studying MIND", build: "Building", grade: "Grading", cleared: "Cleared", stopped: "Stopped", failed: "Failed" };
/** Counts for the Live room's tiles and the top bar's live chip. */
export function liveSummary(live) {
  const helpers = (live && Array.isArray(live.helpers)) ? live.helpers : [];
  const loops = (live && Array.isArray(live.loops)) ? live.loops : [];
  const branches = new Set([...helpers.filter((x) => x.branch).map((x) => x.branch), ...loops.filter((l) => l.branch && l.endedAt).map((l) => l.branch)]);
  return { working: helpers.filter((x) => x.status === "running").length, loops: loops.filter((l) => !l.endedAt).length, branches: branches.size, done: helpers.filter((x) => x.status === "done").length, failed: helpers.filter((x) => x.status === "failed").length };
}
/** One mark per cycle of a loop: a score, "now" for the cycle in flight, or "todo". */
export function loopRail(l) {
  const out = [];
  const n = Math.max(1, Math.min(10, Number(l && l.maxCycles) || 1));
  const scores = Array.isArray(l && l.scores) ? l.scores : [];
  for (let i = 0; i < n; i++) {
    if (i < scores.length) out.push({ kind: scores[i] >= l.bar ? "pass" : "score", score: scores[i] });
    else if (!l.endedAt && i === scores.length && l.cycle > 0) out.push({ kind: "now" });
    else out.push({ kind: "todo" });
  }
  return out;
}
/** "42s", "3m 05s", "1h 02m". */
export function elapsedText(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
export const LIVE_EXAMPLES = [
  ["Explore in parallel", "Use helpers in parallel to map how sign-in, billing and the task board work in this codebase, then give me a one-page summary."],
  ["Run a loop", "/loop write a go-to-market launch plan for Daebot Studio with pricing, ICP and a two-week launch checklist"],
];

export const STAGE_MARK = { done: "✓", running: "◐", failed: "✗", todo: "○" };
export const stageMarks = (marks) => (Array.isArray(marks) ? marks.map((m) => STAGE_MARK[m] || STAGE_MARK.todo).join("") : "");
/** One line for the island card: the newest counters ("applications 389 · docs live 8"). */
export const countersLine = (list) => (Array.isArray(list) ? list.filter((c) => c && c.name).slice(0, 3).map((c) => `${c.name} ${fmtNum(c.value)}`).join(" · ") : "");
export const fmtNum = (n) => (typeof n !== "number" || !Number.isFinite(n) ? "–" : Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 10000 ? `${(n / 1000).toFixed(1)}k` : Number.isInteger(n) ? String(n) : n.toFixed(2));
/** The token team's roles by tier, as the Altair "token team" screenshot names them. */
export const TIER_ROLES = { frontier: "advisor", reasoner: "worker (standard)", coder: "worker", light: "chat", reflex: "scout", local: "scout (local)" };
export const fmtUsd = (n) => (!n ? "$0.00" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
export const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));
export const EXAMPLES = ["Research our top three competitors and file a one-page brief in MIND", "Draft this week's client follow-up emails for my review", "Audit the open tasks on the board and tell me what is stuck", "Build a landing page for the new offer and show me a screenshot"];
/** Idle lines for the Lounge; picked per bot and hour, so a bot keeps its line for a while and the floor still changes over the day. */
export const LOUNGE_LINES = ["grabbing a coffee", "reading the board", "tidying its MIND", "waiting for a task", "at the whiteboard", "stretching its legs", "filing yesterday's notes", "back at the desk soon"];
const COLOR_RE = /^#[0-9a-f]{6}$/i;
export const MAX_LOG = 40;

export const badgeText = (n) => (n === 1 ? "1 waiting approval" : `${n} waiting approval`);
export const safeColor = (c) => (typeof c === "string" && COLOR_RE.test(c) ? c : "#ffd25a");

/** The task column under a filter chip. "waiting" is the red rows (stopped). Cancelled rows show only under All. */
export function filterTasks(tasks, f) {
  const list = Array.isArray(tasks) ? tasks.filter((t) => t && typeof t.title === "string") : [];
  if (f === "waiting") return list.filter((t) => t.status === "stopped");
  if (f === "in_progress" || f === "not_started" || f === "ready_to_test") return list.filter((t) => t.status === f);
  return list;
}

/** Island centres: the first (the Manager office) at the top, the rest around an ellipse, clockwise; the Brain is the middle. */
export function layoutIslands(n, W = VIEW_W, H = VIEW_H) {
  const out = [];
  if (n <= 0) return out;
  const cx = W / 2, cy = H / 2 + 10, rx = W * 0.37, ry = H * 0.34;
  if (n === 1) return [{ x: cx, y: cy - ry }];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    out.push({ x: Math.round(cx + rx * Math.cos(a)), y: Math.round(cy + ry * Math.sin(a)) });
  }
  return out;
}

/** The top face of an isometric slab as a polygon points string. */
export function isoPoints(cx, cy, w, h) {
  return `${cx},${cy - h / 2} ${cx + w / 2},${cy} ${cx},${cy + h / 2} ${cx - w / 2},${cy}`;
}

/** Desk positions on an island's top face: an isometric grid, as square as the count allows, centred on the slab. */
export function deskSlots(k, cx, cy, w, h) {
  const slots = [];
  if (k <= 0) return slots;
  const cols = Math.ceil(Math.sqrt(k)), rows = Math.ceil(k / cols);
  const sx = (w / 2) / (Math.max(cols, rows) + 1), sy = (h / 2) / (Math.max(cols, rows) + 1);
  for (let i = 0; i < k; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    const u = c - (cols - 1) / 2, v = r - (rows - 1) / 2;
    slots.push({ x: Math.round(cx + (u - v) * sx), y: Math.round(cy + (u + v) * sy) });
  }
  return slots;
}

/** The island a bot's desk belongs to, by id; the Manager office when the bot is unknown. */
export function islandOf(view, botId) {
  const d = (view && view.departments || []).find((x) => x.bots && x.bots.includes(botId));
  return d ? d.slug : "manager-office";
}

/** A lounge line for a bot: stable within the hour, different across bots. */
export function loungeLine(botId, hour) {
  let n = 0;
  for (const ch of String(botId || "")) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return LOUNGE_LINES[(n + (hour | 0)) % LOUNGE_LINES.length];
}

/** Which island pairs got new bot_talk traffic since the last view: those get a walking dot. */
export function walks(prev, next) {
  const before = new Map();
  for (const l of (prev && prev.links) || []) before.set(`${l.a}|${l.b}`, l.at);
  const out = [];
  for (const l of (next && next.links) || []) {
    if (l.a === l.b) continue;
    const was = before.get(`${l.a}|${l.b}`);
    if (was !== undefined && l.at > was) out.push({ a: l.a, b: l.b });
  }
  return out;
}

/** The communication log: every message of the given exchanges, newest first, each with who said it to whom. */
export function mergeLog(exchanges, max = MAX_LOG) {
  const out = [];
  for (const ex of Array.isArray(exchanges) ? exchanges : []) {
    if (!ex || !Array.isArray(ex.messages)) continue;
    const a = ex.a || {}, b = ex.b || {};
    for (const m of ex.messages) {
      if (!m || typeof m.text !== "string") continue;
      const from = m.from === a.id ? a : b, to = m.from === a.id ? b : a;
      out.push({ id: `${ex.id}/${m.id}`, at: m.at || 0, from: from.name || "?", to: to.name || "?", fromColor: from.color || "", text: m.text, kind: m.kind === "reply" ? "reply" : "message", exchange: ex.id });
    }
  }
  return out.sort((p, q) => q.at - p.at).slice(0, max);
}

/** Each tier's share of the turns in a cost summary, largest first; tiers with no turns are left out. */
export function teamShares(summary) {
  const by = (summary && summary.byTier) || {};
  const total = Object.values(by).reduce((n, t) => n + (t.turns || 0), 0);
  return Object.entries(by).filter(([, t]) => t.turns > 0).map(([tier, t]) => ({ tier, turns: t.turns, costUsd: t.costUsd || 0, tokensIn: t.tokensIn || 0, tokensOut: t.tokensOut || 0, verified: t.verified || 0, share: total ? Math.round((100 * t.turns) / total) : 0 })).sort((a, b) => b.turns - a.turns || a.tier.localeCompare(b.tier));
}

/** The saving line: what the turns cost against the all-frontier counterfactual. */
export function savingText(summary) {
  if (!summary || !summary.known) return "No priced turns yet.";
  const saved = summary.frontierUsd - summary.costUsd;
  return `${fmtUsd(summary.costUsd)} spent vs ${fmtUsd(summary.frontierUsd)} all-frontier${saved > 0 ? ` (${Math.round((100 * saved) / summary.frontierUsd)}% saved)` : ""}`;
}

/** Progress of a project as a percent of tasks ready to test. */
export const progressPct = (p) => (p && p.total > 0 ? Math.round((100 * p.done) / p.total) : 0);

// ---- The office (Studio 5): one shared renderer for every account; the account's layout (islands, places, colours, card stats)
// comes from GET /studio as data (src/studio/layout.ts), so the floor is built per user and kept up to date by the Studio Builder. ----

/** Island colours by palette key: [top, left side, right side, glow]. */
export const PAL = {
  green: ["#34c27a", "#1f8a55", "#176b42", "#4dffa6"], teal: ["#3b9fe0", "#2470a8", "#1b5884", "#6cc8ff"],
  pink: ["#e0679d", "#a8466f", "#863757", "#ff9cc7"], purple: ["#9161dc", "#6a43a8", "#543585", "#c39bff"],
  indigo: ["#5d6ff0", "#4150b8", "#333f92", "#93a0ff"], yellow: ["#d8b53e", "#a2862a", "#7f6920", "#ffe27a"],
  orange: ["#e8874a", "#ad6233", "#894d27", "#ffb27f"], cyan: ["#33c6c6", "#22918f", "#1a7271", "#7ff4f2"],
};
export const palOf = (k) => PAL[k] || PAL.indigo;
/** Grid step of the iso floor (one slot), the island and the Brain sizes, in world units. */
export const TW = 250, TH = 146, IW = 146, IH = 73, ID = 22, BW = 128, BH = 64, BD = 28;
export const iso = (u, v) => ({ x: (u - v) * TW, y: (u + v) * TH });
/** The six filter pills of the task column, with what each counts. */
export const PILLS = [["all", "All"], ["scheduled", "Scheduled"], ["not_started", "Backlog"], ["in_progress", "In progress"], ["waiting", "Waiting"], ["ready_to_test", "Done"]];
export function pillCounts(v) {
  const t = (v && v.tasks) || [];
  const live = t.filter((x) => x.status !== "cancelled");
  return { all: live.length, scheduled: ((v && v.scheduled) || []).length, not_started: t.filter((x) => x.status === "not_started").length, in_progress: t.filter((x) => x.status === "in_progress").length, waiting: t.filter((x) => x.status === "stopped").length, ready_to_test: t.filter((x) => x.status === "ready_to_test").length };
}
/** Desk places on an island top, in island-local screen units: an iso grid as square as the count allows, and the desk scale. */
export function deskGrid(k) {
  if (k <= 0) return { slots: [], scale: 1, room: 2 * IW };
  const cols = Math.ceil(Math.sqrt(k)), rows = Math.ceil(k / cols), n = Math.max(cols, rows);
  const pitch = 1.45 / (n + 0.9);
  const slots = [];
  for (let i = 0; i < k; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    const u = (c - (cols - 1) / 2) * pitch, w = (r - (rows - 1) / 2) * pitch;
    slots.push({ x: Math.round((u - w) * IW), y: Math.round((u + w) * IH) });
  }
  // room: the screen width between two desks on the same row, the most a name label may take without touching its neighbour's.
  return { slots, scale: Math.min(1.4, 3.5 / (n + 0.6)), room: Math.round(2 * pitch * IW) };
}
/** The world box that holds every island and the Brain (cards float in screen space: padTop/padBottom are the pixels they need). */
export function worldBounds(depts) {
  let x0 = -BW - 30, x1 = BW + 30, y0 = -BH - 60, y1 = BH + BD + 30, below = false, level = false;
  for (const d of depts || []) {
    const p = iso(d.u, d.v);
    if (p.y > 0) below = true;
    if (p.y === 0) level = true;
    x0 = Math.min(x0, p.x - IW - 30); x1 = Math.max(x1, p.x + IW + 30);
    y0 = Math.min(y0, p.y - IH - 20); y1 = Math.max(y1, p.y + IH + ID + 24);
  }
  const minW = 900, minH = 560;
  if (x1 - x0 < minW) { const g = (minW - (x1 - x0)) / 2; x0 -= g; x1 += g; }
  if (y1 - y0 < minH) { const g = (minH - (y1 - y0)) / 2; y0 -= g; y1 += g; }
  return { x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(x1 - x0), h: Math.ceil(y1 - y0), padTop: 150, padBottom: below ? 160 : 24, padSide: level ? 70 : 16 };
}
/**
 * Places the island cards in screen space so no two collide, none sits on the Brain's label, and as few as possible sit on an island.
 * Each card tries the far side of its island from the Brain first (above for islands above it, below for those below, outward for
 * those level with it), lifted further out in steps when that spot is taken, then the other sides. Score: a card-on-card overlap
 * outweighs everything, then leaving the floor, then covering an island; ties keep the preferred order.
 * items: [{ id, cx, cy, top, bottom, left, right, w, h, side, wx, wy }] (px; wx/wy the island's floor position); fixed: rects already
 * taken (the Brain's label); islands: island rects to avoid; bounds: { w, h } of the floor. Returns id -> { x, y, side }.
 */
export function placeCards(items, fixed = [], islands = [], bounds = null, gap = 10) {
  const placed = fixed.map((r) => ({ ...r }));
  const ov = (a, b, g) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) + g) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) + g);
  const cardHit = (r) => placed.reduce((n, b) => n + ov(r, b, gap), 0);
  const isleHit = (r, own) => islands.reduce((n, b) => (b.id === own ? n : n + ov(r, b, 0)), 0);
  const outside = (r) => (bounds ? Math.max(0, -r.x) + Math.max(0, r.x + r.w - bounds.w) + Math.max(0, -r.y) + Math.max(0, r.y + r.h - bounds.h) : 0);
  const spot = (it, side, lift) => side === "above" ? { x: it.cx - it.w / 2, y: it.top - it.h - gap - lift, w: it.w, h: it.h, side }
    : side === "below" ? { x: it.cx - it.w / 2, y: it.bottom + gap + lift, w: it.w, h: it.h, side }
    : side === "right" ? { x: it.right + gap + lift, y: it.cy - it.h / 2, w: it.w, h: it.h, side }
    : { x: it.left - it.w - gap - lift, y: it.cy - it.h / 2, w: it.w, h: it.h, side };
  const outward = (it) => ((it.wx ?? 0) >= 0 ? "right" : "left");
  const sides = (it) => (it.side === "above" ? ["above", outward(it), "below"] : it.side === "below" ? ["below", outward(it), "above"] : [it.side, "above", "below"]);
  const out = {};
  // The top of the floor first (its cards have only the sky above them), then the bottom, then the middle rows; the outer columns
  // before the inner ones on each row, since an outer card can still step outward.
  const key = (it) => [Math.abs(it.wy ?? 0) * -1, -Math.abs(it.wx ?? 0)];
  const list = [...items].sort((a, b) => { const p = key(a), q = key(b); return p[0] - q[0] || (a.wy ?? 0) - (b.wy ?? 0) || p[1] - q[1]; });
  for (const it of list) {
    let best = null, bestScore = Infinity, rank = 0;
    for (const sd of sides(it)) for (const lift of [0, 28, 56, 84, 112, 140]) {
      const r = spot(it, sd, lift);
      const score = cardHit(r) * 1e6 + outside(r) * 1e4 + isleHit(r, it.id) + rank++ * 40;
      if (score < bestScore) { best = r; bestScore = score; }
    }
    placed.push(best);
    out[it.id] = { x: best.x, y: best.y, side: best.side };
  }
  return out;
}

/** A desk's name tag: font size from the desk scale, the name clipped with an ellipsis to fit the room between desks. */
export function tagText(name, scale, room) {
  const f = Math.max(7.5, Math.min(11, 10.5 * scale));
  const cw = f * 0.6, max = Math.max(3, Math.floor((room * 0.74 - f) / cw));
  const n = String(name || "?");
  const text = n.length > max ? n.slice(0, max - 1) + "…" : n;
  return { text, f, w: Math.round(text.length * cw + f * 1.1) };
}

/** The island whose card glows: the one with the most work in flight, else the Manager office. */
export function hotIsland(depts) {
  let best = null;
  for (const d of depts || []) if (d.counts && d.counts.working > 0 && (!best || d.counts.working > best.counts.working)) best = d;
  return best ? best.slug : "manager-office";
}
/** A task's pill: a percent while it moves, a word when it is waiting or done. */
export function taskPill(t) {
  if (!t) return { text: "", cls: "" };
  if (t.status === "ready_to_test") return { text: "DONE", cls: "done" };
  if (t.status === "stopped") return { text: "WAIT", cls: "wait" };
  if (t.status === "cancelled") return { text: "OFF", cls: "off" };
  return { text: `${Math.max(0, Math.min(100, t.progress | 0))}%`, cls: t.status === "in_progress" ? "run" : "todo" };
}
/** "in 3h", "in 12m", "now": when a scheduled run is due. */
export function dueText(at, now = Date.now()) {
  const m = Math.round((at - now) / 60000);
  if (m <= 0) return "due now";
  if (m < 60) return `in ${m}m`;
  if (m < 48 * 60) return `in ${Math.round(m / 60)}h`;
  return `in ${Math.round(m / 1440)}d`;
}
/** A seeded scatter of node-graph points on the Brain's top face (the same every paint). */
export function brainNodes(n = 16, seed = 7) {
  let x = seed;
  const rnd = () => { x = (x * 16807) % 2147483647; return x / 2147483647; };
  const out = [];
  for (let i = 0; i < n; i++) { const u = rnd() * 1.6 - 0.8, w = rnd() * 1.6 - 0.8; if (Math.abs(u) + Math.abs(w) > 1.1) { i--; continue; } out.push({ x: Math.round((u - w) * BW * 0.62), y: Math.round((u + w) * BH * 0.62) }); }
  return out;
}

export function initStudio({ json, h, ago, app, els }) {
  if (!els || !els.section) return null;
  const st = { open: false, view: null, prev: null, filter: "all", room: "overview", dept: "", right: "tasks", timer: 0, clockTimer: 0, loading: false, error: "", meeting: null, log: [], logAt: 0, sendTo: "main", team: null, teamAt: 0, skills: null, skillsAt: 0, skillsError: "", apps: null, appsAt: 0, zoom: { k: 1, x: 0, y: 0 }, sig: "", building: false, liveTimer: 0, liveLoading: false };
  const S = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const k in attrs || {}) n.setAttribute(k, String(attrs[k])); return n; };
  const T = (x, y, cls, text, attrs) => { const t = S("text", { x, y, class: cls, ...(attrs || {}) }); t.textContent = text; return t; };
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const OFFICE_KEY = "daebot.studio.office";
  const readTheme = () => { try { return localStorage.getItem(OFFICE_KEY) === "light" ? "light" : "dark"; } catch { return "dark"; } };
  els.section.dataset.office = readTheme();

  // ---- the top bar: title, workspace, connected to, runs headless on, the clock; the rooms under it ----
  const top = h("header", "oc-top");
  const brand = h("div", "oc-brand");
  const logo = h("img", "oc-logo"); logo.src = "/brand/daebot-head.webp"; logo.alt = ""; logo.width = 26; logo.height = 26;
  const title = h("strong", "oc-title", "DAEBOT STUDIO");
  const ver = h("span", "oc-ver", "");
  const sep1 = h("span", "oc-sep", "·");
  const who = h("span", "oc-ws", "");
  brand.append(logo, title, ver, sep1, who);
  const conn = h("div", "oc-conn"); conn.append(h("i", "oc-live"), h("span", "oc-label", "CONNECTED TO"));
  const connIcons = h("div", "oc-icons"); conn.append(connIcons);
  const runs = h("div", "oc-runs"); runs.append(h("i", "oc-live"), h("span", "oc-label", "RUNS HEADLESS ON"));
  const chipModel = h("span", "oc-chip", ""); chipModel.title = "The model new turns run on, and the router's mode";
  const chipHost = h("span", "oc-chip", "");
  const chipNeeds = h("button", "oc-chip warn"); chipNeeds.type = "button"; chipNeeds.hidden = true; chipNeeds.title = "Open the task board to reply";
  chipNeeds.addEventListener("click", () => app.openBoard());
  const chipLive = h("button", "oc-chip live"); chipLive.type = "button"; chipLive.hidden = true; chipLive.title = "Helpers and loops working right now: open the Live room";
  chipLive.addEventListener("click", () => { st.room = "live"; paintRooms(); paintStage(); });
  runs.append(chipModel, chipHost, chipLive, chipNeeds);
  const clock = h("span", "oc-clock", ""); clock.setAttribute("aria-label", "Time");
  top.append(brand, conn, runs, clock);
  const bar = h("div", "oc-bar");
  const rooms = h("div", "oc-rooms"); rooms.setAttribute("role", "tablist"); rooms.setAttribute("aria-label", "Rooms");
  for (const [key, label] of ROOMS) {
    const b = h("button", "oc-room", label); b.type = "button"; b.dataset.key = key; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(key === st.room));
    b.addEventListener("click", () => { st.room = key; paintRooms(); paintStage(); });
    rooms.append(b);
  }
  const tools = h("div", "oc-tools");
  const rebuildBtn = h("button", "oc-tool", "Rebuild office"); rebuildBtn.type = "button"; rebuildBtn.title = "The Studio Builder plans your office again from your bots. Your own edits are kept.";
  rebuildBtn.addEventListener("click", rebuild);
  const themeBtn = h("button", "oc-tool icon"); themeBtn.type = "button";
  const paintThemeBtn = () => { const dark = els.section.dataset.office !== "light"; themeBtn.textContent = dark ? "☾" : "☀"; themeBtn.title = dark ? "Office lights on (light floor)" : "Office lights off (dark floor)"; themeBtn.setAttribute("aria-label", themeBtn.title); };
  themeBtn.addEventListener("click", () => { const next = els.section.dataset.office === "light" ? "dark" : "light"; els.section.dataset.office = next; try { localStorage.setItem(OFFICE_KEY, next); } catch { /* per-viewer only */ } paintThemeBtn(); });
  paintThemeBtn();
  tools.append(rebuildBtn, themeBtn);
  bar.append(rooms, tools);
  const note = h("p", "oc-note", ""); note.hidden = true; note.setAttribute("role", "status"); note.setAttribute("aria-live", "polite");
  const body = h("div", "oc-body");

  // ---- the stage: the floor (pan and zoom) or a room ----
  const stage = h("div", "oc-stage");
  const floor = h("div", "oc-floor");
  const world = h("div", "oc-world");
  const cardsLayer = h("div", "oc-cards-layer");
  const leaders = S("svg", { class: "oc-leaders", "aria-hidden": "true" });
  floor.append(world, leaders, cardsLayer);
  const hud = h("div", "oc-hud");
  const kpi = (label) => { const box = h("div", "oc-kpi"); const v = h("b", "", "–"); box.append(v, h("span", "", label)); hud.append(box); return v; };
  const kActive = kpi("ACTIVE"), kRunning = kpi("RUNNING"), kHelpers = kpi("HELPERS LIVE"), kDone = kpi("DONE TODAY"), kWaiting = kpi("WAITING ON YOU");
  const zoomBox = h("div", "oc-zoom");
  const zIn = h("button", "oc-zbtn", "+"), zOut = h("button", "oc-zbtn", "−"), zReset = h("button", "oc-zbtn", "⌂");
  zIn.type = zOut.type = zReset.type = "button";
  zIn.setAttribute("aria-label", "Zoom in"); zOut.setAttribute("aria-label", "Zoom out"); zReset.setAttribute("aria-label", "Reset the view");
  zIn.addEventListener("click", () => zoomBy(1.2)); zOut.addEventListener("click", () => zoomBy(1 / 1.2)); zReset.addEventListener("click", () => { st.zoom = { k: 1, x: 0, y: 0 }; fit(); });
  zoomBox.append(zIn, zOut, zReset);
  const roomBox = h("div", "oc-roombox");
  stage.append(floor, hud, zoomBox, roomBox);

  // ---- the right column: a new task, the filters, the cards (or the agent communication log) ----
  const aside = h("aside", "oc-col"); aside.setAttribute("aria-label", "Task status and agent communication");
  const taskBox = h("form", "oc-add"); taskBox.setAttribute("aria-label", "New task for the team");
  const taskArea = h("input", "oc-add-text"); taskArea.type = "text"; taskArea.placeholder = "Type a task for your team…"; taskArea.setAttribute("aria-label", "The task"); taskArea.maxLength = 4000;
  const taskRow = h("div", "oc-add-row");
  const taskDept = h("select", "oc-select"); taskDept.setAttribute("aria-label", "Department");
  const taskTo = h("select", "oc-select"); taskTo.setAttribute("aria-label", "Who gets it");
  const taskSend = h("button", "oc-add-btn", "ADD"); taskSend.type = "submit";
  taskRow.append(taskDept, taskTo, taskSend);
  const taskState = h("span", "oc-add-state", ""); taskState.setAttribute("role", "status");
  taskBox.append(taskArea, taskRow, taskState);
  taskDept.addEventListener("change", () => fillRecipients());
  taskBox.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = taskArea.value.trim();
    if (!text) { taskArea.focus(); return; }
    taskSend.disabled = true; taskState.textContent = "Sending…";
    try { await app.sendTo(taskTo.value || "main", text); taskArea.value = ""; taskState.textContent = ""; }
    catch (err) { taskState.textContent = (err && err.message) || "Could not send it."; }
    finally { taskSend.disabled = false; }
  });
  const colHead = h("div", "oc-col-head");
  const colTitle = h("strong", "oc-col-title", "TASK STATUS");
  const rightTabs = h("div", "oc-col-tabs"); rightTabs.setAttribute("role", "tablist");
  const tabTasks = h("button", "oc-col-tab", "Tasks"); tabTasks.type = "button"; tabTasks.setAttribute("role", "tab");
  const tabLog = h("button", "oc-col-tab", "Bot talk"); tabLog.type = "button"; tabLog.setAttribute("role", "tab");
  rightTabs.append(tabTasks, tabLog);
  colHead.append(colTitle, rightTabs);
  const filters = h("div", "oc-pills"); filters.setAttribute("role", "group"); filters.setAttribute("aria-label", "Filter tasks");
  const list = h("ul", "oc-cards");
  const logList = h("ul", "oc-cards oc-log"); logList.hidden = true;
  const pickRight = (k) => { st.right = k; colTitle.textContent = k === "log" ? "AGENT COMMUNICATION" : "TASK STATUS"; tabTasks.setAttribute("aria-selected", String(k === "tasks")); tabLog.setAttribute("aria-selected", String(k === "log")); filters.hidden = k !== "tasks"; list.hidden = k !== "tasks"; logList.hidden = k !== "log"; if (k === "log") void loadLog(true); };
  tabTasks.addEventListener("click", () => pickRight("tasks")); tabLog.addEventListener("click", () => pickRight("log"));
  aside.append(taskBox, colHead, filters, list, logList);
  body.append(stage, aside);
  els.section.replaceChildren(top, bar, note, body);
  pickRight("tasks");
  for (const [key, label] of PILLS) {
    const b = h("button", "oc-pill"); b.type = "button"; b.dataset.key = key; b.setAttribute("aria-pressed", String(key === st.filter));
    b.append(h("span", "", label), h("b", "", "0"));
    b.addEventListener("click", () => { st.filter = key; paintFilters(); paintTasks(); });
    filters.append(b);
  }
  function paintFilters() {
    const c = pillCounts(st.view);
    for (const b of filters.children) { b.setAttribute("aria-pressed", String(b.dataset.key === st.filter)); b.lastChild.textContent = String(c[b.dataset.key] ?? 0); }
  }
  function paintRooms() {
    const allowed = st.view && st.view.layout && st.view.layout.rooms && st.view.layout.rooms.length ? st.view.layout.rooms : ROOMS.map((r) => r[0]);
    for (const b of rooms.children) { b.hidden = !allowed.includes(b.dataset.key) && !ALWAYS_ROOMS.includes(b.dataset.key); b.setAttribute("aria-selected", String(b.dataset.key === st.room)); }
    const n = liveSummary(st.view && st.view.live);
    const liveTab = [...rooms.children].find((b) => b.dataset.key === "live");
    if (liveTab) { liveTab.classList.toggle("on-air", n.working + n.loops > 0); liveTab.textContent = n.working + n.loops > 0 ? `Live · ${n.working + n.loops}` : "Live"; }
  }
  const statusChip = (bot) => h("span", `st-status ${bot.status}`, STATUS[bot.status] || bot.status);

  // ---- pan and zoom (one transform on the world: the floor, the lines and the cards move together) ----
  let base = { s: 1, x: 0, y: 0 }, box = { x: 0, y: 0, w: 1000, h: 660, padTop: 150, padBottom: 24, padSide: 16 };
  function applyZoom() {
    const z = st.zoom, s = base.s * z.k, ox = base.x + z.x, oy = base.y + z.y;
    world.style.transform = `translate(${ox}px, ${oy}px) scale(${s})`;
    // The cards float in screen space: they follow the floor but keep a readable size at any zoom, and never collide (placeCards).
    const cs = Math.max(0.78, Math.min(1.08, s * 1.05));
    const sx = (wx) => ox + (wx - box.x) * s, sy = (wy) => oy + (wy - box.y) * s;
    const cards = [...cardsLayer.querySelectorAll(".oc-card")];
    const pill = cardsLayer.querySelector(".oc-brain-pill");
    const fixed = [];
    if (pill) {
      const pw = pill.offsetWidth * cs, ph = pill.offsetHeight * cs, px = sx(0) - pw / 2, py = sy(Number(pill.dataset.y));
      pill.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) scale(${cs.toFixed(3)})`;
      fixed.push({ x: px, y: py, w: pw, h: ph });
    }
    const items = cards.map((c) => {
      const x = Number(c.dataset.x), y = Number(c.dataset.y);
      return { id: c.dataset.dept, cx: sx(x), cy: sy(y), top: sy(y - IH), bottom: sy(y + IH + ID), left: sx(x - IW), right: sx(x + IW), w: c.offsetWidth * cs, h: c.offsetHeight * cs, side: y < -1 ? "above" : y > 1 ? "below" : x >= 0 ? "right" : "left", wx: x, wy: y };
    });
    const isles = items.map((it) => ({ id: it.id, x: it.left, y: it.top, w: it.right - it.left, h: it.bottom - it.top }));
    isles.push({ id: "brain", x: sx(-BW), y: sy(-BH), w: 2 * BW * s, h: (2 * BH + BD) * s });
    const fr = floor.getBoundingClientRect();
    // The HUD and the zoom buttons sit over the floor: no card goes under them.
    for (const el of [hud, zoomBox]) { if (el.hidden) continue; const r = el.getBoundingClientRect(); if (r.width) fixed.push({ x: r.left - fr.left, y: r.top - fr.top, w: r.width, h: r.height }); }
    const spots = placeCards(items, fixed, isles, { w: fr.width, h: fr.height });
    // A dotted leader from each card to its island, so a card that had to move still points home.
    leaders.replaceChildren();
    for (const c of cards) {
      const p = spots[c.dataset.dept];
      if (!p) continue;
      const it = items.find((x) => x.id === c.dataset.dept);
      c.dataset.side = p.side;
      c.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) scale(${cs.toFixed(3)})`;
      const cw = it.w, ch = it.h;
      const from = p.side === "above" ? { x: p.x + cw / 2, y: p.y + ch } : p.side === "below" ? { x: p.x + cw / 2, y: p.y } : p.side === "right" ? { x: p.x, y: p.y + ch / 2 } : { x: p.x + cw, y: p.y + ch / 2 };
      const to = p.side === "above" ? { x: it.cx, y: it.top + 6 } : p.side === "below" ? { x: it.cx, y: it.bottom - 6 } : p.side === "right" ? { x: it.right - 8, y: it.cy } : { x: it.left + 8, y: it.cy };
      leaders.append(S("line", { class: "oc-leader", x1: from.x.toFixed(1), y1: from.y.toFixed(1), x2: to.x.toFixed(1), y2: to.y.toFixed(1) }));
      const dot = S("circle", { class: "oc-leader-dot", cx: to.x.toFixed(1), cy: to.y.toFixed(1), r: 3.6 }); dot.style.fill = getComputedStyle(c).getPropertyValue("--isl"); leaders.append(dot);
    }
  }
  function fit() {
    const r = floor.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const top = box.padTop + 8, bottom = box.padBottom + 8, availH = Math.max(120, r.height - top - bottom);
    const availW = Math.max(160, r.width - 2 * box.padSide);
    const s = Math.min(availW / box.w, availH / box.h, 1.3);
    base = { s, x: (r.width - box.w * s) / 2, y: top + (availH - box.h * s) / 2 };
    applyZoom();
  }
  function zoomBy(f, cx, cy) {
    const r = floor.getBoundingClientRect();
    const px = cx ?? r.width / 2, py = cy ?? r.height / 2;
    const z = st.zoom, k2 = Math.max(0.5, Math.min(4, z.k * f)), real = k2 / z.k;
    const ox = base.x + z.x, oy = base.y + z.y;
    st.zoom = { k: k2, x: px - (px - ox) * real - base.x, y: py - (py - oy) * real - base.y };
    applyZoom();
  }
  floor.addEventListener("wheel", (e) => { e.preventDefault(); const r = floor.getBoundingClientRect(); zoomBy(Math.exp(-e.deltaY * 0.0016), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  let drag = null;
  floor.addEventListener("pointerdown", (e) => { if (e.button !== 0 || e.target.closest(".oc-card, .oc-desk, button")) return; drag = { x: e.clientX, y: e.clientY, zx: st.zoom.x, zy: st.zoom.y, id: e.pointerId }; floor.setPointerCapture(e.pointerId); floor.classList.add("dragging"); });
  floor.addEventListener("pointermove", (e) => { if (!drag) return; st.zoom.x = drag.zx + e.clientX - drag.x; st.zoom.y = drag.zy + e.clientY - drag.y; applyZoom(); });
  const endDrag = () => { if (!drag) return; try { floor.releasePointerCapture(drag.id); } catch { /* gone */ } drag = null; floor.classList.remove("dragging"); };
  floor.addEventListener("pointerup", endDrag); floor.addEventListener("pointercancel", endDrag);
  if (typeof ResizeObserver === "function") new ResizeObserver(() => fit()).observe(floor);

  // ---- drawing ----
  function slab(g, w, hh, d, top, left, right, cls) {
    g.append(S("polygon", { class: `${cls}-l`, points: `${-w},0 0,${hh} 0,${hh + d} ${-w},${d}`, fill: left }));
    g.append(S("polygon", { class: `${cls}-r`, points: `0,${hh} ${w},0 ${w},${d} 0,${hh + d}`, fill: right }));
    g.append(S("polygon", { class: `${cls}-t`, points: `0,${-hh} ${w},0 0,${hh} ${-w},0`, fill: top }));
  }
  function desk(bot, x, y, s) {
    const g = S("g", { class: `oc-desk ${bot.status}`, transform: `translate(${x} ${y}) scale(${s})`, tabindex: "0", role: "button" });
    const label = `${bot.name}: ${STATUS[bot.status] || bot.status}${bot.task ? `, ${bot.task.title}` : ""}`;
    g.setAttribute("aria-label", label);
    const tip = S("title"); tip.textContent = label; g.append(tip);
    const c = safeColor(bot.color);
    g.append(S("ellipse", { class: "oc-desk-shadow", cx: 0, cy: 12, rx: 24, ry: 9 }));
    // the desk: a small slab
    g.append(S("polygon", { class: "oc-dk-l", points: "-20,0 0,10 0,16 -20,6" }));
    g.append(S("polygon", { class: "oc-dk-r", points: "0,10 20,0 20,6 0,16" }));
    g.append(S("polygon", { class: "oc-dk-t", points: "0,-10 20,0 0,10 -20,0" }));
    // the monitor at the back edge, its screen lit by the bot's state
    g.append(S("polygon", { class: "oc-mon", points: "-12,-6 6,-15 6,-29 -12,-20" }));
    g.append(S("polygon", { class: "oc-scr", points: "-10.5,-7.6 4.6,-15.2 4.6,-27.4 -10.5,-19.8" }));
    g.append(S("line", { class: "oc-stand", x1: -3, y1: -10.5, x2: -3, y2: -5 }));
    // the worker: body and head in the bot's colour, seated at the front edge
    const w = S("g", { class: "oc-worker", transform: "translate(7 3)" });
    const body = S("path", { class: "oc-torso", d: "M-6,6 Q-6,-4 0,-4 Q6,-4 6,6 Z" }); body.style.fill = c;
    const head = S("circle", { class: "oc-head", cx: 0, cy: -9, r: 4.6 }); head.style.fill = c;
    w.append(body, head);
    g.append(w);
    if (bot.needs > 0) { const b = S("g", { class: "oc-need", transform: "translate(10 -38)" }); b.append(S("circle", { r: 7 })); b.append(T(0, 3.6, "oc-need-mark", "!", { "text-anchor": "middle" })); g.append(b); }
    const open = () => { if (bot.task && bot.task.sessionId) app.openSession(bot.task.sessionId); else app.pickBot(bot.id); };
    g.addEventListener("click", open);
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    return g;
  }
  function nameTag(name, x, y, scale, room) {
    const t = tagText(name, scale, room);
    const g = S("g", { class: "oc-tag", transform: `translate(${x} ${y})`, "aria-hidden": "true" });
    g.append(S("rect", { x: -t.w / 2, y: -t.f * 0.82, width: t.w, height: t.f * 1.5, rx: t.f * 0.75 }));
    g.append(T(0, t.f * 0.32, "oc-tag-text", t.text, { "text-anchor": "middle", "font-size": t.f.toFixed(1) }));
    return g;
  }
  function islandG(d, bots) {
    const p = iso(d.u, d.v), pal = palOf(d.palette);
    const g = S("g", { class: "oc-island", transform: `translate(${p.x} ${p.y})`, "data-dept": d.slug });
    g.append(S("ellipse", { class: "oc-shadow", cx: 0, cy: ID + 14, rx: IW * 0.95, ry: IH * 0.75 }));
    slab(g, IW, IH, ID, pal[0], pal[1], pal[2], "oc-is");
    // the floor grid and a rim on the top face
    const grid = S("g", { class: "oc-grid" });
    for (let i = 1; i < 6; i++) { const f = i / 6; grid.append(S("line", { x1: -IW + IW * f, y1: -IH * f, x2: IW * f, y2: IH - IH * f })); grid.append(S("line", { x1: IW * f, y1: -IH + IH * f, x2: -IW + IW * f, y2: IH * f })); }
    g.append(grid);
    g.append(S("polygon", { class: "oc-rim", points: `0,${-IH + 5} ${IW - 10},0 0,${IH - 5} ${-IW + 10},0` }));
    const { slots, scale, room } = deskGrid(bots.length);
    const order = bots.map((b, i) => ({ b, s: slots[i] })).sort((a, z) => a.s.y - z.s.y);
    for (const { b, s } of order) g.append(desk(b, s.x, s.y + 4, scale));
    // Every desk has its name tag, on a layer above all desks (a desk in front never hides a name), sized to the room between desks.
    const tags = S("g", { class: "oc-tags" });
    for (const { b, s } of order) tags.append(nameTag(b.name, s.x, s.y + 4 + 22 * scale, scale, room));
    g.append(tags);
    if (!bots.length) g.append(T(0, 5, "oc-empty-isl", "no desks yet", { "text-anchor": "middle" }));
    g.addEventListener("dblclick", () => { st.dept = d.slug; st.room = "workspaces"; paintRooms(); paintStage(); });
    return g;
  }
  function brainG(v) {
    const g = S("g", { class: "oc-brain" });
    g.append(S("ellipse", { class: "oc-shadow", cx: 0, cy: BD + 16, rx: BW, ry: BH * 0.8 }));
    slab(g, BW, BH, BD, "var(--o-brain-t)", "var(--o-brain-l)", "var(--o-brain-r)", "oc-br");
    const nodes = brainNodes(18);
    const net = S("g", { class: "oc-net" });
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) { const a = nodes[i], b = nodes[j]; if (Math.hypot(a.x - b.x, (a.y - b.y) * 2) < 62) net.append(S("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y })); }
    nodes.forEach((n, i) => net.append(S("circle", { cx: n.x, cy: n.y, r: i % 5 === 0 ? 3.2 : 2, class: i % 5 === 0 ? "hub" : "" })));
    g.append(net);
    const t = S("title"); t.textContent = `The Brain: your MIND. ${v.brain.inMind} tasks filed, ${v.brain.decisions} decisions, ${v.brain.sessions} sessions in the last two weeks.`; g.append(t);
    return g;
  }
  /** The floor's line layer: walkways from the Brain to every island, dotted lines to the cards, bot_talk arcs with walking dots. */
  function linesG(v, pos) {
    const g = S("g", { class: "oc-lines" });
    for (const d of v.departments) { const p = pos.get(d.slug); g.append(S("line", { class: "oc-walk", x1: 0, y1: 0, x2: p.x, y2: p.y })); }
    for (const d of v.departments) { const p = pos.get(d.slug); g.append(S("line", { class: "oc-walk-mid", x1: 0, y1: 0, x2: p.x, y2: p.y })); }
    return g;
  }
  function wiresG(v, pos) {
    const g = S("g", { class: "oc-wires" });
    for (const d of v.departments) { const p = pos.get(d.slug); if (p.y > 0) g.append(S("path", { class: "oc-wire", d: `M0,${BH + BD} Q${p.x * 0.5},${p.y + IH} ${p.x},${p.y + IH + ID}` })); else g.append(S("path", { class: "oc-wire", d: `M0,${-BH - 30} Q${p.x * 0.5},${Math.min(p.y, 0) - 120} ${p.x},${p.y - IH}` })); }
    let dots = 0;
    const bots = new Map(v.bots.map((b) => [b.id, b]));
    for (const l of v.links) {
      if (l.a === l.b) continue;
      const a = pos.get(l.a), b = pos.get(l.b);
      if (!a || !b) continue;
      const mx = (a.x + b.x) / 2, my = Math.min(a.y, b.y) - 90 - Math.abs(a.x - b.x) * 0.12;
      const d = `M${a.x},${a.y - IH - 6} Q${mx},${my} ${b.x},${b.y - IH - 6}`;
      const path = S("path", { class: "oc-talk", d, "stroke-width": Math.min(3, 1.2 + Math.log2(1 + l.count) * 0.4) });
      const tt = S("title"); tt.textContent = `${l.count} bot_talk ${l.count === 1 ? "message" : "messages"}, last ${ago(l.at)}`; path.append(tt);
      g.append(path);
      if (reduced() || dots >= 24) continue;
      const dept = v.departments.find((x) => x.slug === l.a);
      const color = dept ? palOf(dept.palette)[3] : "#ffd25a";
      const len = Math.hypot(b.x - a.x, b.y - a.y) + 120;
      const n = Math.min(3, 1 + Math.floor(Math.log2(1 + l.count)));
      for (let i = 0; i < n && dots < 24; i++, dots++) {
        const dot = S("circle", { class: "oc-dot", r: 4.2 }); dot.style.fill = color;
        const dur = Math.max(2.6, len / 95);
        const mv = S("animateMotion", { dur: `${dur.toFixed(1)}s`, repeatCount: "indefinite", path: d, begin: `${(-(dur * i) / n).toFixed(2)}s`, keyPoints: i % 2 ? "1;0" : "0;1", keyTimes: "0;1", calcMode: "linear" });
        dot.append(mv); g.append(dot);
      }
      void bots;
    }
    return g;
  }
  function card(d, v, p, hot) {
    const pal = palOf(d.palette);
    const c = h("div", `oc-card${hot ? " hot" : ""}`);
    // Where the card goes is decided at every pan and zoom by placeCards (far side of the island from the Brain, never on another card).
    c.dataset.x = String(p.x); c.dataset.y = String(p.y); c.dataset.dept = d.slug;
    c.style.setProperty("--isl", pal[3]);
    const head = h("div", "oc-card-head");
    const dot = h("i", `oc-sdot ${d.counts.working ? "on" : d.needsYou ? "warn" : ""}`);
    head.append(dot, h("span", "oc-card-name", d.name.toUpperCase()));
    const agents = h("div", "oc-agents"); agents.append(h("b", "", String(d.bots.length)), h("span", "", d.bots.length === 1 ? "AGENT" : "AGENTS"));
    const stats = h("div", "oc-stats");
    for (const s of d.stats || []) { const row = h("div", "oc-stat"); row.append(h("span", "", s.label.toUpperCase()), h("b", "", fmtNum(s.value))); stats.append(row); }
    const flow = h("div", "oc-flow");
    for (const [k, n] of [["DOING", d.counts.working], ["NEXT", d.counts.next], ["DONE", d.counts.done]]) { const x = h("span", ""); x.append(document.createTextNode(`${k} `), h("b", "", String(n))); flow.append(x); }
    c.append(head, agents, stats, flow);
    if (d.pipeline) c.append(h("div", "oc-pipe", `STAGE ${d.pipeline.stage}/${d.pipeline.of} ${stageMarks(d.pipeline.marks)}`));
    if (d.needsYou > 0) {
      const wb = h("button", "oc-wait"); wb.type = "button";
      wb.append(h("i", "oc-wait-mark", "▲"), document.createTextNode(` ${badgeText(d.needsYou).toUpperCase()}`));
      wb.setAttribute("aria-label", `${d.name}: ${badgeText(d.needsYou)}. Open the task board to reply.`);
      wb.addEventListener("click", () => app.openBoard());
      c.append(wb);
    }
    c.title = `${d.name}: double-click the island to open its workspace`;
    c.addEventListener("dblclick", () => { st.dept = d.slug; st.room = "workspaces"; paintRooms(); paintStage(); });
    return c;
  }
  function paintFloor(v) {
    box = worldBounds(v.departments);
    world.replaceChildren();
    world.style.width = `${box.w}px`; world.style.height = `${box.h}px`;
    const svg = S("svg", { viewBox: `${box.x} ${box.y} ${box.w} ${box.h}`, width: box.w, height: box.h, class: "oc-svg", role: "img", "aria-label": `${v.name}'s office: ${v.departments.length} islands around the Brain` });
    const pos = new Map(v.departments.map((d) => [d.slug, iso(d.u, d.v)]));
    const bots = new Map(v.bots.map((b) => [b.id, b]));
    svg.append(linesG(v, pos));
    // Back to front: islands behind the Brain, the Brain, then the rest.
    const order = [...v.departments].sort((a, b) => pos.get(a.slug).y - pos.get(b.slug).y);
    for (const d of order) if (pos.get(d.slug).y < 0) svg.append(islandG(d, d.bots.map((id) => bots.get(id)).filter(Boolean)));
    svg.append(brainG(v));
    for (const d of order) if (pos.get(d.slug).y >= 0) svg.append(islandG(d, d.bots.map((id) => bots.get(id)).filter(Boolean)));
    svg.append(wiresG(v, pos));
    world.append(svg);
    const cards = document.createDocumentFragment();
    const hot = hotIsland(v.departments);
    for (const d of v.departments) cards.append(card(d, v, pos.get(d.slug), d.slug === hot));
    const pill = h("div", "oc-brain-pill");
    pill.dataset.x = "0"; pill.dataset.y = String(BH + BD + 12); // under the Brain's front edge: the one spot no island or desk tag reaches
    const mark = h("img", "oc-mind"); mark.src = "/brand/mind-flame.png"; mark.alt = ""; mark.width = 14; mark.height = 14;
    pill.append(mark, h("span", "", "THE BRAIN"), h("b", "", String(v.brain.inMind)), h("span", "dim", v.brain.inMind === 1 ? "FILED" : "FILED"), h("b", "", String(v.brain.sessions)), h("span", "dim", "SESSIONS"));
    cards.append(pill);
    cardsLayer.replaceChildren(...cards.childNodes);
    fit();
  }
  function islandSolo(d, v) {
    const bots = new Map(v.bots.map((b) => [b.id, b]));
    const svg = S("svg", { viewBox: `${-IW - 20} ${-IH - 60} ${2 * IW + 40} ${2 * IH + ID + 90}`, class: "oc-svg oc-solo", role: "img", "aria-label": `The ${d.name} island` });
    const g = islandG({ ...d, u: 0, v: 0 }, d.bots.map((id) => bots.get(id)).filter(Boolean));
    svg.append(g);
    return svg;
  }

  async function rebuild() {
    if (st.building) return;
    st.building = true; rebuildBtn.disabled = true; rebuildBtn.textContent = "Rebuilding…";
    try {
      const r = await json("/studio/rebuild", { method: "POST", body: "{}" });
      note.textContent = r && r.note ? r.note : `Office rebuilt: ${r && r.islands} islands.`; note.hidden = false;
      st.sig = ""; await load();
    } catch (e) { note.textContent = `Could not rebuild the office: ${(e && e.message) || "error"}`; note.hidden = false; }
    finally { st.building = false; rebuildBtn.disabled = false; rebuildBtn.textContent = "Rebuild office"; }
  }
  async function loadApps() {
    if (st.apps && Date.now() - st.appsAt < 5 * 60_000) return;
    st.appsAt = Date.now();
    try { const r = await json("/apps/integrations"); st.apps = (Array.isArray(r && r.providers) ? r.providers : []).filter((p) => p && p.connected).map((p) => ({ key: String(p.provider || ""), name: String(p.name || p.provider || "") })); }
    catch { st.apps = []; }
    paintTop();
  }
  // ---- rooms ----
  function botCard(bot, v) {
    const card = h("div", `st-botcard ${bot.status}`);
    card.style.setProperty("--bot", safeColor(bot.color));
    const head = h("div", "st-botcard-head");
    const face = faceSvg(bot.face);
    const av = h("span", "st-botcard-face"); av.style.color = safeColor(bot.color);
    if (face) av.append(face); else av.textContent = (bot.name || "?").slice(0, 1).toUpperCase();
    const nm = h("div", "st-botcard-name"); nm.append(h("strong", "", bot.name), statusChip(bot));
    head.append(av, nm);
    card.append(head);
    if (bot.purpose) card.append(h("p", "st-botcard-purpose", bot.purpose));
    if (bot.counters && bot.counters.length) card.append(h("p", "st-botcard-counters", countersLine(bot.counters)));
    if (bot.task) { const t = h("button", "st-botcard-task"); t.type = "button"; t.append(h("i", `st-dot ${LIGHT[bot.task.status] || "red"}`), h("span", "", bot.task.title)); t.addEventListener("click", () => app.openSession(bot.task.sessionId)); card.append(t); }
    else { const b = h("button", "st-botcard-task quiet", bot.id === "main" ? "Open a new session" : "Open a thread"); b.type = "button"; b.addEventListener("click", () => app.pickBot(bot.id)); card.append(b); }
    const dept = v.departments.find((d) => d.bots.includes(bot.id));
    const meta = h("div", "st-botcard-meta"); meta.append(h("span", "", dept ? dept.name : "General"), h("span", "sep", "·"), h("span", "", `${bot.sessions} ${bot.sessions === 1 ? "session" : "sessions"}`), h("span", "sep", "·"), h("span", "", bot.lastSeen ? ago(bot.lastSeen) : "never"));
    card.append(meta);
    return card;
  }

  function roomOffice(v) {
    const wrap = h("div", "st-room-wrap");
    const dae = v.bots.find((b) => b.id === "main");
    if (!dae) return wrap;
    const office = v.departments.find((d) => d.slug === "manager-office");
    const left = h("div", "st-room-col");
    if (office) left.append(islandSolo(office, v));
    left.append(botCard(dae, v));
    const proofBox = h("div", "st-proof"); proofBox.append(h("h3", "st-h", "Last turn"));
    const chipsRow = h("div", "st-proof-chips");
    const pc = proofChips(dae.proof);
    if (!pc.length) chipsRow.append(h("span", "st-muted", "No turn yet."));
    for (const c of pc) { const s = h("span", `bd-chip ${c.cls || ""}`.trim(), c.text); if (c.title) s.title = c.title; chipsRow.append(s); }
    proofBox.append(chipsRow); left.append(proofBox);
    const mine = v.tasks.filter((t) => t.bot === "main");
    left.append(h("h3", "st-h", `${dae.name}'s tasks`), taskList(mine, v, "Nothing on the board for the main Daebot."));
    const right = h("div", "st-room-col");
    right.append(h("h3", "st-h", "Project progress"));
    if (!v.projects.length) right.append(h("p", "st-muted", "No project yet. Tasks filed to a MIND project show their progress here."));
    for (const p of v.projects) {
      const row = h("div", "st-proj");
      const head = h("div", "st-proj-head"); head.append(h("span", "st-proj-name", p.name), h("span", "st-proj-pct", `${progressPct(p)}%`));
      const bar = h("div", "st-proj-bar"); bar.setAttribute("role", "progressbar"); bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", "100"); bar.setAttribute("aria-valuenow", String(progressPct(p))); bar.setAttribute("aria-label", `${p.name} progress`);
      const fill = h("i", ""); fill.style.width = `${progressPct(p)}%`; bar.append(fill);
      row.append(head, bar, h("div", "st-proj-meta", `${p.done} done · ${p.working} working · ${p.next} next${p.waiting ? ` · ${p.waiting} waiting on you` : ""}`));
      right.append(row);
    }
    right.append(h("h3", "st-h", "Agent activity"));
    const act = h("ul", "st-activity");
    for (const b of v.bots) {
      const li = h("li", `st-act ${b.status}`);
      const btn = h("button", "st-act-btn"); btn.type = "button";
      const av = h("span", "st-act-face"); av.style.color = safeColor(b.color); const f = faceSvg(b.face); if (f) av.append(f); else av.textContent = (b.name || "?").slice(0, 1).toUpperCase();
      const txt = h("div", "st-act-text"); const nm = h("div", "st-act-name"); nm.append(h("strong", "", b.name), statusChip(b)); txt.append(nm);
      txt.append(h("div", "st-act-task", b.task ? b.task.title : b.status === "idle" ? loungeLine(b.id, new Date().getHours()) : "working"));
      btn.append(av, txt);
      btn.addEventListener("click", () => { if (b.task) app.openSession(b.task.sessionId); else app.pickBot(b.id); });
      li.append(btn); act.append(li);
    }
    right.append(act);
    right.append(h("h3", "st-h", "Ideas for the team"));
    const ex = h("div", "st-examples");
    for (const e of EXAMPLES) { const b = h("button", "st-example", e); b.type = "button"; b.addEventListener("click", () => { taskArea.value = e; taskArea.focus(); }); ex.append(b); }
    right.append(ex);
    wrap.append(left, right);
    return wrap;
  }

  function roomMeeting(v) {
    const wrap = h("div", "st-room-wrap col");
    if (!v.meetings.length) { wrap.append(h("p", "st-muted", "No bot has talked to another yet. When Dae hands work to a bot with bot_talk, the exchange shows here.")); return wrap; }
    const ul = h("ul", "st-meetings");
    for (const m of v.meetings) {
      const li = h("li", "st-meeting");
      const btn = h("button", "st-meeting-btn"); btn.type = "button"; btn.setAttribute("aria-expanded", String(st.meeting === m.id));
      btn.append(h("strong", "", `${m.aName} ↔ ${m.bName}`), h("span", "st-muted", ` · ${m.count} ${m.count === 1 ? "message" : "messages"} · ${ago(m.updatedAt)}`));
      if (m.last) btn.append(h("div", "st-meeting-last", `${m.last.fromName}: ${m.last.text}`));
      btn.addEventListener("click", () => { st.meeting = st.meeting === m.id ? null : m.id; paintStage(); });
      li.append(btn);
      if (st.meeting === m.id) { const tr = h("div", "st-transcript", "Loading…"); li.append(tr); void loadTranscript(m.id, tr); }
      ul.append(li);
    }
    wrap.append(ul);
    return wrap;
  }

  async function loadTranscript(id, box) {
    try {
      const ex = (await json(`/exchanges/${encodeURIComponent(id)}`)).exchange;
      box.replaceChildren();
      const log = mergeLog([ex], 500).reverse();
      if (!log.length) box.append(h("p", "st-muted", "Empty exchange."));
      for (const m of log) { const p = h("div", `st-tr-msg ${m.kind}`); const w = h("strong", "", `${m.from} → ${m.to}`); w.style.color = safeColor(m.fromColor); p.append(w, h("span", "st-muted", ` ${ago(m.at)}`), h("p", "", m.text)); box.append(p); }
      box.append(h("p", "st-muted", "Read-only. Bots talk to each other here; you reply on the task board when they need you."));
    } catch (e) { box.textContent = `Could not load the exchange: ${(e && e.message) || "error"}`; }
  }

  function roomLounge(v) {
    const wrap = h("div", "st-room-wrap col");
    const idle = v.bots.filter((b) => b.status === "idle");
    if (!idle.length) { wrap.append(h("p", "st-muted", "Nobody is in the lounge: every bot is working or waiting on you.")); return wrap; }
    const hour = new Date().getHours();
    const grid = h("div", "st-grid");
    for (const b of idle) { const c = botCard(b, v); c.append(h("p", "st-lounge-line", `${b.name} is ${loungeLine(b.id, hour)}.`)); grid.append(c); }
    wrap.append(grid);
    return wrap;
  }

  function roomWorkspaces(v) {
    const wrap = h("div", "st-room-wrap col");
    const picker = h("div", "st-filters"); picker.setAttribute("role", "tablist"); picker.setAttribute("aria-label", "Departments");
    if (!v.departments.some((d) => d.slug === st.dept)) st.dept = (v.departments[0] || {}).slug || "";
    for (const d of v.departments) { const b = h("button", "st-filter", d.name); b.type = "button"; b.setAttribute("aria-pressed", String(d.slug === st.dept)); b.addEventListener("click", () => { st.dept = d.slug; paintStage(); }); picker.append(b); }
    wrap.append(picker);
    const d = v.departments.find((x) => x.slug === st.dept);
    if (!d) return wrap;
    const row = h("div", "st-room-wrap");
    row.append(islandSolo(d, v));
    const col = h("div", "st-room-col");
    col.append(h("h3", "st-h", `${d.name}: ${d.bots.length} ${d.bots.length === 1 ? "bot" : "bots"}, done ${d.counts.done}, working ${d.counts.working}, next ${d.counts.next}, waiting ${d.counts.waiting}`));
    col.append(taskList(v.tasks.filter((t) => t.department === d.slug), v, "No tasks on this island yet."));
    const lead = v.bots.find((b) => b.id === d.lead);
    if (lead) { const b = h("button", "btn-quiet st-task-for", `Type a task for ${d.name} (goes to ${lead.name})`); b.type = "button"; b.addEventListener("click", () => { taskDept.value = d.slug; fillRecipients(); taskTo.value = lead.id; taskArea.focus(); }); col.append(b); }
    row.append(col);
    wrap.append(row);
    return wrap;
  }

  // ---- the token team room ----
  async function loadTeam() {
    const sid = app.currentId ? app.currentId() : "";
    try { st.team = await json(`/studio/team${sid ? `?session=${encodeURIComponent(sid)}` : ""}`); st.teamAt = Date.now(); }
    catch (e) { st.team = { error: (e && e.message) || "Could not load the token team." }; }
    if (st.room === "team") paintStage();
  }
  function teamGraph(t) {
    const svg = S("svg", { viewBox: "0 0 600 300", class: "st-svg st-svg-small", role: "img", "aria-label": "The token team: tiers and their share of today's turns" });
    const shares = teamShares(t.today);
    const tiers = t.tiers || [];
    const center = { x: 300, y: 150 };
    const n = Math.max(1, tiers.length);
    tiers.forEach((tier, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
      const x = Math.round(center.x + 200 * Math.cos(a)), y = Math.round(center.y + 105 * Math.sin(a));
      const s = shares.find((z) => z.tier === tier.tier);
      const w = s ? Math.min(6, 1 + Math.log2(1 + s.turns)) : 0.6;
      const ln = S("line", { class: `st-tt-edge ${s ? "live" : ""}`, x1: center.x, y1: center.y, x2: x, y2: y, "stroke-width": w });
      const tt = S("title"); tt.textContent = s ? `${s.turns} turns today, ${fmtUsd(s.costUsd)}` : "no turns today"; ln.append(tt);
      svg.append(ln);
      const g = S("g", { class: `st-tt-node ${tier.tier} ${s ? "live" : ""}`, transform: `translate(${x} ${y})` });
      g.append(S("circle", { r: s ? 22 + Math.min(14, s.share / 5) : 18 }));
      g.append(T(0, -3, "st-tt-name", tier.tier, { "text-anchor": "middle" }));
      g.append(T(0, 10, "st-tt-role", TIER_ROLES[tier.tier] || "", { "text-anchor": "middle" }));
      g.append(T(0, 44, "st-tt-share", s ? `${s.share}% · ${s.turns} turn${s.turns === 1 ? "" : "s"}` : "idle", { "text-anchor": "middle" }));
      const nt = S("title"); nt.textContent = `${tier.tier}: ${tier.model}. ${tier.use}`; g.append(nt);
      svg.append(g);
    });
    const c = S("g", { class: "st-tt-center", transform: `translate(${center.x} ${center.y})` });
    c.append(S("circle", { r: 30 }));
    c.append(T(0, -2, "st-tt-name", "Dae", { "text-anchor": "middle" }));
    c.append(T(0, 11, "st-tt-role", t.mode === "off" ? "router off" : `router ${t.mode}`, { "text-anchor": "middle" }));
    svg.append(c);
    return svg;
  }
  function roomTeam(v) {
    const wrap = h("div", "st-room-wrap col");
    const t = st.team;
    if (!t) { wrap.append(h("p", "st-muted", "Loading the token team…")); void loadTeam(); return wrap; }
    if (t.error) { wrap.append(h("p", "st-muted", `Could not load the token team: ${t.error}`)); return wrap; }
    const grid = h("div", "st-room-wrap");
    const left = h("div", "st-room-col");
    left.append(teamGraph(t));
    const bill = h("div", "st-bill");
    const line = (label, s) => { const row = h("div", "st-bill-row"); row.append(h("span", "st-bill-label", label), h("strong", "", savingText(s))); return row; };
    if (t.session) bill.append(line("This session", t.session));
    bill.append(line("Today", t.today), line("All time", t.all));
    const cap = h("div", "st-bill-row"); cap.append(h("span", "st-bill-label", "Frontier today"), h("strong", "", `${fmtUsd(t.frontierSpentUsd)} of ${fmtUsd(t.frontierCapUsd)} cap`)); bill.append(cap);
    left.append(bill);
    const cards = h("div", "st-tiers");
    for (const s of teamShares(t.all)) {
      const c = h("div", `st-tier ${s.tier}`);
      c.append(h("div", "st-tier-head", `${s.tier} · ${TIER_ROLES[s.tier] || ""}`));
      c.append(h("div", "st-tier-line", `${s.turns} turn${s.turns === 1 ? "" : "s"} · ${fmtUsd(s.costUsd)} · in ${fmtTok(s.tokensIn)} · out ${fmtTok(s.tokensOut)}`));
      c.append(h("div", "st-tier-line", `verified ${s.turns ? Math.round((100 * s.verified) / s.turns) : 0}%`));
      cards.append(c);
    }
    if (!cards.children.length) cards.append(h("p", "st-muted", "No routed turns in the log yet. Turns are logged once the router has a decision for them."));
    left.append(h("h3", "st-h", "All time, by tier"), cards);
    const right = h("div", "st-room-col");
    right.append(h("h3", "st-h", "Rules in play"));
    const ul = h("ul", "st-rules");
    for (const r of t.protocol || []) ul.append(h("li", "", r));
    right.append(ul);
    right.append(h("h3", "st-h", "Flags"));
    const flags = h("ul", "st-rules");
    flags.append(h("li", "", `Router: ${t.mode} (${t.mode === "enforce" ? "the router picks the model" : t.mode === "shadow" ? "decisions are logged, the configured model runs" : "off"})`));
    flags.append(h("li", "", `Consult before done: ${t.consultBeforeDone ? "on" : "off (DAEBOT_CONSULT_BEFORE_DONE=1 turns it on)"}`));
    right.append(flags);
    right.append(h("h3", "st-h", "Guard rules"));
    const gl = h("ul", "st-rules");
    if (!(t.guards || []).length) gl.append(h("li", "st-muted", "No guard rules. Settings → Guards adds standing allow or deny rules per tool."));
    for (const g of t.guards || []) gl.append(h("li", "", `${g.effect} ${g.tool}${g.scope ? ` (${g.scope})` : ""}`));
    right.append(gl);
    grid.append(left, right);
    wrap.append(grid);
    return wrap;
  }

  // ---- the pipelines room ----
  async function loadSkills() {
    try { st.skills = (await json("/studio/skills")).skills || []; } catch (e) { st.skills = []; st.skillsError = (e && e.message) || "error"; }
    st.skillsAt = Date.now();
    if (st.room === "pipelines") paintStage();
  }
  function roomPipelines(v) {
    const wrap = h("div", "st-room-wrap col");
    const intro = h("p", "st-muted", "A department runs a staged pipeline: each stage names the skill that runs it and the bot that owns it. Ask Dae: \"set up a pipeline for Design with the stages style, design, system, build, review\" (the studio_pipeline tool), and the island shows where it stands.");
    wrap.append(intro);
    if (!v.pipelines.length) wrap.append(h("p", "st-muted", "No pipeline yet."));
    for (const p of v.pipelines) {
      const dept = v.departments.find((d) => d.slug === p.department);
      const box = h("div", "st-pipe");
      const head = h("div", "st-pipe-head");
      head.append(h("strong", "", dept ? dept.name : p.department), h("span", "st-muted", ` · stage ${p.stage} of ${p.of} · ${p.done} done · ${ago(p.updatedAt)}`), h("span", `st-marks-text ${p.status}`, stageMarks(p.marks)));
      box.append(head);
      const stages = h("ol", "st-stages");
      p.stages.forEach((s, i) => {
        const li = h("li", `st-stage ${s.status}`);
        li.append(h("span", "st-stage-mark", STAGE_MARK[s.status] || "○"), h("strong", "", `${i + 1} ${s.name}`));
        const meta = [];
        if (s.skill) meta.push(`skill ${s.skill}`);
        if (s.bot) meta.push(`→ ${s.bot}`);
        meta.push(s.status);
        if (s.note) meta.push(s.note);
        li.append(h("span", "st-muted", ` · ${meta.join(" · ")}`));
        stages.append(li);
      });
      box.append(stages);
      const log = h("ul", "st-exec");
      for (const e of [...p.log].reverse()) log.append(h("li", `st-exec-row ${e.status}`, `${ago(e.at)} · ${e.stage} · ${e.status} · by ${e.by}${e.skill ? ` · ${e.skill}` : ""}${e.note ? ` · ${e.note}` : ""}`));
      if (p.log.length) { box.append(h("h3", "st-h", "Exec log"), log); }
      wrap.append(box);
    }
    wrap.append(h("h3", "st-h", "Skills inventory"));
    if (!st.skills) { wrap.append(h("p", "st-muted", "Loading skills…")); void loadSkills(); return wrap; }
    if (!st.skills.length) { wrap.append(h("p", "st-muted", st.skillsError ? `Could not load the skills: ${st.skillsError}` : "No file skills loaded.")); return wrap; }
    const table = h("table", "st-skills");
    const thead = h("thead"); const tr = h("tr"); for (const c of ["Skill", "What it does", "Group", "Licence", "Source"]) tr.append(h("th", "", c)); thead.append(tr); table.append(thead);
    const tb = h("tbody");
    for (const s of st.skills) {
      const r = h("tr");
      r.append(h("td", "st-skill-name", s.name), h("td", "", s.description), h("td", "", s.group || ""), h("td", "", s.license || "own"), h("td", "st-muted", s.source || (s.origin === "embedded" ? "bundled" : "bundled file")));
      tb.append(r);
    }
    table.append(tb);
    wrap.append(table);
    return wrap;
  }

  function taskList(rows, v, empty) {
    const ul = h("ul", "st-list inline");
    if (!rows.length) { ul.append(h("li", "st-empty", empty)); return ul; }
    for (const t of rows) ul.append(taskItem(t, v));
    return ul;
  }
  function taskItem(t, v) {
    const li = h("li", `st-task ${t.status}`);
    const btn = h("button", "st-task-btn"); btn.type = "button"; btn.setAttribute("aria-label", `${t.title}, ${t.botName}, open the session`);
    const dot = h("i", `st-dot ${LIGHT[t.status] || "red"}`); dot.setAttribute("aria-hidden", "true");
    const main = h("div", "st-task-main");
    main.append(h("div", "st-task-title", t.title));
    const meta = h("div", "st-task-meta");
    const dept = (v.departments.find((d) => d.slug === t.department) || {}).name || t.department;
    meta.append(h("span", "st-task-dept", dept), h("span", "sep", "·"), h("span", "", t.botName), h("span", "sep", "·"), h("span", "", ago(t.updatedAt)));
    if (t.project) meta.append(h("span", "sep", "·"), h("span", "st-task-proj", t.project));
    main.append(meta);
    if (t.status === "stopped" && t.question) main.append(h("div", "st-task-q", t.question));
    btn.append(dot, main);
    btn.addEventListener("click", () => app.openSession(t.sessionId));
    li.append(btn);
    return li;
  }

  function paintStage() {
    const v = st.view;
    if (!v) return;
    const onFloor = st.room === "overview";
    floor.hidden = !onFloor; hud.hidden = !onFloor; zoomBox.hidden = !onFloor; roomBox.hidden = onFloor;
    stage.classList.toggle("room", !onFloor);
    if (onFloor) {
      // Redraw the floor only when something on it changed, so the walking dots keep walking between refreshes.
      const sig = JSON.stringify([v.departments, v.links, v.bots.map((b) => [b.id, b.status, b.needs, b.name, b.color]), v.brain]);
      if (sig !== st.sig) { st.sig = sig; paintFloor(v); }
      return;
    }
    roomBox.replaceChildren();
    if (st.room === "live") roomBox.append(roomLive(v));
    else if (st.room === "office") roomBox.append(roomOffice(v));
    else if (st.room === "meeting") roomBox.append(roomMeeting(v));
    else if (st.room === "lounge") roomBox.append(roomLounge(v));
    else if (st.room === "workspaces") roomBox.append(roomWorkspaces(v));
    else if (st.room === "team") { roomBox.append(roomTeam(v)); if (!st.team || Date.now() - st.teamAt > REFRESH_MS) void loadTeam(); }
    else if (st.room === "pipelines") { roomBox.append(roomPipelines(v)); if (st.skills && Date.now() - st.skillsAt > 60_000) void loadSkills(); }
  }

  // ---- the Live room: helpers and loops at work right now (GET /studio/live, agents/hub.ts) ----
  function roomLive(v) {
    const live = v.live || { helpers: [], loops: [], running: 0 };
    const sum = liveSummary(live);
    const wrap = h("div", "lv-wrap");
    const head = h("div", "lv-head");
    const titleBox = h("div", "lv-titlebox");
    titleBox.append(h("h2", "lv-title", "Live"), h("p", "lv-sub", "Your Daebot's helpers and loops, as they work. Every helper starts from your MIND; builders work in their own branch so nothing collides."));
    const tiles = h("div", "lv-tiles");
    const tile = (n, label, cls) => { const t = h("div", `lv-tile ${cls || ""}`); t.append(h("b", "", String(n)), h("span", "", label)); return t; };
    tiles.append(tile(sum.working, "helpers working", sum.working ? "on" : ""), tile(sum.loops, "loops running", sum.loops ? "on" : ""), tile(sum.branches, "branches to review", sum.branches ? "warn" : ""), tile(sum.done, "finished this hour", ""));
    head.append(titleBox, tiles);
    wrap.append(head);
    if (!live.helpers.length && !live.loops.length) {
      const empty = h("div", "lv-empty");
      empty.append(h("strong", "", "Nobody is out on a job right now."), h("p", "", "Ask Dae to split a big job across helpers, or type /loop with a goal: it studies MIND, builds, checks, grades itself and keeps going until the work clears 9/10."));
      const row = h("div", "lv-empty-row");
      for (const [label, text] of LIVE_EXAMPLES) {
        const b = h("button", "lv-try", label); b.type = "button"; b.title = text;
        b.addEventListener("click", async () => { b.disabled = true; try { await app.sendTo("main", text); } catch { /* the chat shows the error */ } finally { b.disabled = false; } });
        row.append(b);
      }
      empty.append(row);
      wrap.append(empty);
      return wrap;
    }
    if (live.loops.length) {
      wrap.append(h("h3", "lv-h", "Loops"));
      const grid = h("div", "lv-loops");
      for (const l of live.loops) grid.append(loopCard(l));
      wrap.append(grid);
    }
    if (live.helpers.length) {
      wrap.append(h("h3", "lv-h", "Helpers"));
      const grid = h("ul", "lv-helpers");
      for (const x of live.helpers) grid.append(helperCard(x));
      wrap.append(grid);
    }
    return wrap;
  }
  function loopCard(l) {
    const card = h("button", `lv-loop ${l.endedAt ? l.phase : "running"}`); card.type = "button";
    card.setAttribute("aria-label", `Loop: ${l.goal}. ${PHASE_LABEL[l.phase] || l.phase}. Open the chat.`);
    card.addEventListener("click", () => app.openSession(l.session));
    const top = h("div", "lv-loop-top");
    top.append(h("span", `lv-phase ${l.phase}`, PHASE_LABEL[l.phase] || l.phase), h("span", "lv-time", l.endedAt ? ago(l.endedAt) : elapsedText(Date.now() - l.startedAt)));
    const last = l.scores.length ? l.scores[l.scores.length - 1] : null;
    const score = h("div", "lv-score");
    score.append(h("b", "", last === null ? "–" : last.toFixed(1)), h("span", "", `/ 10 · bar ${l.bar}`));
    const rail = h("div", "lv-rail"); rail.setAttribute("aria-label", `Cycle ${l.cycle} of ${l.maxCycles}`);
    for (const m of loopRail(l)) {
      const seg = h("i", `lv-seg ${m.kind}`);
      if (m.score !== undefined) { seg.style.setProperty("--fill", `${Math.max(4, Math.min(100, m.score * 10))}%`); seg.title = `${m.score}/10`; }
      rail.append(seg);
    }
    const meta = h("div", "lv-meta");
    meta.append(h("span", "", `Cycle ${Math.max(l.cycle, l.scores.length)} of ${l.maxCycles}`));
    if (l.weakest) meta.append(h("span", "", `weakest: ${l.weakest}`));
    if (l.branch) meta.append(h("span", "lv-branch", l.branch));
    card.append(top, h("div", "lv-goal", l.goal), score, rail, meta);
    return card;
  }
  function helperCard(x) {
    const li = h("li", `lv-helper ${x.status}`);
    const btn = h("button", "lv-helper-btn"); btn.type = "button";
    btn.setAttribute("aria-label", `${x.title}, ${x.status}. Open the chat that started it.`);
    btn.addEventListener("click", () => app.openSession(x.session));
    const top = h("div", "lv-helper-top");
    const dot = h("i", `lv-dot ${x.status}`); dot.setAttribute("aria-hidden", "true");
    top.append(dot, h("span", `lv-kind ${x.kind}`, KIND_LABEL[x.kind] || x.kind), h("span", "lv-time", x.endedAt ? elapsedText(x.endedAt - x.startedAt) : elapsedText(Date.now() - x.startedAt)));
    const now = x.status === "running" ? (x.tool ? `Using ${x.tool}` : "Thinking…") : x.status === "done" ? "Finished" : (x.note || "Did not finish");
    btn.append(top, h("div", "lv-helper-title", x.title), h("div", "lv-helper-now", now));
    const foot = h("div", "lv-meta");
    foot.append(h("span", "", `${x.calls} tool call${x.calls === 1 ? "" : "s"}`));
    if (x.loop) foot.append(h("span", "", `loop cycle ${x.cycle || 1}`));
    if (x.branch) foot.append(h("span", "lv-branch", `${x.branch}${x.files ? ` · ${x.files} file${x.files === 1 ? "" : "s"}` : ""}`));
    btn.append(foot);
    li.append(btn);
    return li;
  }
  async function loadLive() {
    if (st.liveLoading || !st.view) return;
    st.liveLoading = true;
    try {
      const live = await json("/studio/live");
      st.view = { ...st.view, live };
      paintLiveBits();
      if (st.room === "live") paintStage();
    } catch { /* the next tick tries again */ } finally { st.liveLoading = false; }
  }
  function paintLiveBits() {
    const n = liveSummary(st.view && st.view.live);
    const busy = n.working + n.loops;
    chipLive.hidden = !busy;
    chipLive.textContent = busy ? `● LIVE · ${n.working} helper${n.working === 1 ? "" : "s"}${n.loops ? ` · ${n.loops} loop${n.loops === 1 ? "" : "s"}` : ""}` : "";
    paintRooms(); paintHud();
  }
  function liveTick() {
    if (!st.open || document.visibilityState === "hidden") return;
    const n = liveSummary(st.view && st.view.live);
    if (st.room === "live" || n.working + n.loops > 0) void loadLive();
  }

  function paintHud() {
    const v = st.view;
    if (!v) return;
    kActive.textContent = `${v.bots.filter((b) => b.status !== "idle").length}/${v.bots.length}`;
    kRunning.textContent = String(v.tasks.filter((t) => t.status === "in_progress").length);
    const ls = liveSummary(v.live);
    kHelpers.textContent = String(ls.working + ls.loops);
    kHelpers.parentElement.classList.toggle("live", ls.working + ls.loops > 0);
    kDone.textContent = String(v.today.completed);
    kWaiting.textContent = String(v.needsYou.length);
    kWaiting.parentElement.classList.toggle("warn", v.needsYou.length > 0);
  }

  // The new-task box: a department (or the whole office), then who gets it (the main Daebot or that island's bots).
  function fillDepts() {
    const v = st.view;
    if (!v) return;
    const prev = taskDept.value;
    taskDept.replaceChildren();
    const all = h("option", "", "Whole office"); all.value = ""; taskDept.append(all);
    for (const d of v.departments) { const o = h("option", "", d.name); o.value = d.slug; taskDept.append(o); }
    taskDept.value = [...taskDept.options].some((o) => o.value === prev) ? prev : "";
    fillRecipients();
  }
  function fillRecipients() {
    const v = st.view;
    if (!v) return;
    const prev = taskTo.value || st.sendTo;
    taskTo.replaceChildren();
    const d = v.departments.find((x) => x.slug === taskDept.value);
    const ids = d ? d.bots : ["main", ...v.departments.filter((x) => x.slug !== "manager-office").map((x) => x.lead).filter(Boolean)];
    for (const id of ids) {
      const b = v.bots.find((x) => x.id === id);
      if (!b) continue;
      const o = h("option", "", id === "main" ? `${b.name} (main)` : b.name); o.value = b.id; taskTo.append(o);
    }
    if (!taskTo.options.length) { const o = h("option", "", `${v.name} (main)`); o.value = "main"; taskTo.append(o); }
    taskTo.value = [...taskTo.options].some((o) => o.value === prev) ? prev : taskTo.options[0].value;
  }

  // ---- the right column ----
  function cardOf(t, v) {
    const li = h("li", `oc-tcard ${t.status}`);
    const btn = h("button", "oc-tcard-btn"); btn.type = "button"; btn.setAttribute("aria-label", `${t.title}, ${t.botName}, open the session`);
    const p = taskPill(t);
    const top = h("div", "oc-tcard-top");
    top.append(h("span", `oc-tpill ${p.cls}`, p.text), h("span", "oc-tcard-title", t.title), h("span", "oc-tcard-time", ago(t.updatedAt)));
    const dept = (v.departments.find((d) => d.slug === t.department) || {}).name || t.department;
    const meta = h("div", "oc-tcard-meta", `${dept} · ${t.botName}${t.project ? ` · ${t.project}` : ""}`.toUpperCase());
    btn.append(top, meta);
    if (t.status === "stopped" && t.question) btn.append(h("div", "oc-tcard-q", t.question));
    btn.addEventListener("click", () => app.openSession(t.sessionId));
    li.append(btn);
    return li;
  }
  function schedCard(r, v) {
    const li = h("li", "oc-tcard scheduled");
    const btn = h("button", "oc-tcard-btn"); btn.type = "button";
    const top = h("div", "oc-tcard-top");
    top.append(h("span", "oc-tpill sched", "⏱"), h("span", "oc-tcard-title", r.name), h("span", "oc-tcard-time", dueText(r.nextDueAt)));
    const dept = (v.departments.find((d) => d.slug === r.department) || {}).name || r.department;
    btn.append(top, h("div", "oc-tcard-meta", `${dept} · ${r.botName} · ${new Date(r.nextDueAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`.toUpperCase()));
    btn.addEventListener("click", () => app.pickBot(r.bot));
    li.append(btn);
    return li;
  }
  function paintTasks() {
    const v = st.view;
    list.replaceChildren();
    if (!v) return;
    paintFilters();
    if (st.filter === "scheduled") {
      if (!v.scheduled.length) { list.append(h("li", "oc-empty", "Nothing scheduled. Ask Dae to run something every morning and it shows here.")); return; }
      for (const r of v.scheduled) list.append(schedCard(r, v));
      return;
    }
    const rows = filterTasks(v.tasks, st.filter === "waiting" ? "waiting" : st.filter);
    if (!rows.length) { list.append(h("li", "oc-empty", st.filter === "all" ? "No tasks yet. Type one above and your team picks it up." : "Nothing under this filter.")); return; }
    for (const t of rows) list.append(cardOf(t, v));
  }
  async function loadLog(force) {
    const v = st.view;
    if (!v) return;
    const top5 = v.meetings.slice(0, 5);
    const newest = top5.reduce((m, x) => Math.max(m, x.updatedAt), 0);
    if (!force && newest <= st.logAt) { paintLog(); return; }
    try {
      const exs = await Promise.all(top5.map((m) => json(`/exchanges/${encodeURIComponent(m.id)}`).then((r) => r.exchange).catch(() => null)));
      st.log = mergeLog(exs.filter(Boolean)); st.logAt = newest;
    } catch { /* keep the last log */ }
    paintLog();
  }
  function paintLog() {
    logList.replaceChildren();
    if (!st.log.length) { logList.append(h("li", "oc-empty", "No bot talk yet. When your bots message each other, who said what to whom shows here and a dot walks the line between their islands.")); return; }
    for (const m of st.log) {
      const li = h("li", `oc-tcard log ${m.kind}`);
      const head = h("div", "oc-tcard-top"); const w = h("strong", "oc-log-from", m.from); w.style.color = safeColor(m.fromColor);
      head.append(w, h("span", "oc-tcard-title dim", `→ ${m.to}`), h("span", "oc-tcard-time", ago(m.at)));
      li.append(head, h("p", "oc-log-text", m.text.length > 400 ? m.text.slice(0, 399) + "…" : m.text));
      logList.append(li);
    }
  }

  function tickClock() { clock.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }).toLowerCase(); }
  function paintTop() {
    const v = st.view;
    if (!v) return;
    who.textContent = `${v.name}'s office`;
    ver.textContent = `v${(v.layout && v.layout.v) || 1}`;
    ver.title = v.layout ? `Layout schema ${v.layout.v} · renderer ${v.layout.renderer} · built by ${v.layout.builtBy}` : "";
    chipModel.textContent = v.chip.model.split("/").pop();
    chipModel.title = `New turns run on ${v.chip.model}${v.chip.mode && v.chip.mode !== "off" ? ` · router ${v.chip.mode}` : ""}`;
    chipHost.textContent = /^(localhost|127\.|\[::1\])/.test(location.hostname) ? "this computer" : "Daebot cloud";
    chipNeeds.hidden = !v.needsYou.length;
    chipNeeds.textContent = v.needsYou.length ? `${v.needsYou.length} NEED${v.needsYou.length === 1 ? "S" : ""} YOU` : "";
    connIcons.replaceChildren();
    const mind = h("span", "oc-app mind"); const mi = h("img", ""); mi.src = "/brand/mind-flame.png"; mi.alt = ""; mi.width = 16; mi.height = 16; mind.append(mi); mind.title = "MIND: the Brain"; connIcons.append(mind);
    for (const a of (st.apps || []).slice(0, 9)) {
      const s = h("span", "oc-app"); s.title = a.name;
      const img = markFor(a.key, () => { s.textContent = (a.name || "?").slice(0, 1).toUpperCase(); });
      if (img) { img.width = 16; img.height = 16; s.append(img); } else s.textContent = (a.name || "?").slice(0, 1).toUpperCase();
      connIcons.append(s);
    }
    tickClock();
  }

  async function load() {
    if (st.loading) return;
    st.loading = true;
    try {
      const v = await json("/studio");
      st.prev = st.view; st.view = v;
      st.error = "";
      if (!st.building) { note.textContent = ""; note.hidden = true; }
      paintTop(); paintRooms(); paintHud(); paintLiveBits(); fillDepts(); paintStage(); paintTasks();
      if (st.right === "log") void loadLog(false);
      void loadApps();
    } catch (e) {
      st.error = (e && e.message) || "Could not load the studio.";
      note.textContent = `Could not load the studio: ${st.error}`; note.hidden = false;
    } finally { st.loading = false; }
  }

  function tick() { if (st.open && document.visibilityState !== "hidden") void load(); }
  function show(on) {
    st.open = !!on;
    els.section.hidden = !st.open;
    document.body.classList.toggle("studio-on", st.open);
    clearInterval(st.timer); st.timer = 0; clearInterval(st.clockTimer); st.clockTimer = 0; clearInterval(st.liveTimer); st.liveTimer = 0;
    if (st.open) { void load(); st.timer = setInterval(tick, REFRESH_MS); st.clockTimer = setInterval(tickClock, 1000); st.liveTimer = setInterval(liveTick, LIVE_MS); requestAnimationFrame(fit); }
  }
  document.addEventListener("visibilitychange", () => { if (st.open && document.visibilityState === "visible") void load(); });

  return { show, refresh: load, isOpen: () => st.open, view: () => st.view, room: (r) => { if (ROOMS.some((x) => x[0] === r)) { st.room = r; paintRooms(); paintStage(); } } };
}
