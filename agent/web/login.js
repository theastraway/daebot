// Sign-in client. Three ways in: Sign in with MIND (OAuth, a plain link), a pasted MIND API key, or the owner access code.
// Secrets are posted to the server and never stored by this page or put in a URL; the server answers with an HttpOnly session cookie.
const form = document.getElementById("login-form");
const input = document.getElementById("code");
const btn = document.getElementById("login-btn");
const err = document.getElementById("login-err");
const keyForm = document.getElementById("key-form");
const keyInput = document.getElementById("mind-key");
const keyBtn = document.getElementById("key-btn");
const mindBox = document.getElementById("mind-sign");
const oauthLink = document.getElementById("mind-oauth");
const switchBtn = document.getElementById("mind-switch");
const ownerBox = document.getElementById("owner-box");
const sub = document.getElementById("login-sub");

const REASONS = {
  denied: "Sign-in was cancelled.",
  state: "That sign-in could not be verified. Start again.",
  oauth: "MIND could not complete the sign-in. Try again or use an API key.",
  oauth_down: "Could not reach MIND to start sign-in. Try again or use an API key.",
  bad_request: "Sign-in could not start. Try again.",
  expired: "That sign-in took too long. Start again.",
  oauth_off: "Sign in with MIND is not available. Use an API key.",
  notallowed: "That MIND account is not enabled for Daebot.",
  slow: "Too many attempts. Try again in a few minutes.",
};

function fail(msg, focusEl) {
  err.textContent = msg;
  err.hidden = false;
  if (focusEl) { focusEl.focus(); focusEl.select?.(); }
}

async function post(path, body) {
  return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
}

function rateLimited(res) {
  const wait = Number(res.headers.get("retry-after")) || 0;
  return `Too many attempts. Try again in ${wait > 90 ? Math.ceil(wait / 60) + " minutes" : "a moment"}.`;
}

// Daebot iOS app: the WebView cannot finish a sign-in that leaves for Google (it would break out to Safari and never return).
// Instead the native app runs it in ASWebAuthenticationSession (WebKit message handler "daebotAuth"), which ends at daebot://auth/callback?code=...;
// the one-time code is then traded over HTTPS for the session cookie inside this WebView. A PKCE-style verifier stays in memory here.
const nativeAuth = () => {
  try { const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.daebotAuth; return h ? { start: (o) => h.postMessage(o).then((url) => ({ url })) } : undefined; } catch { return undefined; }
};
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// `fresh` = account switch: the sheet runs in a private (ephemeral) browser session, so MIND cannot silently reuse the previous account
// and always shows its own sign-in page, still inside the sheet.
async function appSignIn(plugin, fresh = false) {
  err.hidden = true;
  oauthLink.setAttribute("aria-busy", "true");
  try {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const startUrl = `${location.origin}/auth/mind/start?app=ios&cc=${challenge}`;
    let back;
    try { back = (await plugin.start(fresh ? { url: startUrl, ephemeral: true } : { url: startUrl })).url; }
    catch (e) { if (/cancel/i.test(String((e && e.message) || e))) return; throw e; }
    const q = new URL(back).searchParams;
    if (q.get("error")) return fail(REASONS[q.get("error")] || "Sign-in did not complete. Try again.");
    const code = q.get("code");
    if (!code) return fail("Sign-in did not complete. Try again.");
    const res = await post("/auth/app/exchange", { code, verifier });
    if (res.ok) { location.replace("/"); return; }
    if (res.status === 429) return fail(rateLimited(res));
    fail("That sign-in expired. Start again.");
  } catch {
    fail("Sign-in did not complete. Try again.");
  } finally {
    oauthLink.removeAttribute("aria-busy");
  }
}

oauthLink.addEventListener("click", (e) => {
  const plugin = nativeAuth();
  if (!plugin) return; // a normal browser: the plain link works
  e.preventDefault();
  appSignIn(plugin);
});

// Only the native app can run the sheet, so only it gets the account-switch control.
if (nativeAuth()) {
  switchBtn.addEventListener("click", () => appSignIn(nativeAuth(), true));
}

