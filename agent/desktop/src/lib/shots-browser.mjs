// Dev-only Xvfb shots for the browser pane. main.mjs imports this only to call runBrowserShots, and only when
// --mindclaw-smoke is combined with --daebot-devices-shots=. Nothing here runs for a normal launch.
// scripts/shots-browser.mjs starts the page server and the two Electron processes (capture, then persist).
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Daebot shop</title>
<style>
  body { margin: 0; font: 16px/1.4 system-ui, sans-serif; background: #fffdfa; color: #141211; }
  main { padding: 28px 28px 40px; max-width: 420px; }
  h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: -0.02em; }
  p { margin: 0 0 16px; color: #4f4940; }
  label { display: block; margin: 14px 0 6px; font-weight: 650; font-size: 13px; }
  input { box-sizing: border-box; width: 100%; max-width: 280px; font: 16px system-ui, sans-serif; padding: 8px 10px; border: 1px solid #d6c7ab; border-radius: 8px; background: #fff; color: #141211; }
  button { margin-top: 18px; font: 650 15px system-ui, sans-serif; padding: 8px 14px; border-radius: 8px; border: 1px solid #141211; background: #141211; color: #fffdfa; }
  #status { font-weight: 650; }
</style>
</head>
<body>
<main>
  <h1>Daebot shop</h1>
  <p id="status">checking</p>
  <form action="/order" method="post">
    <label for="note">Note</label>
    <input id="note" name="note" type="text" autocomplete="off">
    <label for="pw">Password</label>
    <input id="pw" name="pw" type="password" autocomplete="current-password">
    <label for="card">Card number</label>
    <input id="card" name="card" type="text" autocomplete="cc-number">
    <button type="submit">Place order</button>
  </form>
</main>
<script>
fetch("/who").then((r) => r.json()).then((j) => {
  document.getElementById("status").textContent = j.signedIn ? "signed in" : "signed out";
}).catch(() => { document.getElementById("status").textContent = "signed out"; });
</script>
</body>
</html>`;

/** Local shop page. Sets an HttpOnly cookie when it is missing. Never logs the cookie. */
export function startPageServer() {
  const server = createServer((req, res) => {
    const path = (req.url || "/").split("?")[0];
    if (path === "/who") {
      const signedIn = /(?:^|;\s*)daebot_browser=/.test(String(req.headers.cookie || ""));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ signedIn }));
      return;
    }
    if (path === "/order") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Ordered</title><h1>Order placed</h1>");
      return;
    }
    if (!/(?:^|;\s*)daebot_browser=/.test(String(req.headers.cookie || ""))) {
      res.setHeader("set-cookie", "daebot_browser=1; HttpOnly; Path=/; SameSite=Lax");
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(PAGE);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        server,
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function probe(win, expr) {
  try { return await withTimeout(win.webContents.executeJavaScript(expr, true), 3_000, "ui probe"); }
  catch (e) { return { err: String(e?.message ?? e) }; }
}

/**
 * @param {{ win: any, pane: any, gatewayInfo: { origin: string, token: string, url: string }, shotsDir: string,
 *   log: Function, phase: string, pageUrl: string, nativeImage: any, fetch?: Function }} deps
 */
export async function runBrowserShots(deps) {
  const { win, pane, gatewayInfo, shotsDir, log, nativeImage } = deps;
  const phase = deps.phase || "capture";
  const pageUrl = deps.pageUrl;
  const fetch = deps.fetch ?? globalThis.fetch;
  mkdirSync(shotsDir, { recursive: true });
  if (!pageUrl || !pageUrl.startsWith("http://127.0.0.1:")) {
    log("browser shots: page url must be http://127.0.0.1:<port>/");
    return { ok: false, error: "bad page url" };
  }
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("browser shots: hard timeout")), 110_000);
    timer.unref?.();
  });
  try {
    return await Promise.race([timeout, runPhases()]);
  } catch (e) {
    log("browser shots failed:", String(e?.message ?? e).slice(0, 300));
    return { ok: false, error: String(e?.message ?? e).slice(0, 300) };
  } finally { clearTimeout(timer); }

  async function runPhases() {
    try { win.webContents.setZoomLevel(0); } catch { /* the shot is measured in CSS pixels */ }
    if (typeof win.setContentSize === "function") win.setContentSize(1440, 900);
    else win.setSize(1440, 900);
    win.show();
    await sleep(300);
    const auth = { authorization: `Bearer ${gatewayInfo.token}`, "content-type": "application/json" };
    const post = async (path, body) => {
      const res = await fetch(`${gatewayInfo.origin}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
      return { status: res.status, json };
    };
    await waitForUi(win, log);
    if (phase === "persist") return await persistPhase({ win, pane, post, log, shotsDir, pageUrl, nativeImage });
    return await capturePhase({ win, pane, post, fetch, log, shotsDir, pageUrl, nativeImage, gatewayInfo });
  }
}

