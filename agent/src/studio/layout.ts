// The Studio layout of ONE account: the office plan the shared renderer (web/studio.js) draws. It is data, not code: which islands
// exist, their names, colours and places around the Brain, which island each bot's desk sits on, the two stats each island card
// shows, and which rooms the account sees. One renderer for everyone, one layout per account.
//
// Who writes it (the Studio Builder):
//   - buildLayout: from the account's real bots (and, when a model is offered, the model's grouping, names and stat picks), on the
//     first Studio open, on "Rebuild office", or when Dae calls studio_build;
//   - reconcileLayout: incremental, on every read: a new bot gets a desk, a deleted bot's desk goes, a changed department moves the
//     desk, and the user's own edits (renames, moves, added islands) are kept;
//   - migrateLayout: when the schema or the renderer version moves on, every stored layout is carried forward on boot or first read;
//   - applyEdit: the user's words through Dae (studio_edit): rename, move next to the Brain, add a department, move a bot, recolour.
// Every string is clipped to one line and every field is validated: nothing a model or a file says is trusted as is.

export const LAYOUT_SCHEMA = 2;
export const RENDERER_VERSION = "office-1";
export const PALETTE = ["green", "teal", "pink", "purple", "indigo", "yellow", "orange", "cyan"] as const;
export type PaletteKey = (typeof PALETTE)[number];
/** The stats an island card can show besides "N agents" and "doing · next · done". Counter names a bot published come as "counter:<name>". */
export const STAT_KEYS = ["sessions", "messages", "routines", "in_mind", "waiting", "today"] as const;
export const STAT_LABEL: Record<string, string> = { sessions: "Sessions", messages: "Bot talk", routines: "Scheduled", in_mind: "Filed to MIND", waiting: "Waiting on you", today: "Done today" };
export const ROOM_KEYS = ["overview", "office", "meeting", "lounge", "workspaces", "team", "pipelines"] as const;
export type RoomKey = (typeof ROOM_KEYS)[number];
export const MANAGER = "manager-office";
export const GENERAL = "general";
export const MAX_ISLANDS = 24;
export const MAX_NAME = 28;

/** Island places on an isometric grid around the Brain at (0,0): the inner ring first (manager office on top), then the outer ring. */
export const SLOTS: readonly { u: number; v: number }[] = [
  { u: -1, v: -1 }, { u: 0, v: -1 }, { u: -1, v: 0 }, { u: 1, v: -1 }, { u: -1, v: 1 }, { u: 1, v: 0 }, { u: 0, v: 1 }, { u: 1, v: 1 },
  { u: -2, v: -2 }, { u: -1, v: -2 }, { u: 0, v: -2 }, { u: 1, v: -2 }, { u: 2, v: -2 }, { u: 2, v: -1 }, { u: 2, v: 0 }, { u: 2, v: 1 },
  { u: 2, v: 2 }, { u: 1, v: 2 }, { u: 0, v: 2 }, { u: -1, v: 2 }, { u: -2, v: 2 }, { u: -2, v: 1 }, { u: -2, v: 0 }, { u: -2, v: -1 },
];
export const INNER_SLOTS = 8;

export type IslandSource = "manager" | "department" | "model" | "user" | "general";
export interface LayoutIsland {
  slug: string; name: string; color: PaletteKey; slot: number;
  /** Two stat keys for the card (STAT_KEYS or "counter:<name>"). */
  stats: string[];
  source: IslandSource;
  /** Fields the user set by hand: the builder never overwrites them. */
  locked?: { name?: true; color?: true; slot?: true; stats?: true };
}
export interface StudioLayout {
  v: number;
  renderer: string;
  builtAt: number;
  updatedAt: number;
  builtBy: "rules" | "model" | "user";
  islands: LayoutIsland[];
  /** Bot id -> island slug, for desks NOT placed by the bot's own department (a model grouping or a user move). */
  desks: Record<string, string>;
  /** Bot ids whose desk the user placed by hand (kept over the bot's department). */
  pinned: string[];
  rooms: RoomKey[];
  /** Bot ids the layout has placed, to tell a new bot from a known one. */
  seen: string[];
}
export interface LayoutBot { id: string; name: string; department?: string; purpose?: string }

