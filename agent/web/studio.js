// Daebot Studio: the user's bots as workers on an isometric floor (the view behind the Studio tab). One department is one island;
// each bot is a desk on its island, drawn with its own face and LED colour; the main Daebot sits in the Manager office; MIND is the
// Brain in the middle; dotted lines are bot_talk traffic between islands. A yellow "N waiting approval" badge sits on any island where
// a bot needs the user (a question, an awaiting-decision item or a permission card) and opens the task board, where the reply box is.
// The right column is the task status list across every island. Everything is built with createElement/createElementNS and
// textContent: no innerHTML anywhere. Pure helpers (layout, filters, labels) are exported for tests; the DOM lives in initStudio.
import { faceSvg } from "./faces.js";

const NS = "http://www.w3.org/2000/svg";
export const REFRESH_MS = 10000;
export const VIEW_W = 1000, VIEW_H = 640;
export const STATUS = { idle: "Idle", working: "Working", blocked: "Needs you" };
export const FILTERS = [["all", "All"], ["waiting", "Waiting"], ["in_progress", "In progress"], ["not_started", "Backlog"], ["ready_to_test", "Done"]];
export const LIGHT = { not_started: "red", in_progress: "yellow", ready_to_test: "green", stopped: "red", cancelled: "grey" };
const COLOR_RE = /^#[0-9a-f]{6}$/i;

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

export function initStudio({ json, h, ago, app, els }) {
  if (!els || !els.section) return null;
  const st = { open: false, view: null, filter: "all", timer: 0, loading: false, error: "" };
  const S = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const k in attrs || {}) n.setAttribute(k, String(attrs[k])); return n; };
  const T = (x, y, cls, text, attrs) => { const t = S("text", { x, y, class: cls, ...(attrs || {}) }); t.textContent = text; return t; };

  // ---- skeleton ----
  const top = h("header", "st-top");
  const title = h("div", "st-title"); const name = h("strong", "", "Daebot Studio"); const who = h("span", "st-sub", ""); title.append(name, who);
  const chips = h("div", "st-chips");
  const chipModel = h("span", "st-chip", ""); chipModel.title = "The model new turns run on, and the router's mode";
  const chipBots = h("span", "st-chip", "");
  const chipNeeds = h("button", "st-chip warn"); chipNeeds.type = "button"; chipNeeds.hidden = true; chipNeeds.title = "Open the task board to reply";
  chipNeeds.addEventListener("click", () => app.openBoard());
  const clock = h("span", "st-clock", "");
  chips.append(chipModel, chipBots, chipNeeds, clock);
  top.append(title, chips);
  const note = h("p", "st-note", ""); note.setAttribute("role", "status"); note.setAttribute("aria-live", "polite");
  const body = h("div", "st-body");
  const floor = h("div", "st-floor");
  const svg = S("svg", { viewBox: `0 0 ${VIEW_W} ${VIEW_H}`, preserveAspectRatio: "xMidYMid meet", class: "st-svg", role: "img", "aria-label": "Your bots on the studio floor" });
  floor.append(svg);
  const aside = h("aside", "st-tasks"); aside.setAttribute("aria-label", "Task status");
  const th = h("div", "st-tasks-head"); th.append(h("h3", "", "Task status"));
  const filters = h("div", "st-filters"); filters.setAttribute("role", "group"); filters.setAttribute("aria-label", "Filter tasks");
  const list = h("ul", "st-list");
  aside.append(th, filters, list);
  body.append(floor, aside);
  els.section.append(top, note, body);

  for (const [key, label] of FILTERS) {
    const b = h("button", "st-filter", label); b.type = "button"; b.dataset.key = key; b.setAttribute("aria-pressed", String(key === st.filter));
    b.addEventListener("click", () => { st.filter = key; paintFilters(); paintTasks(); });
    filters.append(b);
  }
  function paintFilters() { for (const b of filters.children) b.setAttribute("aria-pressed", String(b.dataset.key === st.filter)); }

  // ---- the floor ----
  function desk(bot, x, y) {
    const g = S("g", { class: `st-desk ${bot.status}`, transform: `translate(${x} ${y})`, tabindex: "0", role: "button" });
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

  function island(d, pos, bots) {
    const w = 250, hh = 125, depth = 18;
    const g = S("g", { class: "st-island", transform: `translate(${pos.x} ${pos.y})`, "data-dept": d.slug });
    g.style.color = safeColor(d.color);
    // The slab: two side faces then the top.
    g.append(S("polygon", { class: "st-side", points: `${-w / 2},0 0,${hh / 2} 0,${hh / 2 + depth} ${-w / 2},${depth}` }));
    g.append(S("polygon", { class: "st-side r", points: `0,${hh / 2} ${w / 2},0 ${w / 2},${depth} 0,${hh / 2 + depth}` }));
    g.append(S("polygon", { class: "st-top-face", points: isoPoints(0, 0, w, hh) }));
    // The card above the slab: name, bot count, counters.
    const card = S("g", { class: "st-card", transform: `translate(0 ${-hh / 2 - 46})` });
    card.append(S("rect", { x: -92, y: -16, width: 184, height: 44, rx: 8 }));
    card.append(T(-84, 1, "st-dept", d.name.length > 22 ? d.name.slice(0, 21) + "…" : d.name));
    card.append(T(84, 1, "st-count", `${bots.length} ${bots.length === 1 ? "bot" : "bots"}`, { "text-anchor": "end" }));
    card.append(T(-84, 19, "st-kpi", `done ${d.counts.done} · working ${d.counts.working} · next ${d.counts.next}`));
    g.append(card);
    // The desks.
    const slots = deskSlots(bots.length, 0, 0, w, hh);
    bots.forEach((b, i) => g.append(desk(b, slots[i].x, slots[i].y)));
    // The yellow badge: what needs the user on this island. Opens the task board (the reply boxes live there).
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

  function paintFloor() {
    const v = st.view;
    svg.replaceChildren();
    if (!v) return;
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
    const bots = new Map(v.bots.map((b) => [b.id, b]));
    // Lower islands paint later so their slabs overlap the ones behind them.
    const order = v.departments.map((d, i) => ({ d, p: pos[i] })).sort((a, b) => a.p.y - b.p.y);
    for (const { d, p } of order) svg.append(island(d, p, d.bots.map((id) => bots.get(id)).filter(Boolean)));
  }

  // ---- the task column ----
  function paintTasks() {
    const v = st.view;
    list.replaceChildren();
    if (!v) return;
    const rows = filterTasks(v.tasks, st.filter);
    if (!rows.length) { const li = h("li", "st-empty", st.filter === "all" ? "No tasks yet. Ask Dae for something and it lands here." : "Nothing under this filter."); list.append(li); return; }
    for (const t of rows) {
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
      list.append(li);
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
      st.view = await json("/studio");
      st.error = "";
      note.textContent = st.view.needsYou.length ? `${st.view.needsYou.length} ${st.view.needsYou.length === 1 ? "item waits" : "items wait"} on you. A yellow badge marks the island; the task board has the reply box.` : "Islands are departments (set one in a bot's settings). Click a desk to open what that bot is on.";
      paintTop(); paintFloor(); paintTasks();
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

  return { show, refresh: load, isOpen: () => st.open, view: () => st.view };
}