async function waitForUi(win, log) {
  for (let i = 0; i < 40; i++) {
    const state = await probe(win, `({ hasNew: !!document.getElementById('btn-new'), hasPane: !!document.getElementById('browser-pane') })`);
    if (state?.hasNew && state?.hasPane) return;
    await sleep(250);
  }
  log("browser shots: UI probe did not see the pane");
}

async function waitFor(fn, ms, step = 200) {
  const start = Date.now();
  let last;
  while (Date.now() - start < ms) {
    last = await fn();
    if (last) return last;
    await sleep(step);
  }
  return last;
}

function fitBitmap(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return src;
  const dst = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
      src.copy(dst, (y * dw + x) * 4, (sy * sw + sx) * 4, (sy * sw + sx) * 4 + 4);
    }
  }
  return dst;
}

function blit(dst, dw, dh, src, sw, sh, x, y) {
  const maxW = Math.min(sw, dw - x);
  const bpp = 4;
  for (let row = 0; row < sh; row++) {
    const dy = y + row;
    if (dy < 0 || dy >= dh || maxW <= 0 || x >= dw) continue;
    const s0 = row * sw * bpp;
    const d0 = (dy * dw + Math.max(0, x)) * bpp;
    const n = Math.max(0, Math.min(maxW, dw - Math.max(0, x))) * bpp;
    // Buffer.copy's last argument is an end index, not a length.
    if (n > 0 && s0 + n <= src.length) src.copy(dst, d0, s0, s0 + n);
  }
}

