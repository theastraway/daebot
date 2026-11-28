// The opening of a new chat: "Good evening, Anthony.", one or two lines of what actually needs them (from their MIND: to-dos,
// priorities, email), and three starters drawn from that. The greeting paints at once (the last brief is kept per bot in localStorage);
// GET /home/brief fills in the rest when it arrives. No innerHTML.

const MEM_MS = 2 * 60_000;      // a brief this fresh is not fetched again when another new chat opens
const STORE = "daebot:brief:";   // + bot slug

/** "Good morning" / "Good afternoon" / "Good evening" / "Up late" for a local hour, with the name when known. */
export function greetingFor(date, name) {
  const hr = date.getHours();
  const g = hr < 5 ? "Up late" : hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening";
  const n = typeof name === "string" && /^[A-Za-z'’-]{1,30}$/.test(name.trim()) ? name.trim() : "";
  return n ? `${g}, ${n}` : g;
}

/** The user's local date for the brief writer: "Friday, November 27, 2026". */
export function todayString(date) {
  try { return date.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }); } catch { return date.toDateString(); }
}

function readStored(slug) {
  try { const j = JSON.parse(localStorage.getItem(STORE + slug) || "null"); return j && typeof j === "object" ? j : null; } catch { return null; }
}
function writeStored(slug, b) {
  try { localStorage.setItem(STORE + slug, JSON.stringify(b)); } catch { /* private mode */ }
}

/** A brief from the server, kept to the shape the page renders (labels and prompts are text, never markup). */
export function cleanBrief(b) {
  if (!b || typeof b !== "object") return null;
  const starters = (Array.isArray(b.starters) ? b.starters : [])
    .filter((s) => s && typeof s.label === "string" && typeof s.prompt === "string" && s.label.trim() && s.prompt.trim())
    .slice(0, 3).map((s) => ({ label: s.label.slice(0, 60), prompt: s.prompt.slice(0, 400) }));
  return { name: typeof b.name === "string" ? b.name.slice(0, 30) : "", line: typeof b.line === "string" ? b.line.slice(0, 260) : "", starters, at: Number(b.at) || Date.now() };
}

export function createOpening({ json, now = () => new Date() }) {
  const mem = new Map();      // slug -> { at, brief }
  const inflight = new Map(); // slug -> Promise
  return {
    /** The best brief we already hold for this bot (memory, then the last one saved in this browser), or null. */
    cached(slug) { return mem.get(slug)?.brief || readStored(slug); },
    /** Fetch the brief (deduped; skipped when one under two minutes old is in memory). Resolves null on failure. */
    load(slug, fresh = false) {
      const m = mem.get(slug);
      if (!fresh && m && Date.now() - m.at < MEM_MS) return Promise.resolve(m.brief);
      if (inflight.has(slug)) return inflight.get(slug);
      const q = new URLSearchParams({ bot: slug, today: todayString(now()) });
      if (fresh) q.set("fresh", "1");
      const p = json(`/home/brief?${q}`).then((raw) => {
        const b = cleanBrief(raw);
        if (b && !b.name) b.name = (mem.get(slug)?.brief || readStored(slug) || readStored("main") || {}).name || ""; // the name never changes
        if (b) { mem.set(slug, { at: Date.now(), brief: b }); if (b.line || b.starters.length || b.name) writeStored(slug, b); }
        return b;
      }).catch(() => null).finally(() => inflight.delete(slug));
      inflight.set(slug, p);
      return p;
    },
  };
}

/**
 * Paint the opening into `box`. brief may be null (first visit, still loading): the greeting shows alone with a quiet "checking" line.
 * onStart(prompt) sends a starter. loading: true while the fetch is still out.
 */
export function paintOpening(box, brief, { h, onStart, loading = false, date = new Date() }) {
  box.replaceChildren();
  box.append(h("h2", "", `${greetingFor(date, brief && brief.name)}.`));
  if (brief && brief.line) box.append(h("p", "opening-line", brief.line));
  else if (loading) box.append(h("p", "opening-line opening-wait", "Checking what needs you…"));
  else box.append(h("p", "opening-line", "What should we work on?"));
  const starters = brief && brief.starters && brief.starters.length ? brief.starters : [];
  if (starters.length) {
    const row = h("div", "opening-starters");
    for (const s of starters) {
      const b = h("button", "opening-starter", s.label);
      b.type = "button";
      b.title = s.prompt;
      b.addEventListener("click", () => onStart(s.prompt));
      row.append(b);
    }
    box.append(row);
  }
  box.classList.toggle("loading", !!loading);
}