// eslint-disable-next-line no-control-regex
const oneLine = (v: unknown, max: number): string => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
export const slugOf = (name: string): string => oneLine(name, 60).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
const isPalette = (c: unknown): c is PaletteKey => typeof c === "string" && (PALETTE as readonly string[]).includes(c);
const isStat = (s: unknown): s is string => typeof s === "string" && ((STAT_KEYS as readonly string[]).includes(s) || /^counter:[^\n]{1,32}$/.test(s));
const DEFAULT_STATS = ["sessions", "messages"];
const MANAGER_STATS = ["in_mind", "waiting"];

/** The island a bot belongs on by its own department field (General when blank). */
export function departmentIsland(b: LayoutBot): { slug: string; name: string } {
  const name = oneLine(b.department, 40);
  if (!name) return { slug: GENERAL, name: "General" };
  const s = slugOf(name);
  return s ? { slug: s, name: name.slice(0, MAX_NAME) } : { slug: GENERAL, name: "General" };
}

function freeSlot(used: Set<number>, inner = false): number {
  for (let i = 1; i < SLOTS.length; i++) if (!used.has(i) && (!inner || i < INNER_SLOTS)) return i;
  for (let i = 1; i < SLOTS.length; i++) if (!used.has(i)) return i;
  return -1;
}
function freeColor(used: PaletteKey[]): PaletteKey {
  for (const c of PALETTE) if (!used.includes(c)) return c;
  return PALETTE[used.length % PALETTE.length];
}

/** An empty layout with only the Manager office. */
export function emptyLayout(now: number): StudioLayout {
  return { v: LAYOUT_SCHEMA, renderer: RENDERER_VERSION, builtAt: now, updatedAt: now, builtBy: "rules", islands: [{ slug: MANAGER, name: "Manager office", color: "green", slot: 0, stats: [...MANAGER_STATS], source: "manager" }], desks: {}, pinned: [], rooms: [...ROOM_KEYS], seen: [] };
}

/** Where a bot's desk goes: a pinned (hand-placed) desk, then its own department, then a model grouping, then General. */
export function islandFor(l: StudioLayout, b: LayoutBot): string {
  const has = (s: string | undefined) => !!s && l.islands.some((i) => i.slug === s);
  if (l.pinned.includes(b.id) && has(l.desks[b.id])) return l.desks[b.id];
  const dept = departmentIsland(b);
  if (dept.slug !== GENERAL) return dept.slug;
  if (has(l.desks[b.id])) return l.desks[b.id];
  return GENERAL;
}

/**
 * Incremental rebuild: places every bot, adds the islands their departments need, drops empty islands the builder made (never one
 * the user added) and forgets deleted bots. User edits (locked fields, pinned desks, user islands) are kept. Returns whether it changed.
 */
export function reconcileLayout(prev: StudioLayout, bots: readonly LayoutBot[], now: number): { layout: StudioLayout; changed: boolean } {
  const l: StudioLayout = structuredClone(prev);
  const before = JSON.stringify(prev);
  const ids = new Set(bots.map((b) => b.id));
  if (!l.islands.some((i) => i.slug === MANAGER)) l.islands.unshift({ slug: MANAGER, name: "Manager office", color: "green", slot: 0, stats: [...MANAGER_STATS], source: "manager" });
  for (const k of Object.keys(l.desks)) if (!ids.has(k)) delete l.desks[k];
  l.pinned = l.pinned.filter((id) => ids.has(id));
  l.seen = l.seen.filter((id) => ids.has(id));
  const need = new Map<string, string>();
  for (const b of bots) {
    const s = islandFor(l, b);
    if (s === GENERAL) need.set(GENERAL, "General");
    else if (!l.islands.some((i) => i.slug === s)) need.set(s, departmentIsland(b).name);
    if (!l.seen.includes(b.id)) l.seen.push(b.id);
  }
  const used = new Set(l.islands.map((i) => i.slot));
  for (const [slug, name] of need) {
    if (l.islands.some((i) => i.slug === slug) || l.islands.length >= MAX_ISLANDS) continue;
    const slot = freeSlot(used);
    if (slot < 0) break;
    used.add(slot);
    l.islands.push({ slug, name, color: freeColor(l.islands.map((i) => i.color)), slot, stats: [...DEFAULT_STATS], source: slug === GENERAL ? "general" : "department" });
  }
  // Drop builder-made islands nobody sits on.
  const occupied = new Set(bots.map((b) => islandFor(l, b)));
  l.islands = l.islands.filter((i) => i.slug === MANAGER || i.source === "user" || occupied.has(i.slug));
  // Desks that point at an island that is gone fall back to their department.
  for (const [k, s] of Object.entries(l.desks)) if (!l.islands.some((i) => i.slug === s)) { delete l.desks[k]; l.pinned = l.pinned.filter((x) => x !== k); }
  const changed = JSON.stringify(l) !== before;
  if (changed) l.updatedAt = now;
  return { layout: l, changed };
}

