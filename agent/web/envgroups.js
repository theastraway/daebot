// Environment grouping for the sidebar. Every session and bot has a home environment (MIND Cloud, a computer, a server); the lists are
// grouped by it, with the environment you are on first. Pinned rows sit in one "Pinned" section above the groups.
// The grouping is pure (exported, unit tested); only renderGroups() touches the DOM (createElement and textContent only).

export const COLLAPSE_KEY = "mc_env_collapsed";
export const CLOUD = { id: "cloud", kind: "cloud", name: "MIND Cloud" };
export const KIND_ICON = { cloud: "i-cloud", machine: "i-desktop", server: "i-server" };
export const KIND_LABEL = { cloud: "Cloud", machine: "Computer", server: "Server" };

export function kindIcon(kind) { return KIND_ICON[kind] || "i-desktop"; }

/** A tag we are willing to show: a known kind, a plain id, a short name. Anything else is dropped. */
export function cleanEnv(e) {
  if (!e || typeof e !== "object") return null;
  const id = typeof e.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(e.id) ? e.id : "";
  const kind = e.kind === "cloud" || e.kind === "machine" || e.kind === "server" ? e.kind : "";
  const name = typeof e.name === "string" ? e.name.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  if (!id || !kind || !name) return null;
  return { id, kind, name };
}

/** The set of collapsed environment ids, as stored on this device. */
export function parseCollapsed(raw) {
  try { const v = JSON.parse(raw || "[]"); return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []); } catch { return new Set(); }
}
export function serializeCollapsed(set) { return JSON.stringify([...set].slice(0, 100)); }

const isPinned = (r) => !!(r && (r.pinnedAt || r.pinned));
const pinOrder = (a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0) || (b.updatedAt || 0) - (a.updatedAt || 0); // newest pin first

/**
 * Groups rows by home environment.
 *   rows: sessions or bots (each may carry `env`; a row with none belongs to the current environment)
 *   envs: the server's list [{id,kind,name,online,current}] (the source of truth for the online dot and which one is current)
 *   opts.keep(row) = false leaves a row out of the pinned section (it stays in its group)
 * Returns { pinned: row[], groups: [{ env, rows }] }. Groups with no rows are left out. The current environment is first, then online
 * ones, then offline ones, each alphabetical. Rows keep the order they came in (the server sorts by recency).
 */
export function groupByEnv(rows, envs, opts = {}) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const known = new Map();
  for (const e of Array.isArray(envs) ? envs : []) { const c = cleanEnv(e); if (c) known.set(c.id, { ...c, online: e.online !== false, current: !!e.current }); }
  const cur = [...known.values()].find((e) => e.current) || known.get(CLOUD.id) || { ...CLOUD, online: true, current: true };
  if (!known.has(cur.id)) known.set(cur.id, cur);
  const byId = new Map();
  const homeOf = (r) => { const c = cleanEnv(r.env); return c ? (known.get(c.id) || { ...c, online: false, current: false }) : cur; };
  const pinned = [];
  for (const r of list) {
    const env = homeOf(r);
    if (isPinned(r) && (!opts.keep || opts.keep(r))) { pinned.push(r); continue; }
    let g = byId.get(env.id);
    if (!g) byId.set(env.id, (g = { env, rows: [] }));
    g.rows.push(r);
  }
  pinned.sort(pinOrder);
  const rank = (g) => (g.env.current ? 0 : g.env.online ? 1 : 2);
  const groups = [...byId.values()].sort((a, b) => rank(a) - rank(b) || a.env.name.localeCompare(b.env.name));
  return { pinned, groups, envOf: homeOf };
}

/**
 * Draws grouped rows into `host`.
 *   model: groupByEnv() result · build(row) -> element · collapsed: Set of env ids · onToggle(envId)
 *   h, icon: the app's DOM helpers · pinnedLabel: heading of the pinned section
 */
export function renderGroups(host, model, { build, collapsed, onToggle, h, icon, pinnedLabel = "Pinned", countLabel = (n) => String(n) }) {
  if (model.pinned.length) {
    const sec = h("section", "env-group env-pinned");
    sec.setAttribute("aria-label", pinnedLabel);
    const head = h("div", "env-head static");
    const pin = icon("i-pin"); pin.classList.add("env-kind"); pin.setAttribute("aria-hidden", "true");
    head.append(pin, h("span", "env-name", pinnedLabel), h("span", "env-count", countLabel(model.pinned.length)));
    const body = h("div", "env-rows");
    for (const r of model.pinned) body.append(build(r, { pinned: true }));
    sec.append(head, body);
    host.append(sec);
  }
  for (const g of model.groups) {
    const open = !collapsed.has(g.env.id);
    const sec = h("section", `env-group${open ? "" : " collapsed"}`);
    sec.dataset.env = g.env.id;
    const head = h("button", "env-head"); head.type = "button";
    head.setAttribute("aria-expanded", String(open));
    const state = g.env.online ? "online" : "offline";
    head.setAttribute("aria-label", `${g.env.name}, ${KIND_LABEL[g.env.kind]}, ${state}. ${open ? "Collapse" : "Expand"}`);
    head.title = `${g.env.name} (${KIND_LABEL[g.env.kind].toLowerCase()}, ${state})${g.env.current ? " - you are here" : ""}`;
    const chev = icon("i-chev"); chev.classList.add("env-chev"); chev.setAttribute("aria-hidden", "true");
    const kind = icon(kindIcon(g.env.kind)); kind.classList.add("env-kind"); kind.setAttribute("aria-hidden", "true");
    const dot = h("i", `env-dot ${state}`); dot.setAttribute("aria-hidden", "true");
    head.append(chev, kind, h("span", "env-name", g.env.name), dot, h("span", "env-count", countLabel(g.rows.length)));
    head.addEventListener("click", () => onToggle(g.env.id));
    const body = h("div", "env-rows");
    if (open) for (const r of g.rows) body.append(build(r, { pinned: false }));
    sec.append(head, body);
    host.append(sec);
  }
}
