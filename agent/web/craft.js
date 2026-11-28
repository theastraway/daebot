// Craft mode in the composer: a "Chat | Craft" switch per chat (remembered on this device), and the live scorecard a loop shows in
// the thread. A Craft send is a normal turn with capability "craft": the server runs the message as a loop (bar 9, the rubric picked
// from the goal) and streams `loop` events, each a full snapshot (src/types.ts LoopProgress). The card is the Live room's loop card
// language (studio.js: the rail, elapsed time) brought into the chat. DOM only (createElement + textContent), theme tokens only.
import { loopRail, elapsedText } from "./studio.js";

export const CRAFT_PLACEHOLDER = "Describe what to make — Daebot builds it until it scores 9/10";
export const CHAT_PLACEHOLDER = "Message Daebot";
export const CRAFT_CAP = "craft";
const KEY = (id) => `daebot:craft:${id}`;

/** Is Craft on for this chat? Default Chat (off). Storage can be missing or throw (private window): then it is off. */
export function craftOn(storage, id) {
  if (!id) return false;
  try { return storage.getItem(KEY(id)) === "1"; } catch { return false; }
}
export function setCraft(storage, id, on) {
  if (!id) return;
  try { if (on) storage.setItem(KEY(id), "1"); else storage.removeItem(KEY(id)); } catch { /* not remembered: still on for this send */ }
}
/** A new chat gets its id on the first send: its draft's choice moves to the real id. */
export function moveCraft(storage, from, to) {
  if (!from || !to || from === to) return;
  const on = craftOn(storage, from);
  setCraft(storage, from, false);
  if (on) setCraft(storage, to, true);
}

const fmt = (n) => (Number.isFinite(n) ? (Math.round(n * 10) / 10).toFixed(1) : "–");
const rounds = (n) => `${n} round${n === 1 ? "" : "s"}`;

/** The finish line: "Cleared 9.2 in 3 rounds" or "Best 8.4 after 3 rounds — the weakest was polish". Empty while running. */
export function finishText(l) {
  if (!l || !l.done) return "";
  const s = Array.isArray(l.scores) ? l.scores : [];
  if (!s.length) return l.phase === "stopped" ? "Stopped before the first grade" : "No round was graded";
  if (l.phase === "cleared") return `Cleared ${fmt(s[s.length - 1])} in ${rounds(s.length)}`;
  return `Best ${fmt(Math.max(...s))} after ${rounds(s.length)}${l.weakest ? ` — the weakest was ${l.weakest}` : ""}`;
}

const PHASE = { study: "Studying MIND", build: "Building", grade: "Grading", cleared: "Cleared", stopped: "Stopped", failed: "Failed" };

/** Everything the card shows, from one snapshot (pure: the tests read it). */
export function scorecardModel(l, now = Date.now()) {
  const cycles = Math.max(1, Number(l && l.cycles) || 1);
  const scores = Array.isArray(l && l.scores) ? l.scores : [];
  const cats = l && l.categories && typeof l.categories === "object" ? l.categories : {};
  const names = Object.keys(cats).length ? Object.keys(cats) : (Array.isArray(l && l.rubric) ? l.rubric : []);
  const graded = Object.keys(cats).length > 0;
  const weakest = graded ? (l.weakest && l.weakest in cats ? l.weakest : names.slice().sort((a, b) => cats[a] - cats[b])[0]) : undefined;
  const round = Math.min(cycles, Math.max(Number(l && l.cycle) || 0, scores.length, 1));
  const like = l && l.likeness;
  return {
    goal: String((l && l.goal) || ""),
    phase: (l && l.phase) || "study",
    phaseLabel: PHASE[l && l.phase] || "Working",
    round: `Round ${round} of ${cycles}`,
    bar: Number(l && l.bar) || 9,
    last: scores.length ? scores[scores.length - 1] : null,
    categories: names.map((name) => ({ name, score: graded ? Number(cats[name]) : null, weakest: name === weakest })),
    rail: loopRail({ maxCycles: cycles, bar: Number(l && l.bar) || 9, scores, cycle: Number(l && l.cycle) || 0, endedAt: l && l.done ? (l.endedAt || 1) : 0 }),
    elapsed: elapsedText((l && l.done && l.endedAt ? l.endedAt : now) - (Number(l && l.startedAt) || now)),
    finish: finishText(l),
    likeness: like ? (like.measured && Number.isFinite(like.similarity) ? `likeness ${fmt(like.similarity)}%${Array.isArray(like.widths) && like.widths.length ? ` · ${like.widths.map((w) => `${w.width}px ${Math.round(w.similarity)}%`).join(" · ")}` : ""}` : `likeness: ${String(like.note || "not measured here").replace(/^likeness:\s*/i, "")}`) : "",
    done: !!(l && l.done),
    branch: (l && l.branch) || "",
  };
}

