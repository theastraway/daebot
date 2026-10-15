// Daebot brand runtime. Standalone module (loaded from index.html) so app.js stays untouched.
//  1. Header badge: reads the optional `model` field of GET /health and renders "Qwen 3.8 Flash · via OpenRouter".
//     Renders nothing when the field is missing.
//  2. Tags the app's "Thinking" notice so CSS can draw the dot-matrix LED indicator.

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