/** A fresh layout by the rules alone: one island per department, General for the rest, colours and slots in order. */
export function rulesLayout(bots: readonly LayoutBot[], now: number): StudioLayout {
  return reconcileLayout(emptyLayout(now), bots, now).layout;
}

/** What a model may propose (anything else is ignored). */
export interface ModelPlan { islands: { name: string; members?: string[]; color?: string; stats?: string[]; nearBrain?: boolean }[] }

/**
 * The model's plan over a rules layout: it may group bots WITHOUT a department into named islands, pick colours and the two card
 * stats per island, and say which islands sit next to the Brain. A bot's own department always wins; locked fields are kept.
 */
export function applyModelPlan(base: StudioLayout, plan: unknown, bots: readonly LayoutBot[], now: number): { layout: StudioLayout; applied: number } {
  const p = plan as ModelPlan;
  if (!p || !Array.isArray(p.islands)) return { layout: base, applied: 0 };
  let l = structuredClone(base);
  const free = new Set(bots.filter((b) => departmentIsland(b).slug === GENERAL && !l.pinned.includes(b.id)).map((b) => b.id));
  let applied = 0;
  const near: string[] = [];
  for (const raw of p.islands.slice(0, MAX_ISLANDS)) {
    if (!raw || typeof raw !== "object") continue;
    const name = oneLine(raw.name, MAX_NAME);
    const slug = slugOf(name);
    if (!name || !slug || slug === MANAGER) {
      const m = l.islands.find((i) => i.slug === MANAGER);
      if (m && slug === MANAGER) { if (isPalette(raw.color) && !m.locked?.color) m.color = raw.color; const st = (raw.stats ?? []).filter(isStat).slice(0, 2); if (st.length === 2 && !m.locked?.stats) m.stats = st; }
      continue;
    }
    const members = (Array.isArray(raw.members) ? raw.members : []).filter((id): id is string => typeof id === "string" && free.has(id));
    for (const id of members) { l.desks[id] = slug; free.delete(id); }
    let isl = l.islands.find((i) => i.slug === slug);
    if (!isl && members.length) {
      const used = new Set(l.islands.map((i) => i.slot));
      const slot = freeSlot(used);
      if (slot < 0) continue;
      isl = { slug, name, color: freeColor(l.islands.map((i) => i.color)), slot, stats: [...DEFAULT_STATS], source: "model" };
      l.islands.push(isl);
    }
    if (!isl) continue;
    if (isPalette(raw.color) && !isl.locked?.color) isl.color = raw.color;
    const st = (Array.isArray(raw.stats) ? raw.stats : []).filter(isStat).slice(0, 2);
    if (st.length === 2 && !isl.locked?.stats) isl.stats = st;
    if (raw.nearBrain) near.push(slug);
    applied++;
  }
  for (const s of near) l = moveIsland(l, s, "brain");
  const r = reconcileLayout(l, bots, now);
  r.layout.builtBy = "model";
  return { layout: r.layout, applied };
}

