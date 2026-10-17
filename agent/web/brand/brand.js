// Daebot brand runtime. Standalone module (loaded from index.html) so app.js stays untouched.
//  1. Header badge: reads the optional `model` field of GET /health and renders "Qwen 3.8 Flash · via OpenRouter".
//     Renders nothing when the field is missing.
//  2. Tags the app's "Thinking" notice so CSS can draw the dot-matrix LED indicator.
//  3. The live mascot (<m-bot>, /brand/mbot.js): a big hero on the empty screen, a docked bot that reacts to the
//     conversation (thinks, talks while text streams, grins when done, alarms on a kernel gate). Assistant
//     avatars use the still /brand/daebot-avatar.png. All driven by watching the transcript DOM, so app.js stays untouched.

import "./mbot.js";

const badge = document.getElementById("model-badge");
const nameEl = document.getElementById("mb-name");
const viaEl = document.getElementById("mb-via");

const titleCase = (s) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase());

/** "qwen/qwen3.8-flash:free" -> { name: "Qwen 3.8 Flash (free)", via: "OpenRouter" } */
export function describeModel(health) {
  let m = health && health.model;
  if (!m) return null;
  let provider = health.provider || health.via || null;
  if (typeof m === "object") { provider = m.provider || m.via || provider; m = m.name || m.label || m.id; }
  if (typeof m !== "string" || !m.trim()) return null;
  let id = m.trim();
  const slash = id.indexOf("/");
  if (slash > 0 && !provider) provider = "OpenRouter"; // vendor/model ids are OpenRouter's naming
  if (slash > 0) id = id.slice(slash + 1);
  let free = false;
  id = id.replace(/:free$/i, () => { free = true; return ""; });
  const pretty = /\s/.test(id) ? id : titleCase(id.replace(/[-_]+/g, " ").replace(/([a-z])(\d)/gi, "$1 $2").trim());
  return { name: pretty + (free ? " (free)" : ""), via: provider ? String(provider) : null };
}

function render(health) {
  if (!badge) return;
  if (badge.dataset.owned === "1") return; // /models.js owns the label once it has one (the model actually served)
  const d = describeModel(health);
  if (!d) { badge.hidden = true; return; }
  nameEl.textContent = d.name;
  viaEl.textContent = d.via ? ` · via ${d.via}` : "";
  badge.title = d.via ? `${d.name} via ${d.via}` : d.name;
  badge.hidden = false;
}

async function poll() {
  try {
    const r = await fetch("/health", { cache: "no-store" });
    if (r.ok) render(await r.json());
  } catch { /* offline: keep whatever is shown */ }
}
poll();
setInterval(poll, 60000);
addEventListener("focus", poll);

// "Thinking" notice -> LED indicator
const thread = document.getElementById("thread");
if (thread) {
  const tag = (n) => { if (n.nodeType === 1 && n.classList.contains("notice") && /^Thinking/.test(n.textContent)) n.classList.add("thinking"); };
  new MutationObserver((muts) => { for (const m of muts) m.addedNodes.forEach(tag); }).observe(thread, { childList: true });
  thread.querySelectorAll(".notice").forEach(tag);
}

// ---------------------------------------------------------------- live mascot
const main = document.querySelector(".main");
const dock = document.createElement("div");
dock.className = "bot-dock";
dock.setAttribute("aria-hidden", "true");
const bot = document.createElement("m-bot");
bot.setAttribute("playful", "");
dock.append(bot);
if (main) main.append(dock);

function heroize() {
  const empty = thread && thread.querySelector(".empty");
  if (empty && !empty.querySelector("m-bot")) {
    const hero = document.createElement("m-bot");
    hero.className = "hero-bot"; hero.setAttribute("intro", ""); hero.setAttribute("playful", "");
    if (document.body.dataset.botAccent) hero.setAttribute("accent", document.body.dataset.botAccent); // a bot thread: its own LED colour
    empty.prepend(hero);
  }
  dock.classList.toggle("show", !!thread && !empty && thread.children.length > 0);
}

let wasStreaming = false;
function react(muts) {
  for (const m of muts) {
    for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.classList.contains("gate")) bot.flash("alert", 2600);
      else if (n.classList.contains("confirm")) bot.flash("wow", 2200);
      else if (n.classList.contains("notice") && n.classList.contains("warn")) bot.flash("sad", 2200);
    }
    if (m.type === "characterData" || (m.type === "childList" && m.target.closest && m.target.closest(".msg-asst.streaming"))) bot.say(320);
  }
  const streaming = !!(thread && thread.querySelector(".msg-asst.streaming"));
  const thinking = !!(thread && thread.querySelector(".notice.thinking"));
  if (streaming) { if (bot.mood !== "alert") bot.mood = "talk"; }
  else if (wasStreaming) bot.flash("happy", 1500);
  else if (thinking) bot.mood = "think";
  else if (bot.mood === "talk" || bot.mood === "think") bot.mood = "idle";
  wasStreaming = streaming;
  heroize();
}
if (thread) {
  new MutationObserver(react).observe(thread, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class"] });
  heroize();
}

