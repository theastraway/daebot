// The routine clock: parse a 5-field expression (minute hour day-of-month month day-of-week), find the next run in an IANA time zone,
// and say it back in plain words. Pure functions, no timers and no I/O. When BOTH day-of-month and day-of-week are restricted,
// a day matches if EITHER does (standard behaviour). A wall time that does not exist (spring-forward gap) is skipped for that day;
// an ambiguous one (fall-back) runs once, at its first instance.

export class TimingError extends Error {}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const ALIASES: Record<string, string> = { "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *" };

interface Parsed { text: string; min: number[]; hour: number[]; dom: number[]; mon: number[]; dow: number[]; domStar: boolean; dowStar: boolean }

function field(raw: string, lo: number, hi: number, names: string[] | undefined, base: number, label: string): { values: number[]; star: boolean } {
  const out = new Set<number>();
  let star = false;
  const num = (s: string): number => {
    const l = s.toLowerCase();
    if (names && /^[a-z]{3,}$/.test(l)) { const i = names.indexOf(l.slice(0, 3)); if (i >= 0) return i + base; }
    if (!/^\d{1,2}$/.test(s)) throw new TimingError(`${label}: "${s.slice(0, 12)}" is not a number${names ? " or name" : ""}`);
    return Number(s);
  };
  for (const part of raw.split(",")) {
    if (!part) throw new TimingError(`${label}: empty item`);
    const [rangeRaw, stepRaw, extra] = part.split("/");
    if (extra !== undefined) throw new TimingError(`${label}: too many "/"`);
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d{1,3}$/.test(stepRaw) || Number(stepRaw) < 1) throw new TimingError(`${label}: a step must be a whole number of 1 or more`);
      step = Number(stepRaw);
    }
    let a: number, b: number;
    if (rangeRaw === "*") { a = lo; b = hi; if (stepRaw === undefined) star = true; }
    else if (rangeRaw.includes("-")) {
      const [x, y, z] = rangeRaw.split("-");
      if (z !== undefined || !x || !y) throw new TimingError(`${label}: bad range "${rangeRaw.slice(0, 20)}"`);
      a = num(x); b = num(y);
    } else { a = num(rangeRaw); b = stepRaw !== undefined ? hi : a; }
    if (a < lo || a > hi || b < lo || b > hi) throw new TimingError(`${label}: ${rangeRaw.slice(0, 20)} is outside ${lo}-${hi}`);
    if (a > b) throw new TimingError(`${label}: range ${a}-${b} runs backwards`);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  if (label === "day of week" && out.delete(7)) out.add(0);
  return { values: [...out].sort((x, y) => x - y), star };
}

export function parseTiming(expr: unknown): Parsed {
  if (typeof expr !== "string") throw new TimingError('the timing must be text like "0 9 * * 1-5"');
  const text = ALIASES[expr.trim().toLowerCase()] ?? expr.trim().replace(/\s+/g, " ");
  if (!text) throw new TimingError("the timing is empty");
  if (text.length > 100) throw new TimingError("the timing is too long");
  const f = text.split(" ");
  if (f.length !== 5) throw new TimingError(`a timing has 5 fields (minute hour day-of-month month day-of-week); this has ${f.length}`);
  const min = field(f[0], 0, 59, undefined, 0, "minute");
  const hour = field(f[1], 0, 23, undefined, 0, "hour");
  const dom = field(f[2], 1, 31, undefined, 0, "day of month");
  const mon = field(f[3], 1, 12, MONTHS, 1, "month");
  const dow = field(f[4], 0, 7, DAYS, 0, "day of week");
  return { text, min: min.values, hour: hour.values, dom: dom.values, mon: mon.values, dow: dow.values, domStar: dom.star, dowStar: dow.star };
}