function moveIsland(l: StudioLayout, slug: string, where: "brain" | number): StudioLayout {
  const isl = l.islands.find((i) => i.slug === slug);
  if (!isl) return l;
  const target = where === "brain" ? (isl.slot > 0 && isl.slot < INNER_SLOTS ? isl.slot : freeSlot(new Set(l.islands.filter((i) => i !== isl).map((i) => i.slot)), true)) : where;
  if (target < 0 || target >= SLOTS.length) return l;
  const other = l.islands.find((i) => i !== isl && i.slot === target);
  if (other) other.slot = isl.slot;
  isl.slot = target;
  return l;
}

/** Brings a stored layout of any older schema forward. Unknown or broken input is rebuilt by the rules. */
export function migrateLayout(raw: unknown, bots: readonly LayoutBot[] | undefined, now: number, target = LAYOUT_SCHEMA): { layout: StudioLayout; migrated: boolean } {
  const ok = validLayout(raw);
  if (!ok) return { layout: bots ? rulesLayout(bots, now) : emptyLayout(now), migrated: true };
  let l = ok;
  let migrated = false;
  // v1 -> v2: the rooms list and the per-island stats arrived; v1 layouts had neither.
  if (l.v < 2) { l = { ...l, rooms: l.rooms?.length ? l.rooms : [...ROOM_KEYS], islands: l.islands.map((i) => ({ ...i, stats: i.stats?.length === 2 ? i.stats : i.slug === MANAGER ? [...MANAGER_STATS] : [...DEFAULT_STATS] })), v: 2 }; migrated = true; }
  if (!l.rooms.length) { l = { ...l, rooms: [...ROOM_KEYS] }; migrated = true; }
  // Later schemas add a step here. A layout from a NEWER schema than this build knows is kept as is.
  if (l.v < target) { l = { ...l, v: target }; migrated = true; }
  if (l.renderer !== RENDERER_VERSION) { l = { ...l, renderer: RENDERER_VERSION }; migrated = true; }
  if (!bots) { if (migrated) l.updatedAt = now; return { layout: l, migrated }; }
  const r = reconcileLayout(l, bots, now);
  if (migrated) r.layout.updatedAt = now;
  return { layout: r.layout, migrated: migrated || r.changed };
}

/** A layout read from disk or a model, checked field by field; undefined when it is not a layout at all. */
export function validLayout(raw: unknown): StudioLayout | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.v !== "number" || !Array.isArray(r.islands)) return undefined;
  const islands: LayoutIsland[] = [];
  const slots = new Set<number>();
  for (const x of r.islands as unknown[]) {
    if (!x || typeof x !== "object") continue;
    const i = x as Record<string, unknown>;
    const name = oneLine(i.name, MAX_NAME);
    const slug = typeof i.slug === "string" && /^[a-z0-9-]{1,48}$/.test(i.slug) ? i.slug : slugOf(name);
    if (!name || !slug || islands.some((y) => y.slug === slug)) continue;
    let slot = typeof i.slot === "number" && Number.isInteger(i.slot) && i.slot >= 0 && i.slot < SLOTS.length ? i.slot : -1;
    if (slug === MANAGER) slot = slot < 0 ? 0 : slot;
    if (slot < 0 || slots.has(slot)) slot = freeSlot(slots);
    if (slot < 0) continue;
    slots.add(slot);
    const source = (["manager", "department", "model", "user", "general"] as const).find((s) => s === i.source) ?? (slug === MANAGER ? "manager" : slug === GENERAL ? "general" : "department");
    const lk = i.locked && typeof i.locked === "object" ? (i.locked as Record<string, unknown>) : {};
    const locked: LayoutIsland["locked"] = {};
    for (const k of ["name", "color", "slot", "stats"] as const) if (lk[k] === true) locked[k] = true;
    islands.push({ slug, name, color: isPalette(i.color) ? i.color : "indigo", slot, stats: Array.isArray(i.stats) ? (i.stats as unknown[]).filter(isStat).slice(0, 2) : [], source, ...(Object.keys(locked).length ? { locked } : {}) });
  }
  const desks: Record<string, string> = {};
  if (r.desks && typeof r.desks === "object") for (const [k, s] of Object.entries(r.desks as Record<string, unknown>)) if (typeof s === "string" && islands.some((i) => i.slug === s)) desks[oneLine(k, 64)] = s;
  const strs = (a: unknown): string[] => (Array.isArray(a) ? a.filter((x): x is string => typeof x === "string").map((x) => oneLine(x, 64)) : []);
  const rooms = strs(r.rooms).filter((k): k is RoomKey => (ROOM_KEYS as readonly string[]).includes(k));
  const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : 0);
  return { v: r.v, renderer: typeof r.renderer === "string" ? r.renderer : "", builtAt: num(r.builtAt), updatedAt: num(r.updatedAt), builtBy: r.builtBy === "model" || r.builtBy === "user" ? r.builtBy : "rules", islands, desks, pinned: strs(r.pinned), rooms: !rooms.length ? [] : rooms.includes("overview") ? rooms : (["overview", ...rooms] as RoomKey[]), seen: strs(r.seen) };
}

