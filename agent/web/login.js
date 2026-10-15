// Sign-in client. Posts the access code to /login; the server answers with an HttpOnly session cookie.
// The code is never stored by this page and never appears in a URL.
const form = document.getElementById("login-form");
const input = document.getElementById("code");
const btn = document.getElementById("login-btn");
const err = document.getElementById("login-err");

function fail(msg) {
  err.textContent = msg;
  err.hidden = false;
  input.focus();
  input.select();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = input.value;
  if (!code.trim()) return fail("Enter your access code.");
  err.hidden = true;
  btn.disabled = true;
  try {
    const res = await fetch("/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: code }),
      credentials: "same-origin",
    });
    if (res.ok) {
      input.value = "";
      location.replace("/");
      return;
    }
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after")) || 0;
      return fail(`Too many attempts. Try again in ${wait > 90 ? Math.ceil(wait / 60) + " minutes" : "a moment"}.`);
    }
    fail("That access code was not accepted.");
  } catch {
    fail("Could not reach the server. Check your connection.");
  } finally {
    btn.disabled = false;
  }
});
