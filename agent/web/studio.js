// Daebot Studio: the user's bots as workers on an isometric floor (the view behind the Studio tab). One department is one island;
// each bot is a desk on its island, drawn with its own face and LED colour; the main Daebot sits in the Manager office; MIND is the
// Brain in the middle; dotted lines are bot_talk traffic between islands, and a dot walks the line when a new message went over it.
// A yellow "N waiting approval" badge sits on any island where a bot needs the user (a question, an awaiting-decision item or a
// permission card) and opens the task board, where the reply box is. Rooms above the floor: Overview (the floor), Manager office
// (Dae's desk, last turn's proof, Dae's tasks), Meeting room (the exchanges, with a read-only transcript), Lounge (idle bots),
// Workspaces (one island at a time). The left panel is the team at a glance with the "new task for the team" box; the right column
// is the task status list or the agent communication log. Everything is built with createElement/createElementNS and textContent:
// no innerHTML anywhere. Pure helpers are exported for tests; the DOM lives in initStudio.
import { faceSvg } from "./faces.js";
import { proofChips } from "./board.js";

const NS = "http://www.w3.org/2000/svg";
export const REFRESH_MS = 10000;
export const VIEW_W = 1000, VIEW_H = 640;
export const STATUS = { idle: "Idle", working: "Working", blocked: "Needs you" };
export const FILTERS = [["all", "All"], ["waiting", "Waiting"], ["in_progress", "In progress"], ["not_started", "Backlog"], ["ready_to_test", "Done"]];
export const LIGHT = { not_started: "red", in_progress: "yellow", ready_to_test: "green", stopped: "red", cancelled: "grey" };
export const ROOMS = [["overview", "Overview"], ["office", "Manager office"], ["meeting", "Meeting room"], ["lounge", "Lounge"], ["workspaces", "Workspaces"]];
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

/** Progress of a project as a percent of tasks ready to test. */
export const progressPct = (p) => (p && p.total > 0 ? Math.round((100 * p.done) / p.total) : 0);