export class LayoutEditError extends Error {}

/** One edit the user asked Dae for. Each one locks what it set, so a rebuild keeps it. */
export type LayoutEdit =
  | { op: "rename"; island: string; name: string }
  | { op: "move"; island: string; to: "brain" | "outer" | number }
  | { op: "add"; name: string; color?: string; nearBrain?: boolean }
  | { op: "remove"; island: string }
  | { op: "color"; island: string; color: string }
  | { op: "stats"; island: string; stats: string[] }
  | { op: "move_bot"; bot: string; island: string }
  | { op: "rooms"; rooms: string[] };

/** Finds an island by slug or by its name, loosely ("the sales island", "Sales"). */
export function findIsland(l: StudioLayout, q: unknown): LayoutIsland | undefined {
  const s = slugOf(String(q ?? "").replace(/\b(the|island|department|team)\b/gi, " "));
  if (!s) return undefined;
  return l.islands.find((i) => i.slug === s) ?? l.islands.find((i) => slugOf(i.name) === s) ?? l.islands.find((i) => i.slug.startsWith(s) || s.startsWith(i.slug));
}

export function applyEdit(prev: StudioLayout, e: LayoutEdit, bots: readonly LayoutBot[], now: number): StudioLayout {
  let l = structuredClone(prev);
  const need = (q: unknown) => { const i = findIsland(l, q); if (!i) throw new LayoutEditError(`no island "${String(q)}"; the islands are ${l.islands.map((x) => x.name).join(", ")}`); return i; };
  switch (e.op) {
    case "rename": { const i = need(e.island); const n = oneLine(e.name, MAX_NAME); if (!n) throw new LayoutEditError("the new name is empty"); i.name = n; i.locked = { ...i.locked, name: true }; break; }
    case "move": {
      const i = need(e.island);
      if (e.to === "brain") l = moveIsland(l, i.slug, "brain");
      else if (e.to === "outer") { const used = new Set(l.islands.map((x) => x.slot)); let s = -1; for (let k = INNER_SLOTS; k < SLOTS.length; k++) if (!used.has(k)) { s = k; break; } if (s < 0) throw new LayoutEditError("the outer ring is full"); i.slot = s; }
      else if (typeof e.to === "number" && Number.isInteger(e.to) && e.to > 0 && e.to < SLOTS.length) l = moveIsland(l, i.slug, e.to);
      else throw new LayoutEditError("move to \"brain\", \"outer\" or a slot number 1-23");
      const moved = l.islands.find((x) => x.slug === i.slug)!; moved.locked = { ...moved.locked, slot: true };
      break;
    }
    case "add": {
      const n = oneLine(e.name, MAX_NAME); const slug = slugOf(n);
      if (!n || !slug) throw new LayoutEditError("the department needs a name");
      if (l.islands.some((x) => x.slug === slug)) throw new LayoutEditError(`"${n}" is already an island`);
      if (l.islands.length >= MAX_ISLANDS) throw new LayoutEditError(`the office holds at most ${MAX_ISLANDS} islands`);
      const used = new Set(l.islands.map((x) => x.slot)); const slot = freeSlot(used, !!e.nearBrain);
      if (slot < 0) throw new LayoutEditError("no free place on the floor");
      l.islands.push({ slug, name: n, color: isPalette(e.color) ? e.color : freeColor(l.islands.map((x) => x.color)), slot, stats: [...DEFAULT_STATS], source: "user", locked: { name: true, ...(isPalette(e.color) ? { color: true as const } : {}) } });
      break;
    }
    case "remove": {
      const i = need(e.island);
      if (i.slug === MANAGER) throw new LayoutEditError("the Manager office stays: it is where your main Daebot sits");
      if (bots.some((b) => departmentIsland(b).slug === i.slug)) throw new LayoutEditError(`bots still have "${i.name}" as their department; change their department first`);
      l.islands = l.islands.filter((x) => x !== i);
      for (const [k, s] of Object.entries(l.desks)) if (s === i.slug) { delete l.desks[k]; l.pinned = l.pinned.filter((x) => x !== k); }
      break;
    }
    case "color": { const i = need(e.island); if (!isPalette(e.color)) throw new LayoutEditError(`colours: ${PALETTE.join(", ")}`); i.color = e.color; i.locked = { ...i.locked, color: true }; break; }
    case "stats": { const i = need(e.island); const st = (e.stats ?? []).filter(isStat).slice(0, 2); if (st.length !== 2) throw new LayoutEditError(`pick two of: ${STAT_KEYS.join(", ")} or counter:<name>`); i.stats = st; i.locked = { ...i.locked, stats: true }; break; }
    case "move_bot": {
      const i = need(e.island);
      const q = String(e.bot ?? "").toLowerCase().trim();
      const b = bots.find((x) => x.id === e.bot) ?? bots.find((x) => x.name.toLowerCase() === q) ?? bots.find((x) => x.name.toLowerCase().includes(q) && q.length > 1);
      if (!b) throw new LayoutEditError(`no bot "${String(e.bot)}"`);
      l.desks[b.id] = i.slug; if (!l.pinned.includes(b.id)) l.pinned.push(b.id);
      break;
    }
    case "rooms": { const rs = (e.rooms ?? []).filter((k): k is RoomKey => (ROOM_KEYS as readonly string[]).includes(k)); l.rooms = rs.includes("overview") ? rs : ["overview", ...rs]; break; }
    default: throw new LayoutEditError("unknown edit");
  }
  const r = reconcileLayout(l, bots, now);
  r.layout.updatedAt = now;
  return r.layout;
}