export function validTz(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ord = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
const clock = (h: number, m: number): string => `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
const words = (p: string[]): string => (p.length <= 1 ? p.join("") : `${p.slice(0, -1).join(", ")} and ${p[p.length - 1]}`);
export const tzLabel = (tz: string): string => (tz.split("/").pop() ?? tz).replace(/_/g, " ");

/** "every weekday at 9:00 AM New York". Unusual shapes fall back to the expression itself. */
export function describeTiming(expr: string, tz: string): string {
  let s: Parsed;
  try { s = parseTiming(expr); } catch { return expr; }
  const where = tzLabel(tz);
  const oneMin = s.min.length === 1, oneHour = s.hour.length === 1;
  const step = (v: number[], max: number): number | undefined => (v.length > 1 && v[0] === 0 && max % v[1] === 0 && v.every((x, i) => x === i * v[1]) ? v[1] : undefined);
  const allDays = s.domStar && s.dowStar && s.mon.length === 12;
  if (allDays && s.hour.length === 24 && s.min.length === 60) return "every minute";
  if (allDays && s.hour.length === 24 && step(s.min, 60)) return `every ${step(s.min, 60)} minutes`;
  if (allDays && s.hour.length === 24 && oneMin) return s.min[0] === 0 ? "every hour, on the hour" : `every hour at :${String(s.min[0]).padStart(2, "0")}`;
  if (allDays && oneMin && oneHour) return `every day at ${clock(s.hour[0], s.min[0])} ${where}`;
  if (s.domStar && s.mon.length === 12 && oneMin && oneHour) {
    const t = clock(s.hour[0], s.min[0]);
    if (s.dow.length === 5 && s.dow[0] === 1 && s.dow[4] === 5) return `every weekday at ${t} ${where}`;
    return `every ${words(s.dow.map((d) => DAY_NAMES[d]))} at ${t} ${where}`;
  }
  if (s.dowStar && s.mon.length === 12 && oneMin && oneHour) return `on the ${words(s.dom.map(ord))} of every month at ${clock(s.hour[0], s.min[0])} ${where}`;
  return `on the timing "${s.text}" (${where} time)`;
}

// ---------------------------------------------------------------- time zones
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmtFor(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }); fmtCache.set(tz, f); }
  return f;
}
export interface Wall { y: number; mo: number; d: number; h: number; mi: number }
export function wallOf(ms: number, tz: string): Wall {
  const o: Record<string, number> = {};
  for (const p of fmtFor(tz).formatToParts(new Date(ms))) if (p.type !== "literal") o[p.type] = Number(p.value);
  return { y: o.year, mo: o.month, d: o.day, h: o.hour === 24 ? 0 : o.hour, mi: o.minute };
}
const wallMs = (w: Wall): number => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
const offsetAt = (ms: number, tz: string): number => wallMs(wallOf(ms, tz)) - Math.floor(ms / 60000) * 60000;
/** The instant whose wall clock in `tz` reads `w`; undefined when that wall time does not exist. */
export function instantOfWall(w: Wall, tz: string): number | undefined {
  const t = wallMs(w);
  let off = offsetAt(t, tz);
  let res = t - off;
  const off2 = offsetAt(res, tz);
  if (off2 !== off) { off = off2; res = t - off; }
  return wallMs(wallOf(res, tz)) === t ? res : undefined;
}

const MINUTE = 60_000;
function dayMatches(s: Parsed, y: number, mo: number, d: number): boolean {
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  const domOk = s.dom.includes(d), dowOk = s.dow.includes(dow);
  if (s.domStar && s.dowStar) return true;
  if (s.domStar) return dowOk;
  if (s.dowStar) return domOk;
  return domOk || dowOk;
}

/** The first run strictly after `afterMs`, minute precision, or undefined if none within ~8 years. */
export function nextRun(expr: Parsed | string, tz: string, afterMs: number): number | undefined {
  const s = typeof expr === "string" ? parseTiming(expr) : expr;
  const start = Math.floor(afterMs / MINUTE) * MINUTE + MINUTE;
  const startWall = wallMs(wallOf(start, tz));
  let wall = startWall;
  for (let guard = 0; guard < 200_000; guard++) {
    const t = new Date(wall);
    const y = t.getUTCFullYear(), mo = t.getUTCMonth() + 1, d = t.getUTCDate(), h = t.getUTCHours(), mi = t.getUTCMinutes();
    if (wall - startWall > 8 * 366 * 86_400_000) return undefined;
    if (!s.mon.includes(mo)) { wall = Date.UTC(y, mo, 1, 0, 0); continue; }
    if (!dayMatches(s, y, mo, d)) { wall = Date.UTC(y, mo - 1, d + 1, 0, 0); continue; }
    if (!s.hour.includes(h)) { wall = Date.UTC(y, mo - 1, d, h + 1, 0); continue; }
    const m = s.min.find((x) => x >= mi);
    if (m === undefined) { wall = Date.UTC(y, mo - 1, d, h + 1, 0); continue; }
    if (m !== mi) { wall = Date.UTC(y, mo - 1, d, h, m); continue; }
    const inst = instantOfWall({ y, mo, d, h, mi }, tz);
    if (inst !== undefined && inst >= start) return inst;
    wall += MINUTE;
  }
  return undefined;
}

export function nextRuns(expr: Parsed | string, tz: string, afterMs: number, n: number): number[] {
  const s = typeof expr === "string" ? parseTiming(expr) : expr;
  const out: number[] = [];
  let at = afterMs;
  for (let i = 0; i < n; i++) { const r = nextRun(s, tz, at); if (r === undefined) break; out.push(r); at = r; }
  return out;
}