export function initStudio({ json, h, ago, app, els }) {
  if (!els || !els.section) return null;
  const st = { open: false, view: null, prev: null, filter: "all", room: "overview", dept: "", right: "tasks", timer: 0, loading: false, error: "", meeting: null, log: [], logAt: 0, sendTo: "main" };
  const S = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const k in attrs || {}) n.setAttribute(k, String(attrs[k])); return n; };
  const T = (x, y, cls, text, attrs) => { const t = S("text", { x, y, class: cls, ...(attrs || {}) }); t.textContent = text; return t; };
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- skeleton ----
  const top = h("header", "st-top");
  const title = h("div", "st-title"); const name = h("strong", "", "Daebot Studio"); const who = h("span", "st-sub", ""); title.append(name, who);
  const rooms = h("div", "st-rooms"); rooms.setAttribute("role", "tablist"); rooms.setAttribute("aria-label", "Rooms");
  for (const [key, label] of ROOMS) {
    const b = h("button", "st-room", label); b.type = "button"; b.dataset.key = key; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(key === st.room));
    b.addEventListener("click", () => { st.room = key; paintRooms(); paintStage(); });
    rooms.append(b);
  }
  const chips = h("div", "st-chips");
  const chipModel = h("span", "st-chip", ""); chipModel.title = "The model new turns run on, and the router's mode";
  const chipBots = h("span", "st-chip", "");
  const chipNeeds = h("button", "st-chip warn"); chipNeeds.type = "button"; chipNeeds.hidden = true; chipNeeds.title = "Open the task board to reply";
  chipNeeds.addEventListener("click", () => app.openBoard());
  const clock = h("span", "st-clock", "");
  chips.append(chipModel, chipBots, chipNeeds, clock);
  top.append(title, rooms, chips);
  const note = h("p", "st-note", ""); note.setAttribute("role", "status"); note.setAttribute("aria-live", "polite");
  const body = h("div", "st-body");
  // Left: the team at a glance and the new-task box.
  const side = h("aside", "st-side"); side.setAttribute("aria-label", "Team");
  const stats = h("div", "st-stats");
  const statActive = stat("Active bots"), statRunning = stat("Running tasks"), statDone = stat("Completed today"), statWaiting = stat("Waiting on you");
  stats.append(statActive.box, statRunning.box, statDone.box, statWaiting.box);
  const projHead = h("h3", "st-h", "Project progress"); const projList = h("div", "st-projects");
  const taskBox = h("form", "st-newtask"); taskBox.setAttribute("aria-label", "New task for the team");
  const taskHead = h("h3", "st-h", "New task for the team");
  const taskArea = h("textarea", "st-newtask-text"); taskArea.rows = 3; taskArea.placeholder = "e.g. Research three vendors and file a brief in MIND"; taskArea.setAttribute("aria-label", "The task"); taskArea.maxLength = 4000;
  const taskRow = h("div", "st-newtask-row");
  const taskTo = h("select", "st-newtask-to"); taskTo.setAttribute("aria-label", "Who gets it");
  const taskSend = h("button", "btn-primary st-newtask-send", "Send"); taskSend.type = "submit";
  taskRow.append(taskTo, taskSend);
  const taskEx = h("div", "st-examples");
  for (const ex of EXAMPLES) { const b = h("button", "st-example", ex); b.type = "button"; b.addEventListener("click", () => { taskArea.value = ex; taskArea.focus(); }); taskEx.append(b); }
  const taskState = h("span", "st-newtask-state", ""); taskState.setAttribute("role", "status");
  taskBox.append(taskHead, taskArea, taskRow, taskEx, taskState);
  taskBox.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = taskArea.value.trim();
    if (!text) { taskArea.focus(); return; }
    taskSend.disabled = true; taskState.textContent = "Sending…";
    try { await app.sendTo(taskTo.value, text); taskArea.value = ""; taskState.textContent = ""; }
    catch (err) { taskState.textContent = (err && err.message) || "Could not send it."; }
    finally { taskSend.disabled = false; }
  });
  const actHead = h("h3", "st-h", "Agent activity"); const actList = h("ul", "st-activity");
  side.append(stats, projHead, projList, taskBox, actHead, actList);
  // Middle: the stage (the floor, or a room).
  const stage = h("div", "st-stage");
  // Right: tasks or the communication log.
  const aside = h("aside", "st-tasks"); aside.setAttribute("aria-label", "Task status and agent communication");
  const th = h("div", "st-tasks-head");
  const rightTabs = h("div", "st-right-tabs"); rightTabs.setAttribute("role", "tablist");
  const tabTasks = h("button", "st-right-tab", "Task status"); tabTasks.type = "button"; tabTasks.setAttribute("role", "tab");
  const tabLog = h("button", "st-right-tab", "Agent communication"); tabLog.type = "button"; tabLog.setAttribute("role", "tab");
  const pickRight = (k) => { st.right = k; tabTasks.setAttribute("aria-selected", String(k === "tasks")); tabLog.setAttribute("aria-selected", String(k === "log")); filters.hidden = k !== "tasks"; list.hidden = k !== "tasks"; logList.hidden = k !== "log"; if (k === "log") void loadLog(true); };
  tabTasks.addEventListener("click", () => pickRight("tasks")); tabLog.addEventListener("click", () => pickRight("log"));
  rightTabs.append(tabTasks, tabLog); th.append(rightTabs);
  const filters = h("div", "st-filters"); filters.setAttribute("role", "group"); filters.setAttribute("aria-label", "Filter tasks");
  const list = h("ul", "st-list");
  const logList = h("ul", "st-list st-log"); logList.hidden = true;
  aside.append(th, filters, list, logList);
  body.append(side, stage, aside);
  els.section.append(top, note, body);
  pickRight("tasks");

  for (const [key, label] of FILTERS) {
    const b = h("button", "st-filter", label); b.type = "button"; b.dataset.key = key; b.setAttribute("aria-pressed", String(key === st.filter));
    b.addEventListener("click", () => { st.filter = key; paintFilters(); paintTasks(); });
    filters.append(b);
  }
  function paintFilters() { for (const b of filters.children) b.setAttribute("aria-pressed", String(b.dataset.key === st.filter)); }
  function paintRooms() { for (const b of rooms.children) b.setAttribute("aria-selected", String(b.dataset.key === st.room)); }
  function stat(label) { const box = h("div", "st-stat"); const v = h("strong", "", "–"); box.append(v, h("span", "", label)); return { box, v }; }
  const statusChip = (bot) => { const c = h("span", `st-status ${bot.status}`, STATUS[bot.status] || bot.status); return c; };

  // ---- the floor ----
  function desk(bot, x, y, scale = 1) {
    const g = S("g", { class: `st-desk ${bot.status}`, transform: `translate(${x} ${y}) scale(${scale})`, tabindex: "0", role: "button" });
    g.style.color = safeColor(bot.color);
    const label = `${bot.name}: ${STATUS[bot.status] || bot.status}${bot.task ? `, ${bot.task.title}` : ""}`;
    g.setAttribute("aria-label", label);
    const tip = S("title"); tip.textContent = label; g.append(tip);
    g.append(S("polygon", { class: "st-desk-top", points: isoPoints(0, 10, 44, 22) }));
    g.append(S("circle", { class: "st-ring", cx: 0, cy: -8, r: 15 }));
    const face = faceSvg(bot.face);
    if (face) { face.setAttribute("x", -11); face.setAttribute("y", -19); face.setAttribute("width", 22); face.setAttribute("height", 22); g.append(face); }
    else g.append(T(0, -4, "st-initial", (bot.name || "?").slice(0, 1).toUpperCase(), { "text-anchor": "middle" }));
    if (bot.needs > 0) { const w = S("g", { class: "st-warn", transform: "translate(12 -22)" }); w.append(S("polygon", { points: "0,-7 7,6 -7,6" })); w.append(T(0, 4.5, "st-warn-mark", "!", { "text-anchor": "middle" })); g.append(w); }
    g.append(T(0, 30, "st-desk-name", bot.name.length > 12 ? bot.name.slice(0, 11) + "…" : bot.name, { "text-anchor": "middle" }));
    const open = () => { if (bot.task && bot.task.sessionId) app.openSession(bot.task.sessionId); else app.pickBot(bot.id); };
    g.addEventListener("click", open);
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    return g;
  }

  function island(d, pos, bots, scale = 1) {
    const w = 250, hh = 125, depth = 18;
    const g = S("g", { class: "st-island", transform: `translate(${pos.x} ${pos.y}) scale(${scale})`, "data-dept": d.slug });
    g.style.color = safeColor(d.color);
    g.append(S("polygon", { class: "st-side", points: `${-w / 2},0 0,${hh / 2} 0,${hh / 2 + depth} ${-w / 2},${depth}` }));
    g.append(S("polygon", { class: "st-side r", points: `0,${hh / 2} ${w / 2},0 ${w / 2},${depth} 0,${hh / 2 + depth}` }));
    g.append(S("polygon", { class: "st-top-face", points: isoPoints(0, 0, w, hh) }));
    const card = S("g", { class: "st-card", transform: `translate(0 ${-hh / 2 - 46})` });
    card.append(S("rect", { x: -92, y: -16, width: 184, height: 44, rx: 8 }));
    card.append(T(-84, 1, "st-dept", d.name.length > 22 ? d.name.slice(0, 21) + "…" : d.name));
    card.append(T(84, 1, "st-count", `${bots.length} ${bots.length === 1 ? "bot" : "bots"}`, { "text-anchor": "end" }));
    card.append(T(-84, 19, "st-kpi", `done ${d.counts.done} · working ${d.counts.working} · next ${d.counts.next}`));
    g.append(card);
    const slots = deskSlots(bots.length, 0, 0, w, hh);
    bots.forEach((b, i) => g.append(desk(b, slots[i].x, slots[i].y)));
    if (d.needsYou > 0) {
      const text = badgeText(d.needsYou);
      const bw = 14 + text.length * 6.6;
      const badge = S("g", { class: "st-badge", transform: `translate(0 ${hh / 2 + 28})`, tabindex: "0", role: "button", "aria-label": `${d.name}: ${text}. Open the task board to reply.` });
      badge.append(S("rect", { x: -bw / 2, y: -11, width: bw, height: 22, rx: 11 }));
      badge.append(S("polygon", { class: "st-badge-mark", points: `${-bw / 2 + 11},-5 ${-bw / 2 + 16},4 ${-bw / 2 + 6},4` }));
      badge.append(T(6, 4, "st-badge-text", text, { "text-anchor": "middle" }));
      badge.addEventListener("click", () => app.openBoard());
      badge.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); app.openBoard(); } });
      g.append(badge);
    }
    return g;
  }

  function brain(v, cx, cy) {
    const g = S("g", { class: "st-brain", transform: `translate(${cx} ${cy})` });
    g.append(S("circle", { class: "st-brain-ring", cx: 0, cy: 0, r: 58 }));
    g.append(S("circle", { class: "st-brain-core", cx: 0, cy: 0, r: 44 }));
    g.append(T(0, -8, "st-brain-name", "MIND", { "text-anchor": "middle" }));
    g.append(T(0, 10, "st-brain-line", `${v.brain.inMind} ${v.brain.inMind === 1 ? "task" : "tasks"} filed`, { "text-anchor": "middle" }));
    g.append(T(0, 24, "st-brain-line", `${v.brain.sessions} ${v.brain.sessions === 1 ? "session" : "sessions"}`, { "text-anchor": "middle" }));
    const t = S("title"); t.textContent = `The Brain: your MIND. ${v.brain.inMind} tasks filed, ${v.brain.decisions} decisions, ${v.brain.sessions} sessions in the last two weeks.`; g.append(t);
    return g;
  }

  /** A dot that walks from island a to island b (a bot carrying a bot_talk message). Removed when the walk ends. */
  function walker(svg, a, b, color) {
    if (reduced()) return;
    const dot = S("circle", { class: "st-walker", r: 6 });
    dot.style.color = safeColor(color);
    const mv = S("animateMotion", { dur: "1.6s", repeatCount: "1", fill: "freeze", path: `M${a.x},${a.y} L${b.x},${b.y}` });
    dot.append(mv);
    dot.addEventListener("animationend", () => dot.remove());
    setTimeout(() => dot.remove(), 1800);
    svg.append(dot);
  }

  function floorSvg(v, { only } = {}) {
    const svg = S("svg", { viewBox: `0 0 ${VIEW_W} ${VIEW_H}`, preserveAspectRatio: "xMidYMid meet", class: "st-svg", role: "img", "aria-label": only ? `The ${only.name} island` : "Your bots on the studio floor" });
    const bots = new Map(v.bots.map((b) => [b.id, b]));
    if (only) { svg.append(island(only, { x: VIEW_W / 2, y: VIEW_H / 2 + 20 }, only.bots.map((id) => bots.get(id)).filter(Boolean), 2)); return { svg, by: new Map() }; }
    const pos = layoutIslands(v.departments.length);
    const by = new Map(v.departments.map((d, i) => [d.slug, pos[i]]));
    const center = { x: VIEW_W / 2, y: VIEW_H / 2 + 10 };
    const links = S("g", { class: "st-links" });
    for (const d of v.departments) { const p = by.get(d.slug); links.append(S("line", { class: "st-spoke", x1: center.x, y1: center.y, x2: p.x, y2: p.y })); }
    for (const l of v.links) {
      if (l.a === l.b) continue;
      const a = by.get(l.a), b = by.get(l.b);
      if (!a || !b) continue;
      const ln = S("line", { class: "st-link", x1: a.x, y1: a.y, x2: b.x, y2: b.y, "stroke-width": Math.min(4, 1 + Math.log2(1 + l.count)) });
      const t = S("title"); t.textContent = `${l.count} bot_talk ${l.count === 1 ? "message" : "messages"}, last ${ago(l.at)}`; ln.append(t);
      links.append(ln);
    }
    svg.append(links);
    svg.append(brain(v, center.x, center.y));
    const order = v.departments.map((d, i) => ({ d, p: pos[i] })).sort((p, q) => p.p.y - q.p.y);
    for (const { d, p } of order) svg.append(island(d, p, d.bots.map((id) => bots.get(id)).filter(Boolean)));
    return { svg, by };
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
    const svg = S("svg", { viewBox: "0 0 300 200", class: "st-svg st-svg-small", role: "img", "aria-label": `${dae.name}'s desk` });
    const office = v.departments.find((d) => d.slug === "manager-office") || { slug: "manager-office", name: "Manager office", color: dae.color, bots: ["main"], counts: { done: 0, working: 0, next: 0, waiting: 0 }, needsYou: 0 };
    svg.append(island(office, { x: 150, y: 110 }, [dae], 1));
    wrap.append(svg);
    const col = h("div", "st-room-col");
    col.append(botCard(dae, v));
    const proofBox = h("div", "st-proof"); proofBox.append(h("h3", "st-h", "Last turn"));
    const chipsRow = h("div", "st-proof-chips");
    const pc = proofChips(dae.proof);
    if (!pc.length) chipsRow.append(h("span", "st-muted", "No turn yet."));
    for (const c of pc) { const s = h("span", `bd-chip ${c.cls || ""}`.trim(), c.text); if (c.title) s.title = c.title; chipsRow.append(s); }
    proofBox.append(chipsRow); col.append(proofBox);
    const mine = v.tasks.filter((t) => t.bot === "main");
    col.append(h("h3", "st-h", `${dae.name}'s tasks`), taskList(mine, v, "Nothing on the board for the main Daebot."));
    wrap.append(col);
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
    row.append(floorSvg(v, { only: d }).svg);
    const col = h("div", "st-room-col");
    col.append(h("h3", "st-h", `${d.name}: ${d.bots.length} ${d.bots.length === 1 ? "bot" : "bots"}, done ${d.counts.done}, working ${d.counts.working}, next ${d.counts.next}, waiting ${d.counts.waiting}`));
    col.append(taskList(v.tasks.filter((t) => t.department === d.slug), v, "No tasks on this island yet."));
    const lead = v.bots.find((b) => b.id === d.lead);
    if (lead) { const b = h("button", "btn-quiet st-task-for", `Type a task for ${d.name} (goes to ${lead.name})`); b.type = "button"; b.addEventListener("click", () => { taskTo.value = lead.id; taskArea.focus(); }); col.append(b); }
    row.append(col);
    wrap.append(row);
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
    stage.replaceChildren();
    if (!v) return;
    if (st.room === "overview") {
      const { svg, by } = floorSvg(v);
      stage.append(svg);
      const bots = new Map(v.bots.map((b) => [b.id, b]));
      for (const w of walks(st.prev, v)) { const a = by.get(w.a), b = by.get(w.b); if (a && b) { const d = v.departments.find((x) => x.slug === w.a); const lead = d && bots.get(d.lead); walker(svg, a, b, lead ? lead.color : ""); } }
    }
    else if (st.room === "office") stage.append(roomOffice(v));
    else if (st.room === "meeting") stage.append(roomMeeting(v));
    else if (st.room === "lounge") stage.append(roomLounge(v));
    else if (st.room === "workspaces") stage.append(roomWorkspaces(v));
  }

  // ---- the side panel ----
  function paintSide() {
    const v = st.view;
    if (!v) return;
    const team = v.bots;
    const active = team.filter((b) => b.status !== "idle").length;
    statActive.v.textContent = `${active} / ${team.length}`;
    statRunning.v.textContent = String(v.tasks.filter((t) => t.status === "in_progress").length);
    statDone.v.textContent = String(v.today.completed);
    statWaiting.v.textContent = String(v.needsYou.length);
    projList.replaceChildren();
    if (!v.projects.length) projList.append(h("p", "st-muted", "No project yet. Tasks filed to a MIND project show their progress here."));
    for (const p of v.projects) {
      const row = h("div", "st-proj");
      const head = h("div", "st-proj-head"); head.append(h("span", "st-proj-name", p.name), h("span", "st-proj-pct", `${progressPct(p)}%`));
      const bar = h("div", "st-proj-bar"); bar.setAttribute("role", "progressbar"); bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", "100"); bar.setAttribute("aria-valuenow", String(progressPct(p))); bar.setAttribute("aria-label", `${p.name} progress`);
      const fill = h("i", ""); fill.style.width = `${progressPct(p)}%`; bar.append(fill);
      row.append(head, bar, h("div", "st-proj-meta", `${p.done} done · ${p.working} working · ${p.next} next${p.waiting ? ` · ${p.waiting} waiting on you` : ""}`));
      projList.append(row);
    }
    // Who can get a task: the main Daebot, then every island's lead bot.
    const prev = taskTo.value || st.sendTo;
    taskTo.replaceChildren();
    const optMain = h("option", "", `${v.name} (main)`); optMain.value = "main"; taskTo.append(optMain);
    for (const d of v.departments) { if (d.slug === "manager-office") continue; const lead = team.find((b) => b.id === d.lead); if (!lead) continue; const o = h("option", "", `${lead.name} · ${d.name}`); o.value = lead.id; taskTo.append(o); }
    taskTo.value = [...taskTo.options].some((o) => o.value === prev) ? prev : "main";
    actList.replaceChildren();
    for (const b of team) {
      const li = h("li", `st-act ${b.status}`);
      const btn = h("button", "st-act-btn"); btn.type = "button";
      const av = h("span", "st-act-face"); av.style.color = safeColor(b.color); const f = faceSvg(b.face); if (f) av.append(f); else av.textContent = (b.name || "?").slice(0, 1).toUpperCase();
      const txt = h("div", "st-act-text"); const nm = h("div", "st-act-name"); nm.append(h("strong", "", b.name), statusChip(b)); txt.append(nm);
      txt.append(h("div", "st-act-task", b.task ? b.task.title : b.status === "idle" ? loungeLine(b.id, new Date().getHours()) : "working"));
      btn.append(av, txt);
      btn.addEventListener("click", () => { if (b.task) app.openSession(b.task.sessionId); else app.pickBot(b.id); });
      li.append(btn); actList.append(li);
    }
  }

  // ---- the right column ----
  function paintTasks() {
    const v = st.view;
    list.replaceChildren();
    if (!v) return;
    const rows = filterTasks(v.tasks, st.filter);
    if (!rows.length) { list.append(h("li", "st-empty", st.filter === "all" ? "No tasks yet. Ask Dae for something and it lands here." : "Nothing under this filter.")); return; }
    for (const t of rows) list.append(taskItem(t, v));
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
    if (!st.log.length) { logList.append(h("li", "st-empty", "No agent communication yet. bot_talk messages between your bots show here with who said what to whom.")); return; }
    for (const m of st.log) {
      const li = h("li", `st-logmsg ${m.kind}`);
      const head = h("div", "st-log-head"); const w = h("strong", "", m.from); w.style.color = safeColor(m.fromColor);
      head.append(w, h("span", "st-muted", ` → ${m.to} · ${ago(m.at)}`));
      li.append(head, h("p", "st-log-text", m.text.length > 400 ? m.text.slice(0, 399) + "…" : m.text));
      logList.append(li);
    }
  }

  function paintTop() {
    const v = st.view;
    if (!v) return;
    who.textContent = `${v.name}'s team`;
    chipModel.textContent = `runs on ${v.chip.model}${v.chip.mode && v.chip.mode !== "off" ? ` · router ${v.chip.mode}` : ""}`;
    const n = v.bots.length - 1;
    chipBots.textContent = `${n} ${n === 1 ? "bot" : "bots"} · ${v.brain.working} working`;
    chipNeeds.hidden = !v.needsYou.length;
    chipNeeds.textContent = v.needsYou.length ? `${v.needsYou.length} need${v.needsYou.length === 1 ? "s" : ""} you` : "";
    clock.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  async function load() {
    if (st.loading) return;
    st.loading = true;
    try {
      const v = await json("/studio");
      st.prev = st.view; st.view = v;
      st.error = "";
      note.textContent = v.needsYou.length ? `${v.needsYou.length} ${v.needsYou.length === 1 ? "item waits" : "items wait"} on you. A yellow badge marks the island; the task board has the reply box.` : "Islands are departments (set one in a bot's settings). Click a desk to open what that bot is on.";
      paintTop(); paintSide(); paintStage(); paintTasks();
      if (st.right === "log") void loadLog(false);
    } catch (e) {
      st.error = (e && e.message) || "Could not load the studio.";
      note.textContent = `Could not load the studio: ${st.error}`;
    } finally { st.loading = false; }
  }

  function tick() { if (st.open && document.visibilityState !== "hidden") void load(); }
  function show(on) {
    st.open = !!on;
    els.section.hidden = !st.open;
    document.body.classList.toggle("studio-on", st.open);
    clearInterval(st.timer); st.timer = 0;
    if (st.open) { void load(); st.timer = setInterval(tick, REFRESH_MS); }
  }
  document.addEventListener("visibilitychange", () => { if (st.open && document.visibilityState === "visible") void load(); });

  return { show, refresh: load, isOpen: () => st.open, view: () => st.view, room: (r) => { if (ROOMS.some((x) => x[0] === r)) { st.room = r; paintRooms(); paintStage(); } } };
}