/** Wait until the native view sits on #browser-view, so the page does not cover the title or the notice. */
async function alignViewport(win, pane) {
  return waitFor(async () => {
    const box = await probe(win, `(() => { const e = document.getElementById('browser-view'); const p = document.getElementById('browser-pane'); if (!e || !p || p.hidden) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
    const v = pane.viewportBounds?.();
    if (!box || !v || box.y < 30 || box.h < 80) return null;
    if (Math.abs(box.y - v.y) <= 3 && Math.abs(box.x - v.x) <= 3 && Math.abs(box.h - v.height) <= 6 && Math.abs(box.w - v.width) <= 6) return box;
    return null;
  }, 6_000);
}

async function captureOnce(fn, label) {
  let last;
  for (let i = 0; i < 2; i++) {
    try { return await withTimeout(Promise.resolve().then(fn), 8_000, label); }
    catch (e) { last = e; await sleep(200); }
  }
  throw last;
}

async function pageImage(deps, shot) {
  let body = shot;
  let last = "screenshot did not return a JPEG";
  for (let i = 0; i < (shot ? 1 : 5); i++) {
    if (!body) body = await tool(deps.post, { action: "screenshot" });
    const url = Array.isArray(body?.images) ? String(body.images[0] || "") : "";
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=\s]+)$/.exec(url);
    if (body?.ok && m) {
      const img = deps.nativeImage.createFromBuffer(Buffer.from(m[1].replace(/\s/g, ""), "base64"));
      if (img && !img.isEmpty?.()) return img;
      last = "screenshot decoded empty";
    } else last = typeof body?.output === "string" ? body.output.slice(0, 180) : "screenshot did not return a JPEG";
    body = null;
    await sleep(300);
  }
  throw new Error(last);
}

async function saveComposite(deps, name, pageImg) {
  const { win, pane, nativeImage, shotsDir } = deps;
  try { win.show(); } catch { /* already showing */ }
  // The page view's capturePage can stall on a second process. CDP Page.captureScreenshot does not.
  const winImg = await captureOnce(() => win.webContents.capturePage(), "window capture");
  if (!pageImg) pageImg = await pageImage(deps);
  const outPath = join(shotsDir, name);
  if (!pageImg || pageImg.isEmpty?.()) {
    writeFileSync(outPath, winImg.toPNG());
    return { path: outPath, composited: false, bytes: winImg.toPNG().length };
  }
  const baseSize = winImg.getSize();
  const content = win.getContentBounds();
  const sx = content.width ? baseSize.width / content.width : 1;
  const sy = content.height ? baseSize.height / content.height : 1;
  const rect = pane.viewportBounds?.() || { x: 0, y: 0, width: 0, height: 0 };
  const dst = Buffer.from(winImg.toBitmap());
  const raw = pageImg.toBitmap();
  const ps = pageImg.getSize();
  const holeW = Math.max(1, Math.min(2000, Math.round(rect.width * sx)));
  const holeH = Math.max(1, Math.min(2000, Math.round(rect.height * sy)));
  const src = (ps.width === holeW && ps.height === holeH) ? raw : fitBitmap(raw, ps.width, ps.height, holeW, holeH);
  blit(dst, baseSize.width, baseSize.height, src, holeW, holeH, Math.round(rect.x * sx), Math.round(rect.y * sy));
  const merged = nativeImage.createFromBitmap(dst, { width: baseSize.width, height: baseSize.height });
  const png = merged.toPNG();
  writeFileSync(outPath, png);
  return { path: outPath, composited: true, bytes: png.length };
}

async function tool(post, body) {
  const r = await post("/browser/shots", body);
  if (r.status !== 200) throw new Error(`shots HTTP ${r.status}`);
  return r.json;
}

async function capturePhase(deps) {
  const { win, log, shotsDir, pageUrl } = deps;
  const opened = await tool(deps.post, { action: "open", url: pageUrl });
  if (!opened?.ok) throw new Error(`open failed: ${JSON.stringify(opened).slice(0, 240)}`);
  const read = await waitFor(async () => {
    const r = await tool(deps.post, { action: "read" });
    if (r?.ok && typeof r.output === "string" && r.output.includes("Daebot shop")) return r;
    return null;
  }, 15_000);
  if (!read) throw new Error("read never saw Daebot shop");
  await waitFor(async () => {
    const y = await probe(win, `(() => { const e = document.getElementById('browser-view'); if (!e || document.getElementById('browser-pane').hidden) return 0; return e.getBoundingClientRect().y; })()`);
    return typeof y === "number" && y > 30 ? y : null;
  }, 8_000);
  await alignViewport(win, deps.pane);
  await sleep(250);
  const loaded = await saveComposite(deps, "pane-loaded.png");
  const refs = Array.isArray(read.meta?.refs) ? read.meta.refs : [];
  const note = refs.find((e) => e && e.secret !== true && (e.type === "text" || e.id === "note" || e.name === "Note"));
  const secret = refs.find((e) => e && e.secret === true && (e.type === "password" || e.name === "Password"));
  const order = refs.find((e) => e && /place order/i.test(`${e.name || ""} ${e.text || ""}`));
  if (!note?.ref) throw new Error("read did not return a text field ref");
  const typed = await tool(deps.post, { action: "type", ref: note.ref, text: "hello from daebot" });
  if (!typed?.ok) throw new Error(`type failed: ${JSON.stringify(typed).slice(0, 240)}`);
  await alignViewport(win, deps.pane);
  await sleep(200);
  const after = await saveComposite(deps, "after-typing.png");
  if (!secret?.ref) throw new Error("read did not return a password ref");
  const refused = await tool(deps.post, { action: "type", ref: secret.ref, text: "not-a-real-secret" });
  if (refused?.ok !== false) throw new Error("password typing was not refused");
  await waitFor(async () => {
    const t = await probe(win, `document.getElementById('browser-notice')?.textContent || ""`);
    return typeof t === "string" && /password|payment/i.test(t) ? t : null;
  }, 5_000);
  await alignViewport(win, deps.pane);
  await sleep(150);
  const refusal = await saveComposite(deps, "refusal.png");
  if (!order?.ref) throw new Error("read did not return the Place order ref");
  const blocked = await tool(deps.post, { action: "click", ref: order.ref });
  if (!blocked?.blocked) throw new Error(`place order was not held: ${JSON.stringify(blocked).slice(0, 240)}`);
  await waitFor(async () => {
    const t = await probe(win, `document.getElementById('browser-notice')?.textContent || ""`);
    return typeof t === "string" && /needs your go/i.test(t) ? t : null;
  }, 5_000);
  await alignViewport(win, deps.pane);
  await sleep(150);
  const approval = await saveComposite(deps, "approval.png");
  const shot = await tool(deps.post, { action: "screenshot" });
  const heldPage = await pageImage(deps, shot);
  const wc = deps.pane.activeWebContents?.();
  if (wc && typeof wc.sendInputEvent === "function") {
    try {
      wc.sendInputEvent({ type: "mouseDown", x: 30, y: 30, button: "left", clickCount: 1 });
      wc.sendInputEvent({ type: "mouseUp", x: 30, y: 30, button: "left", clickCount: 1 });
    } catch (e) { log("sendInputEvent:", String(e?.message ?? e).slice(0, 160)); }
  }
  await sleep(300);
  let control = await probe(win, `document.getElementById('browser-control')?.textContent || ""`);
  if (typeof control !== "string" || !/You have control/.test(control)) {
    const sessions = await (deps.fetch ?? globalThis.fetch)(`${deps.gatewayInfo.origin}/sessions`, { headers: { authorization: `Bearer ${deps.gatewayInfo.token}` } });
    const list = await sessions.json();
    const id = list?.sessions?.[0]?.id;
    if (!id) throw new Error("no chat session to take over");
    await deps.post(`/sessions/${encodeURIComponent(id)}/browser/control`, { action: "take" });
    control = await waitFor(async () => {
      const t = await probe(win, `document.getElementById('browser-control')?.textContent || ""`);
      return typeof t === "string" && /You have control/.test(t) ? t : null;
    }, 5_000);
  }
  if (!control) throw new Error("take-over bar did not show");
  await alignViewport(win, deps.pane);
  await sleep(150);
  const takeover = await saveComposite(deps, "takeover.png", heldPage);
  await deps.pane.flush?.();
  const result = {
    ok: true,
    phase: "capture",
    signedInOnPage: typeof read.output === "string" && read.output.includes("signed in"),
    passwordRefused: true,
    placeOrderBlocked: true,
    shots: { loaded, after, refusal, approval, takeover },
  };
  writeFileSync(join(shotsDir, "result.json"), JSON.stringify(result, null, 2));
  log("browser shots: capture done");
  return result;
}

async function persistPhase(deps) {
  const { log, shotsDir, pageUrl } = deps;
  const opened = await tool(deps.post, { action: "open", url: pageUrl });
  if (!opened?.ok) throw new Error(`persist open failed: ${JSON.stringify(opened).slice(0, 200)}`);
  const read = await waitFor(async () => {
    const r = await tool(deps.post, { action: "read" });
    if (r?.ok && typeof r.output === "string" && (r.output.includes("signed in") || r.output.includes("signed out"))) return r;
    return null;
  }, 15_000);
  const signedIn = !!(read && typeof read.output === "string" && read.output.includes("signed in") && !/\bsigned out\b/.test(read.output));
  if (signedIn) log("signed in after restart");
  else log("browser shots: session was not signed in after restart");
  await alignViewport(deps.win, deps.pane);
  await sleep(250);
  const picture = await saveComposite(deps, "persist.png");
  const result = { ok: signedIn, phase: "persist", signedInAfterRestart: signedIn, shots: { picture } };
  writeFileSync(join(shotsDir, "result-persist.json"), JSON.stringify(result, null, 2));
  return result;
}
