// The gift button in the sidebar's bottom bar and its modal: "Give MIND to a friend who loves AI".
// The illustration is a cluster of our own M Daebot mascots, each in a different colour with a different LED face.
// No referral link is built here: MIND's referral code is only reachable with a MIND web login, not with the key Daebot holds,
// so the modal sends people to the plain link and promises nothing (no credits, no free weeks).
// DOM only: createElement and setAttribute, no HTML strings.

import { mascotFor, wakeOn } from "./mbadge.js";

export const GIFT_LINK = "https://daebot.live";
export const GIFT_TEXT = "MIND and Daebot: an AI agent that remembers. Worth a look if you love AI.";

/** The mascots in the illustration: a face from the faces module and its LED colour each. Order is left to right. */
export const GIFT_CAST = [
  { face: "closer", color: "#ff7ad9" },
  { face: "researcher", color: "#5ee0ff" },
  { face: "coach", color: "#7dff9a" },
  { face: "creator", color: "#ffd25a" },
  { face: "skeptic", color: "#a98bff" },
];

/** The x.com post-composer link for `link` with short copy (pure). */
export function xIntentUrl(link = GIFT_LINK, text = GIFT_TEXT) {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(link)}`;
}

export function initGift() {
  const $ = (id) => document.getElementById(id);
  const q = { open: $("btn-gift"), card: $("gift-modal"), close: $("gift-close"), art: $("gift-art"), share: $("gift-x"), copy: $("gift-copy"), copyText: $("gift-copy-text"), live: $("gift-live") };
  if (!q.open || !q.card) return null;
  let built = false, last = null, timer = 0;

  function build() {
    if (built) return;
    built = true;
    GIFT_CAST.forEach((c, i) => {
      const m = mascotFor({ face: c.face, color: c.color });
      m.classList.add("gift-m", `gift-m${i + 1}`);
      wakeOn(m, m);
      q.art.append(m);
    });
    q.share.href = xIntentUrl();
  }
  function open() {
    build();
    last = document.activeElement;
    q.card.hidden = false;
    q.open.setAttribute("aria-expanded", "true");
    q.close.focus();
  }
  function close() {
    q.card.hidden = true;
    q.open.setAttribute("aria-expanded", "false");
    if (last && last.focus) last.focus();
  }
  async function copy() {
    let ok = false;
    try { await navigator.clipboard.writeText(GIFT_LINK); ok = true; } catch {
      const t = document.createElement("textarea");
      t.value = GIFT_LINK; t.setAttribute("readonly", ""); t.className = "sr-only";
      document.body.append(t); t.select();
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      t.remove();
    }
    q.copyText.textContent = ok ? "Copied" : "Copy failed";
    q.live.textContent = ok ? "Link copied" : "Could not copy the link";
    clearTimeout(timer);
    timer = setTimeout(() => { q.copyText.textContent = "Copy link"; q.live.textContent = ""; }, 1800);
  }

  q.open.addEventListener("click", open);
  q.close.addEventListener("click", close);
  q.card.addEventListener("click", (e) => { if (e.target === q.card) close(); });
  q.copy.addEventListener("click", copy);
  q.card.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); return; }
    if (e.key !== "Tab") return;
    const f = [...q.card.querySelectorAll("button, a[href]")].filter((n) => n.offsetParent !== null);
    if (!f.length) return;
    const a = f[0], z = f[f.length - 1];
    if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
    else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
  });
  return { open, close };
}
