// The gift button in the sidebar's bottom bar and its modal: "Give MIND to a friend who loves AI".
// The illustration is a cluster of our own M Daebot mascots, each in a different colour with a different LED face.
// The link is the signed-in user's own MIND referral link from GET /apps/referral (the gateway asks MIND with their key), and the line
// under the title states MIND's real terms from the same answer. If that fails (or it is the owner login) the modal falls back to the
// plain link and the neutral line, and promises nothing.
// DOM only: createElement and setAttribute, no HTML strings.

import { mascotFor, wakeOn } from "./mbadge.js";

export const GIFT_LINK = "https://daebot.live";
export const GIFT_NEUTRAL_LINE = "Send them a link to MIND and Daebot.";
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

/** The line under the title for MIND's real terms, e.g. "They get 50 free credits, you get 100 when they join." (pure). Neutral when the amounts are not usable. */
export function termsLine(ref) {
  const ok = (v) => Number.isInteger(v) && v > 0;
  return ref && ok(ref.refereeCredits) && ok(ref.referrerCredits)
    ? `They get ${ref.refereeCredits} free credits, you get ${ref.referrerCredits} when they join.`
    : GIFT_NEUTRAL_LINE;
}

/** Trim the gateway's /apps/referral answer to a usable link or null (pure). */
export function referralFrom(j) {
  try {
    if (!j || j.signedIn === false) return null;
    const u = new URL(String(j.url));
    if (u.protocol !== "https:") return null;
    return { url: u.href, refereeCredits: j.refereeCredits, referrerCredits: j.referrerCredits };
  } catch { return null; }
}

export function initGift() {
  const $ = (id) => document.getElementById(id);
  const q = { open: $("btn-gift"), card: $("gift-modal"), close: $("gift-close"), art: $("gift-art"), share: $("gift-x"), copy: $("gift-copy"), copyText: $("gift-copy-text"), live: $("gift-live"), line: $("gift-line") };
  if (!q.open || !q.card) return null;
  let built = false, last = null, timer = 0, link = GIFT_LINK, asked = false;

  function build() {
    if (built) return;
    built = true;
    GIFT_CAST.forEach((c, i) => {
      const m = mascotFor({ face: c.face, color: c.color });
      m.classList.add("gift-m", `gift-m${i + 1}`);
      wakeOn(m, m);
      q.art.append(m);
    });
    q.share.href = xIntentUrl(link);
  }
  // Ask the gateway once per page load for this user's own link and terms; any failure leaves the plain link and the neutral line.
  async function loadReferral() {
    if (asked) return;
    asked = true;
    try {
      const r = await fetch("/apps/referral", { headers: { accept: "application/json" }, cache: "no-store" });
      if (!r.ok) return;
      const ref = referralFrom(await r.json());
      if (!ref) return;
      link = ref.url;
      q.share.href = xIntentUrl(link);
      if (q.line) q.line.textContent = termsLine(ref);
    } catch { /* stays on the plain link */ }
  }
  function open() {
    build();
    loadReferral();
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
    try { await navigator.clipboard.writeText(link); ok = true; } catch {
      const t = document.createElement("textarea");
      t.value = link; t.setAttribute("readonly", ""); t.className = "sr-only";
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
