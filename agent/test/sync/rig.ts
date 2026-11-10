// Two real gateways in one process: a HOSTED one (daebot.live: per-user runtimes, X-MIND-Key sync API) and a LOCAL one (the desktop app's
// gateway) whose sync agent talks to the hosted one through a fetch bridge (the hosted side only answers its allowlisted Host over "https").
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../../src/gateway/index.ts";
import { DailyCostCap } from "../../src/hosted.ts";
import { createAuthContext } from "../../src/auth/index.ts";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { BootCache } from "../../src/mind/boot-cache.ts";
import { baseCfg, FakeProvider } from "../core/helpers.ts";
import { startFakeMind } from "../gateway/fake-mind.ts";
import { auth as bearer, http, tmpStatic } from "../gateway/helpers.ts";

export const rnd = () => randomBytes(18).toString("hex");
export const H = { host: "daebot.live", "x-forwarded-proto": "https" };

export async function hostedRig(o: { script?: ConstructorParameters<typeof FakeProvider>[0]; users?: string[] } = {}) {
  const names = o.users ?? ["alice", "bob"];
  const keys: Record<string, string> = Object.fromEntries(names.map((n) => [n, "mind_" + rnd()]));
  const fake = await startFakeMind(Object.fromEntries(names.map((n) => [keys[n], n])));
  const st = tmpStatic();
  for (const [f, c] of [["login.html", "<!doctype html>"], ["login.js", "export {}"], ["login.css", "body{}"], ["favicon.svg", "<svg/>"]]) writeFileSync(join(st.dir, f), c);
  const dir = mkdtempSync(join(tmpdir(), "daebot-hosted-"));
  const provider = new FakeProvider(o.script ?? [{ text: "hosted says hi" }]);
  const hostedOpts = { token: rnd(), allowedHosts: ["daebot.live", "localhost"] };
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: "server-owner-key-" + rnd() });
  const globalCap = new DailyCostCap(50);
  const store = createFileStore(dir);
  const bootCache = new BootCache();
  const bots = { dir, bus: {}, manage: {} };
  const ownerRuntime = createRuntime(cfg, { provider, store, bootCache, bots, hosted: { dailyUsdCap: 50, sharedCap: globalCap, exempt: true } });
  const env: NodeJS.ProcessEnv = { DATA_DIR: dir, DAEBOT_SECRET_KEY: rnd() + rnd(), DAEBOT_ADMINS: "", MIND_OAUTH_BASE_URL: fake.url, DAEBOT_PUBLIC_URL: "https://daebot.live" };
  const auth = createAuthContext({ env, cfg, hosted: hostedOpts, ownerRuntime, globalCap, provider, sessionStore: store, bootCache, bots });
  const gw = await startGateway({ runtime: ownerRuntime, cfg, port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: hostedOpts, auth, sessionStore: store, bots, botsEnabled: () => true, remoteDir: dir });
  /** What a device does: a fetch that carries the allowlisted Host over https and lands on the in-process hosted gateway. */
  const bridge = (): typeof fetch => (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const headers: Record<string, string> = { ...H, ...Object.fromEntries(new Headers(init?.headers).entries()) };
    const r = await http(gw.url, (init?.method ?? "GET") as string, u.pathname + u.search, { headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  /** Signs in as a user the way the web/phone app does (POST /auth/key) and returns the session cookie. */
  const cookieFor = async (key: string): Promise<Record<string, string>> => {
    const r = await http(gw.url, "POST", "/auth/key", { headers: H, body: { key } });
    const sc = r.headers["set-cookie"];
    const first = (Array.isArray(sc) ? sc[0] : String(sc ?? "")).split(";")[0];
    return { ...H, cookie: first };
  };
  const as = async (key: string) => { const h = await cookieFor(key); return (method: string, path: string, body?: unknown) => http(gw.url, method, path, { headers: h, body }); };
  return { gw, fake, keys, store, dir, provider, bridge, as, host: (key: string, method: string, path: string, body?: unknown) => http(gw.url, method, path, { headers: { ...H, "x-mind-key": key }, body }), close: async () => { await gw.close(); await fake.close(); } };
}

export type HostedRig = Awaited<ReturnType<typeof hostedRig>>;

export async function deskRig(hosted: HostedRig, userKey: string, o: { script?: ConstructorParameters<typeof FakeProvider>[0]; intervalMs?: number; sync?: boolean; deviceId?: string; deviceName?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "daebot-desk-"));
  const provider = new FakeProvider(o.script ?? [{ text: "desktop says hi" }]);
  const cfg = baseCfg({ mindBaseUrl: hosted.fake.base, mindApiKey: userKey });
  const store = createFileStore(dir);
  const bots = { dir, bus: {} as { current?: unknown }, manage: {} };
  const runtime = createRuntime(cfg, { provider, store, bots: bots as never, bootCache: new BootCache() });
  const st = tmpStatic();
  const gw = await startGateway({
    runtime, cfg, port: 0, staticDir: st.dir, tokenPath: join(dir, "tok"), bots: bots as never, botsEnabled: () => true, sessionStore: store,
    sync: o.sync === false ? undefined : { enabled: true, url: "https://daebot.live", fetchImpl: hosted.bridge(), intervalMs: o.intervalMs ?? 150, deviceId: o.deviceId ?? "d_" + "1".repeat(16), deviceName: o.deviceName ?? "Test Mac", remoteWaitSec: 2 },
  });
  const a = bearer(gw.token);
  return { gw, store, dir, provider, a, api: (method: string, path: string, body?: unknown) => http(gw.url, method, path, { headers: a, body }), close: () => gw.close() };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until<T>(fn: () => T | Promise<T>, ms = 8000, step = 40): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(step);
  }
}
