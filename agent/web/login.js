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
const ownerBox = document.getElementById("owner-box");
const sub = document.getElementById("login-sub");

const REASONS = {
  denied: "Sign-in was cancelled.",
  state: "That sign-in could not be verified. Start again.",
  oauth: "MIND could not complete the sign-in. Try again or use an API key.",
  oauth_down: "Could not reach MIND to start sign-in. Try again or use an API key.",
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

// Which methods this deployment offers.
(async () => {
  let m = { owner: true, key: false, oauth: false };
  try { const r = await fetch("/auth/methods", { cache: "no-store" }); if (r.ok) m = await r.json(); } catch { /* owner code only */ }
  if (m.key || m.oauth) {
    mindBox.hidden = false;
    oauthLink.hidden = !m.oauth;
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
