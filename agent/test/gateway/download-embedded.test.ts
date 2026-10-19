import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { startGateway } from "../../src/gateway/index.ts";
import { EMBEDDED_FILES, EMBEDDED_VERSION } from "../../src/embedded.generated.ts";
import { embeddedVersion, hasEmbeddedSite, resolveEmbedded } from "../../src/embedded.ts";
import { fakeRuntime, http } from "./helpers.ts";

const WEB = fileURLToPath(new URL("../../web/", import.meta.url));
const H = { host: "daebot.live", "x-forwarded-proto": "https" };

async function hostedWithRealWeb() {
  return startGateway({
    runtime: fakeRuntime(), port: 0, host: "127.0.0.1", staticDir: WEB,
    hosted: { token: randomBytes(18).toString("hex"), allowedHosts: ["daebot.live", "localhost"] },
  });
}

test("the download page and its manifest are public in hosted mode; the app is not", async () => {
  const gw = await hostedWithRealWeb();
  try {
    for (const p of ["/download", "/download/", "/download/index.html", "/download/download.js", "/download/download.css", "/download/releases.json"]) {
      const r = await http(gw.url, "GET", p, { headers: H });
      assert.equal(r.status, 200, p);
    }
    const page = await http(gw.url, "GET", "/download/", { headers: H });
    assert.match(String(page.headers["content-type"]), /text\/html/);
    assert.match(page.body, /<m-bot/);
    assert.match(page.body, /class="wm-flame"/);
    assert.equal((await http(gw.url, "GET", "/app.js", { headers: H })).status, 401);
    assert.equal((await http(gw.url, "GET", "/download/../app.js", { headers: H })).status, 401);
  } finally { await gw.close(); }
});

test("the download page is CSP-safe: no inline script, no inline style, no innerHTML", () => {
  const html = readFileSync(join(WEB, "download", "index.html"), "utf8");
  const js = readFileSync(join(WEB, "download", "download.js"), "utf8");
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/);
  assert.match(readFileSync(join(WEB, "login.html"), "utf8"), /href="\/download\/"/);
});

test("releases.json: three platforms, https URLs on download.m-i-n-d.ai, hash + size when a URL is set", () => {
  const m = JSON.parse(readFileSync(join(WEB, "download", "releases.json"), "utf8"));
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(m.platforms).sort(), ["linux", "mac", "windows"]);
  for (const p of Object.values<any>(m.platforms)) {
    assert.ok(p.files.length >= 1);
    for (const f of p.files) {
      assert.ok(f.file.includes(m.version));
      if (f.url === "") continue; // "Coming soon"
      assert.equal(f.url, `https://download.m-i-n-d.ai/download/daebot/${f.file}`);
      assert.match(f.sha256, /^[0-9a-f]{64}$/);
      assert.ok(f.size > 0);
    }
  }
});