// Which methods this deployment offers.
(async () => {
  let m = { owner: true, key: false, oauth: false };
  try { const r = await fetch("/auth/methods", { cache: "no-store" }); if (r.ok) m = await r.json(); } catch { /* owner code only */ }
  if (m.key || m.oauth) {
    mindBox.hidden = false;
    oauthLink.hidden = !m.oauth;
    switchBtn.hidden = !(m.oauth && nativeAuth());
    keyForm.hidden = !m.key;
    sub.textContent = "Sign in with your MIND account.";
  } else {
    ownerBox.open = true;
    ownerBox.querySelector("summary").hidden = true;
    sub.textContent = "Private agent. Enter your access code to continue.";
  }
  const e = new URLSearchParams(location.search).get("e");
  if (e) fail(REASONS[e] || "Sign-in did not complete. Try again.");
})();

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = input.value;
  if (!code.trim()) return fail("Enter your access code.", input);
  err.hidden = true;
  btn.disabled = true;
  try {
    const res = await post("/login", { token: code });
    if (res.ok) { input.value = ""; location.replace("/"); return; }
    if (res.status === 429) return fail(rateLimited(res), input);
    fail("That access code was not accepted.", input);
  } catch {
    fail("Could not reach the server. Check your connection.");
  } finally {
    btn.disabled = false;
  }
});

keyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = keyInput.value.trim();
  if (!key) return fail("Paste your MIND API key.", keyInput);
  err.hidden = true;
  keyBtn.disabled = true;
  try {
    const res = await post("/auth/key", { key });
    if (res.ok) { keyInput.value = ""; location.replace("/"); return; }
    if (res.status === 429) return fail(rateLimited(res), keyInput);
    const j = await res.json().catch(() => ({}));
    fail(j.error || "That key was not accepted.", keyInput);
  } catch {
    fail("Could not reach the server. Check your connection.");
  } finally {
    keyBtn.disabled = false;
  }
});

// Get the app: right under sign-in, recommend the Daebot build for this device (Windows, Mac, Linux, iPhone, Android).
// Release links come from the public /download/releases.json; hidden inside the desktop app itself.
export function detectPlatform(ua, platform = "", touchPoints = 0) {
  const u = String(ua || "");
  if (/android/i.test(u)) return { group: "mobile", key: "android" };
  if (/iphone|ipad|ipod/i.test(u) || (/macintosh/i.test(u) && touchPoints > 1)) return { group: "mobile", key: "ios" };
  if (/windows/i.test(u)) return { group: "platforms", key: "windows", arm: /arm64|aarch64/i.test(u) };
  if (/mac os x|macintosh/i.test(u) || /mac/i.test(platform)) return { group: "platforms", key: "mac" };
  if (/linux|x11|cros/i.test(u)) return { group: "platforms", key: "linux" };
  return null;
}
export function pickRelease(rel, p) {
  const entry = p && rel?.[p.group]?.[p.key];
  const files = Array.isArray(entry?.files) ? entry.files.filter((f) => f && typeof f.url === "string" && /^https:\/\//.test(f.url)) : [];
  if (!files.length) return null;
  const file = (p.arm && files.find((f) => /arm64/i.test(f.file || f.url))) || files[0];
  return { label: file.label || `Download for ${entry.label}`, url: file.url, detail: [entry.detail, file.version ? `Version ${file.version}` : "", file.size ? `${Math.round(file.size / 1048576)} MB` : ""].filter(Boolean).join(" · ") };
}
async function showGetApp() {
  const box = document.getElementById("get-app");
  if (!box || window.mindclawDesktop || window.DaebotAndroid || window.Capacitor || /electron|DaebotApp/i.test(navigator.userAgent)) return; // already in a Daebot app
  const p = detectPlatform(navigator.userAgent, navigator.platform, navigator.maxTouchPoints || 0);
  if (!p) return;
  try {
    const r = await fetch("/download/releases.json", { cache: "no-store" });
    if (!r.ok) return;
    const pick = pickRelease(await r.json(), p);
    if (!pick) return;
    const a = document.getElementById("get-app-btn");
    a.textContent = pick.label;
    a.href = pick.url;
    document.getElementById("get-app-detail").textContent = pick.detail;
    box.hidden = false;
  } catch { /* the footer link to /download/ still works */ }
}
if (typeof document !== "undefined") showGetApp();