/** The scorecard: built once per loop, then `update(snapshot)` repaints it in place. A ticking clock while it runs. */
export function buildScorecard(loop, { h, now = () => Date.now() } = {}) {
  const card = h("section", "craft-card");
  card.setAttribute("aria-label", "Craft scorecard");
  const top = h("div", "craft-top");
  const phase = h("span", "craft-phase");
  const round = h("span", "craft-round");
  const time = h("span", "craft-time");
  top.append(phase, round, time);
  const goal = h("div", "craft-goal");
  const scoreRow = h("div", "craft-score");
  const big = h("b", "craft-big");
  const barText = h("span", "craft-bar");
  scoreRow.append(big, barText);
  const rail = h("div", "craft-rail");
  rail.setAttribute("role", "img");
  const cats = h("ul", "craft-cats");
  const like = h("p", "craft-like");
  const finish = h("p", "craft-finish");
  finish.setAttribute("role", "status");
  card.append(top, goal, scoreRow, rail, cats, like, finish);
  let cur = loop, timer = null;

  function paint() {
    const m = scorecardModel(cur, now());
    card.className = `craft-card ${m.done ? m.phase : "running"}`;
    phase.className = `craft-phase ${m.phase}`; phase.textContent = m.phaseLabel;
    round.textContent = m.round;
    time.textContent = m.elapsed;
    goal.textContent = m.goal;
    big.textContent = m.last === null ? "–" : fmt(m.last);
    barText.textContent = `/ 10 · bar ${m.bar}`;
    rail.replaceChildren();
    rail.setAttribute("aria-label", `${m.round}. ${m.rail.map((r, i) => `Round ${i + 1}: ${r.score !== undefined ? `${r.score} of 10` : r.kind === "now" ? "in progress" : "to do"}`).join(". ")}`);
    for (const r of m.rail) {
      const seg = h("i", `craft-seg ${r.kind}`);
      if (r.score !== undefined) { seg.style.setProperty("--fill", `${Math.max(4, Math.min(100, r.score * 10))}%`); seg.title = `${r.score}/10`; }
      rail.append(seg);
    }
    cats.replaceChildren();
    for (const c of m.categories) {
      const li = h("li", `craft-cat${c.weakest ? " weakest" : ""}`);
      const name = h("span", "craft-cat-name", c.name);
      const meter = h("span", "craft-meter"); meter.setAttribute("aria-hidden", "true");
      const fill = h("i", ""); fill.style.width = `${c.score === null ? 0 : Math.max(0, Math.min(100, c.score * 10))}%`; meter.append(fill);
      const val = h("b", "craft-cat-val", c.score === null ? "–" : fmt(c.score));
      li.append(name, meter, val);
      if (c.weakest) { li.append(h("small", "craft-weak", "weakest")); li.setAttribute("aria-label", `${c.name}: ${fmt(c.score)} of 10, the weakest`); }
      cats.append(li);
    }
    cats.hidden = !m.categories.length;
    like.textContent = m.likeness; like.hidden = !m.likeness;
    finish.textContent = m.finish; finish.hidden = !m.finish;
    if (m.done && timer) { clearInterval(timer); timer = null; }
  }
  function tick() {
    if (!card.isConnected && timer && card.dataset.seen) { clearInterval(timer); timer = null; return; }
    if (card.isConnected) card.dataset.seen = "1";
    time.textContent = scorecardModel(cur, now()).elapsed;
  }
  paint();
  if (!cur || !cur.done) timer = setInterval(tick, 1000);
  card.update = (next) => { cur = next; paint(); if (!next.done && !timer) timer = setInterval(tick, 1000); };
  return card;
}

/**
 * The "Chat | Craft" switch: two radio buttons in one group. `getKey()` is the chat on screen; the choice is kept per chat.
 * `onChange(on)` lets the page repaint the placeholder.
 */
export function initCraftSwitch({ h, mount, storage, getKey, onChange }) {
  if (!mount) return { render() {}, on: () => false };
  const group = h("div", "craft-switch");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", "Chat or Craft");
  const mk = (label, craft, title) => {
    const b = h("button", "craft-opt", label); b.type = "button"; b.setAttribute("role", "radio"); b.title = title;
    b.addEventListener("click", () => { setCraft(storage, getKey(), craft); render(); onChange && onChange(craft); });
    b.addEventListener("keydown", (e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); const other = craft ? chat : craftBtn; other.click(); other.focus(); } });
    return b;
  };
  const chat = mk("Chat", false, "Chat: a normal reply");
  const craftBtn = mk("Craft", true, "Craft: Daebot builds it, a separate grader scores it, and it goes again until it clears 9/10");
  group.append(chat, craftBtn);
  mount.append(group);
  function render() {
    const on = craftOn(storage, getKey());
    chat.setAttribute("aria-checked", String(!on)); chat.tabIndex = on ? -1 : 0;
    craftBtn.setAttribute("aria-checked", String(on)); craftBtn.tabIndex = on ? 0 : -1;
    group.classList.toggle("is-craft", on);
  }
  render();
  return { render, on: () => craftOn(storage, getKey()) };
}
