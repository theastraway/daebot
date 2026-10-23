// The native-app sign-in page: the account-switch control must exist, only show in the app, and ask the native
// bridge for a private (ephemeral) auth session. A static check of the shipped files, so a template edit cannot drop it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const web = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const read = (f: string) => readFileSync(join(web, f), "utf8");

test("login.html and its template both carry the hidden account-switch button", () => {
  for (const f of ["login.html", "brand/login-src/login.html.tpl"]) {
    assert.match(read(f), /<button[^>]*id="mind-switch"[^>]*\bhidden\b[^>]*>Use a different MIND account<\/button>/, f);
  }
});

test("login.js: switch is app-only and starts an ephemeral sheet; the plain button stays a shared-session sheet", () => {
  const js = read("login.js");
  assert.match(js, /switchBtn\.hidden = !\(m\.oauth && nativeAuth\(\)\)/);
  assert.match(js, /fresh \? \{ url: startUrl, ephemeral: true \} : \{ url: startUrl \}/);
  assert.match(js, /switchBtn\.addEventListener\("click", \(\) => appSignIn\(nativeAuth\(\), true\)\)/);
});

test("AppDelegate: ephemeral only when the page asked for it, never by default", () => {
  const swift = readFileSync(join(web, "..", "ios", "ios", "App", "App", "AppDelegate.swift"), "utf8");
  assert.match(swift, /prefersEphemeralWebBrowserSession = \(body\["ephemeral"\] as\? Bool\) == true/);
});
