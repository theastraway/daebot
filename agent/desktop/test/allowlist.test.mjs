import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLoadUrl, classifyUrl, isAllowedNavigation, originOf, redactUrl } from "../src/lib/allowlist.mjs";

const GW = "http://127.0.0.1:50123";

test("only the exact gateway origin is internal", () => {
  assert.ok(isAllowedNavigation("http://127.0.0.1:50123/", GW));
  assert.ok(isAllowedNavigation("http://127.0.0.1:50123/sessions?x=1#h", GW));
  for (const bad of [
    "http://127.0.0.1:50124/", "http://localhost:50123/", "https://127.0.0.1:50123/", "http://127.0.0.1.evil.com:50123/",
    "http://evil.com/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "about:blank", "not a url", "",
    "http://127.0.0.1:50123@evil.com/", "http://user@127.0.0.1:50123.evil.com/",
  ]) assert.ok(!isAllowedNavigation(bad, GW), bad);
  assert.ok(!isAllowedNavigation("http://127.0.0.1:50123/", null), "no gateway yet = nothing allowed");
});

test("classifyUrl: external only for http(s)/mailto, everything else blocked", () => {
  assert.equal(classifyUrl("http://127.0.0.1:50123/x", GW), "internal");
  assert.equal(classifyUrl("https://example.com/a", GW), "external");
  assert.equal(classifyUrl("mailto:a@b.co", GW), "external");
  for (const b of ["file:///etc/hosts", "javascript:1", "data:text/html,x", "vscode://x", "ftp://x/y", "nope"]) assert.equal(classifyUrl(b, GW), "block", b);
});

test("buildLoadUrl puts the token in the query exactly once, on the root path", () => {
  const u = new URL(buildLoadUrl("http://127.0.0.1:50123/ignored?old=1", "abc123"));
  assert.equal(u.pathname, "/");
  assert.equal(u.searchParams.get("token"), "abc123");
  assert.equal([...u.searchParams].length, 1);
  assert.equal(originOf(u.toString()), GW);
});

test("redactUrl hides the token", () => {
  assert.ok(!redactUrl("http://127.0.0.1:1/?token=secret").includes("secret"));
  assert.equal(redactUrl("garbage"), "[invalid url]");
});