/** The prompt that asks a model to plan the office. The answer must be JSON only; applyModelPlan checks every field. */
export function plannerMessages(bots: readonly LayoutBot[], facts: { counters: Record<string, string[]> }): { role: "system" | "user"; content: string }[] {
  const lines = bots.slice(0, 60).map((b) => `- id ${b.id} · ${oneLine(b.name, 40)} · department ${oneLine(b.department, 40) || "(none)"} · ${oneLine(b.purpose, 120)}${facts.counters[b.id]?.length ? ` · counters: ${facts.counters[b.id].join(", ")}` : ""}`);
  return [
    { role: "system", content: `You plan an isometric "agents office" for a user's AI bots. Departments are islands around a central Brain. Reply with JSON only, no prose: {"islands":[{"name":"...","members":["botId",...],"color":"${PALETTE.join("|")}","stats":["key","key"],"nearBrain":true|false}]}. Rules: a bot that already has a department keeps it (do not list it in members, but you may still give that department's island a colour, two stats and nearBrain). Group bots with department "(none)" into a few clear islands named by what they do (2-3 words, max ${MAX_NAME} characters), or leave them out to keep them on "General". stats are exactly two of: ${STAT_KEYS.join(", ")}, or "counter:<name>" for a counter a bot listed. Use "manager-office" as the name to style the main Daebot's island. At most ${MAX_ISLANDS} islands; mark the busiest 2-4 nearBrain.` },
    { role: "user", content: `The bots:\n${lines.join("\n") || "(no bots yet)"}` },
  ];
}

/** Pulls the first JSON object out of a model reply. */
export function parsePlan(text: string): unknown {
  const s = String(text ?? "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return undefined;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return undefined; }
}
