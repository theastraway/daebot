// Download page. Reads /download/releases.json and renders one button per platform. Every node is built with
// createElement and textContent (never parsed markup), and a URL is only used when it is https (or a same-site path).
const hasDom = typeof document !== "undefined";
const list = hasDom ? document.getElementById("dl-list") : null;
const meta = hasDom ? document.getElementById("dl-meta") : null;
const sub = hasDom ? document.getElementById("dl-sub") : null;
const ORDER = ["mac", "windows", "linux", "ios", "android"];

export function detectOS(nav = navigator) {
  const s = `${nav.userAgentData?.platform ?? ""} ${nav.platform ?? ""} ${nav.userAgent ?? ""}`.toLowerCase();
  if (/iphone|ipad|ipod/.test(s)) return "ios";
  if (/android/.test(s)) return "android";
  if (s.includes("win")) return "windows";
  if (s.includes("mac")) return "mac";
  if (s.includes("linux") || s.includes("x11") || s.includes("cros")) return "linux";
  return null;
}

export function safeUrl(u, origin = typeof location !== "undefined" ? location.origin : "https://daebot.live") {
  if (typeof u !== "string" || !u) return null;
  try {
    const url = new URL(u, origin);
    return url.protocol === "https:" || (url.origin === origin && url.protocol === "http:") ? url.href : null;
  } catch {
    return null;
  }
}

export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function button(p, f, primary) {
  const href = safeUrl(f.url);
  const a = el(href ? "a" : "div", `dl-btn${primary ? " is-primary" : ""}${href ? "" : " is-soon"}`);
  if (href) { a.href = href; a.rel = "noopener"; if (f.kind !== "testflight") a.setAttribute("download", ""); }
  else a.setAttribute("aria-disabled", "true");
  a.append(el("span", "dl-name", p.label), el("span", "dl-state", href ? (f.action || "Download") : "Coming soon"));
  const size = formatSize(f.size);
  a.append(el("span", "dl-detail", [p.detail, href ? size : ""].filter(Boolean).join(" · ")));
  return a;
}

function render(manifest, os) {
  list.replaceChildren();
  // Desktop builds share one version (platforms); the phone apps ship on their own store/feed cadence (mobile).
  manifest = { ...manifest, platforms: { ...manifest.platforms, ...manifest.mobile } };
  const names = ORDER.filter((k) => manifest.platforms?.[k]);
  if (os && names.includes(os)) { names.splice(names.indexOf(os), 1); names.unshift(os); }
  for (const key of names) {
    const p = manifest.platforms[key];
    const files = Array.isArray(p.files) ? p.files : [];
    if (!files.length) continue;
    const item = el("div", "dl-item");
    if (key === os) item.append(el("span", "dl-flag", "Recommended for your system"));
    item.append(button(p, files[0], key === os));
    for (const extra of files.slice(1)) {
      const href = safeUrl(extra.url);
      if (href) { const a = el("a", "dl-alt", extra.label); a.href = href; a.rel = "noopener"; a.setAttribute("download", ""); item.append(a); }
    }
    list.append(item);
  }
  const first = os && manifest.platforms?.[os]?.files?.[0];
  if (first && safeUrl(first.url)) {
    const bits = [`Version ${first.version || manifest.version}`];
    if (first.sha256) bits.push(`SHA-256 ${first.sha256}`);
    meta.textContent = bits.join(" · ");
    meta.hidden = false;
  }
}

async function main() {
  let manifest;
  try {
    const r = await fetch("/download/releases.json", { cache: "no-store" });
    if (!r.ok) throw new Error(String(r.status));
    manifest = await r.json();
  } catch {
    sub.textContent = "Downloads are not available right now. Try again in a few minutes.";
    return;
  }
  const os = detectOS();
  if (!os) sub.textContent = "Daebot runs on Mac, Windows, Linux, iPhone and Android.";
  render(manifest, os);
}

if (list) main();