test("download.js helpers: OS detection and URL safety", async () => {
  // @ts-ignore plain JS module without a declaration file
  const js = await import("../../web/download/download.js");
  assert.equal(js.detectOS({ platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)" }), "mac");
  assert.equal(js.detectOS({ platform: "Win32", userAgent: "Windows NT 10" }), "windows");
  assert.equal(js.detectOS({ platform: "Linux x86_64", userAgent: "X11; Linux" }), "linux");
  assert.equal(js.detectOS({ platform: "iPhone", userAgent: "iPhone; CPU like Mac OS X" }), null);
  assert.equal(js.safeUrl("https://download.m-i-n-d.ai/daebot/1/a.dmg"), "https://download.m-i-n-d.ai/daebot/1/a.dmg");
  assert.equal(js.safeUrl("javascript:alert(1)"), null);
  assert.equal(js.safeUrl("http://evil.example/a.exe"), null);
  assert.equal(js.safeUrl(""), null);
  assert.equal(js.formatSize(0), "");
  assert.equal(js.formatSize(116_000_000), "116 MB");
});

test("embedded site: served with no staticDir, directory index, HEAD, no dotfiles, no traversal", async () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const files = { "index.html": b64("<!doctype html><title>emb</title>"), "app.js": b64("export {}"), "download/index.html": b64("<title>dl</title>"), "brand/x.png": b64("png"), ".secret": b64("nope") };
  const gw = await startGateway({ runtime: fakeRuntime(), port: 0, host: "127.0.0.1", embeddedFiles: files });
  try {
    const root = await http(gw.url, "GET", "/");
    assert.equal(root.status, 200);
    assert.match(root.body, /emb/);
    assert.match(String(root.headers["content-type"]), /text\/html/);
    assert.match(String(root.headers["content-security-policy"]), /default-src 'self'/);
    assert.match((await http(gw.url, "GET", "/download/")).body, /dl/);
    assert.match((await http(gw.url, "GET", "/download")).body, /dl/);
    assert.equal((await http(gw.url, "GET", "/brand/x.png")).headers["content-type"], "image/png");
    const head = await http(gw.url, "HEAD", "/app.js");
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    assert.equal((await http(gw.url, "GET", "/.secret")).status, 404);
    assert.equal((await http(gw.url, "GET", "/%2e%2e/etc/passwd")).status, 404);
    assert.equal((await http(gw.url, "GET", "/nope.js")).status, 404);
    assert.equal((await http(gw.url, "GET", "/health")).status, 200);
  } finally { await gw.close(); }
});

test("an explicit staticDir beats the embedded site", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-sd-"));
  writeFileSync(join(dir, "index.html"), "from-disk");
  const gw = await startGateway({ runtime: fakeRuntime(), port: 0, host: "127.0.0.1", staticDir: dir, embeddedFiles: { "index.html": Buffer.from("from-embedded").toString("base64") } });
  try { assert.equal((await http(gw.url, "GET", "/")).body, "from-disk"); } finally { await gw.close(); }
});

test("on Node the generated module is the empty stub (nothing embedded, version from package.json)", () => {
  assert.equal(EMBEDDED_VERSION, "");
  assert.deepEqual(EMBEDDED_FILES, {});
  assert.equal(hasEmbeddedSite(), false);
  assert.equal(embeddedVersion(), undefined);
  assert.equal(resolveEmbedded("/index.html", {}), null);
});

test("build-bin collects web/ (download page and brand in, build-only folders out) and renders a valid module", async () => {
  // @ts-ignore plain JS module without a declaration file
  const { collectSite, renderModule, outName } = await import("../../scripts/build-bin.mjs");
  const files = collectSite(WEB);
  for (const k of ["index.html", "login.html", "download/index.html", "download/releases.json", "brand/mbot.js"]) assert.ok(files[k], k);
  assert.ok(!Object.keys(files).some((k) => k.startsWith("brand/login-src") || k.split("/").some((s) => s.startsWith("."))));
  const mod = renderModule("1.2.3", { "a.txt": "QQ==" });
  assert.match(mod, /EMBEDDED_VERSION: string = "1\.2\.3"/);
  assert.match(mod, /"a\.txt":"QQ=="/);
  assert.equal(outName("bun-windows-x64"), "daebot-windows-x64.exe");
  assert.equal(outName("bun-darwin-arm64"), "daebot-darwin-arm64");
});

test("release-manifest fills size, sha256 and the public URL only for files that exist", async () => {
  // @ts-ignore plain JS module without a declaration file
  const { fillManifest } = await import("../../scripts/release-manifest.mjs");
  const dir = mkdtempSync(join(tmpdir(), "mc-rel-"));
  writeFileSync(join(dir, "Daebot-9.9.9-mac-universal.dmg"), "dmgbytes");
  const base = JSON.parse(readFileSync(join(WEB, "download", "releases.json"), "utf8"));
  const out = fillManifest(base, "9.9.9", dir);
  assert.equal(out.version, "9.9.9");
  const dmg = out.platforms.mac.files[0];
  assert.equal(dmg.url, "https://download.m-i-n-d.ai/download/daebot/Daebot-9.9.9-mac-universal.dmg");
  assert.equal(dmg.size, 8);
  assert.match(dmg.sha256, /^[0-9a-f]{64}$/);
  assert.equal(out.platforms.windows.files[0].url, "");
  assert.equal(base.version === "9.9.9", false); // input not mutated
  assert.notEqual(base.platforms.mac.files[0].file, dmg.file);
});
