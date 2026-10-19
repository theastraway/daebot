// Gateway child-process lifecycle. All process creation goes through the injected `spawn`, so this is testable
// with a fake child. Only the child THIS object spawned is ever signalled (no pkill, no process-table scans).
import { EventEmitter } from "node:events";

export const READY_MARKER = "mindclaw";

/** Parse one stdout line. Returns {url, token?} for a ready line, {error} for an error line, or null. */
export function parseReadyLine(line) {
  const s = String(line).trim();
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s);
      // `daebot serve` (the compiled binary) prints {"mindclawGateway":{"url":...,"token":...}}.
      const g = j && j.mindclawGateway;
      if (g && typeof g.url === "string") return { url: g.url, token: typeof g.token === "string" ? g.token : undefined };
      if (j && j[READY_MARKER] === "ready" && typeof j.url === "string") return { url: j.url, token: typeof j.token === "string" ? j.token : undefined };
      if (j && j[READY_MARKER] === "error") return { error: String(j.message ?? "gateway failed to start").slice(0, 300) };
    } catch { /* not ours */ }
    return null;
  }
  // Fallback for the stock `mindclaw serve` banner: "MINDClaw gateway on http://127.0.0.1:7777 (token in ...)".
  const m = /^MINDClaw gateway on (https?:\/\/\S+)/.exec(s);
  return m ? { url: m[1] } : null;
}

export class ChildGateway extends EventEmitter {
  /**
   * @param {object} o
   * @param {(cmd:string,args:string[],opts:object)=>import("node:child_process").ChildProcess} o.spawn
   * @param {() => {command:string,args:string[],env:Record<string,string>,cwd?:string}} o.plan builds a fresh spawn plan each start
   * @param {number} [o.readyTimeoutMs]
   * @param {number} [o.killGraceMs]
   * @param {(url:string)=>Promise<string|undefined>} [o.readToken] used only if the ready line carries no token
   */
  constructor(o) {
    super();
    this.spawn = o.spawn;
    this.plan = o.plan;
    this.readyTimeoutMs = o.readyTimeoutMs ?? 20_000;
    this.killGraceMs = o.killGraceMs ?? 3_000;
    this.readToken = o.readToken;
    this.child = null;
    this.info = null;
    this.stopping = false;
  }

  get running() { return this.child !== null && this.info !== null; }

  /** Spawn and resolve with {url, token} once the ready line arrives. Rejects on exit, error line or timeout. */
  start() {
    if (this.child) return Promise.reject(new Error("gateway child already started"));
    const plan = this.plan();
    this.stopping = false;
    // stdin stays a pipe on purpose: the child exits if we die without signalling it (stdin 'end').
    const child = this.spawn(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    return new Promise((resolve, reject) => {
      let settled = false;
      let buf = "";
      let tail = "";
      const finish = (err, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) { this._forget(child); this._killQuietly(child); reject(err); } else resolve(val);
      };
      const timer = setTimeout(() => finish(new Error("gateway did not report ready in time")), this.readyTimeoutMs);
      // Not unref'd: while start() is pending this timer is what settles it; unref'd, an idle event loop drains with the promise pending. finish() always clears it.
      child.stdout?.setEncoding?.("utf8");
      child.stdout?.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (settled) continue;
          const r = parseReadyLine(line);
          if (!r) continue;
          if (r.error) return finish(new Error(r.error));
          // The human banner carries no token; `daebot serve` prints the JSON line (with the token) right after it, so wait for that.
          if (!r.token && !this.readToken) continue;
          Promise.resolve(r.token ? r.token : this.readToken?.(r.url)).then((token) => {
            if (!token) return finish(new Error("gateway ready but no token available"));
            this.info = { url: r.url, token };
            finish(null, this.info);
          }, (e) => finish(e instanceof Error ? e : new Error(String(e))));
        }
      });
      child.stderr?.setEncoding?.("utf8");
      child.stderr?.on("data", (c) => { tail = (tail + c).slice(-400); this.emit("log", String(c)); });
      child.once("error", (e) => finish(e instanceof Error ? e : new Error(String(e))));
      child.once("exit", (code, signal) => {
        const wasCurrent = this.child === child;
        if (wasCurrent) { this.child = null; this.info = null; }
        if (!settled) finish(new Error(`gateway exited before ready (code ${code ?? signal})${tail ? `: ${tail.trim().split("\n").pop()}` : ""}`));
        else if (wasCurrent && !this.stopping) this.emit("crashed", { code, signal });
      });
    });
  }

  /** SIGTERM our child, SIGKILL after the grace period. Resolves once it has exited. Safe to call twice. */
  stop() {
    const child = this.child;
    if (!child) return Promise.resolve();
    this.stopping = true;
    return new Promise((resolve) => {
      let done = false;
      const end = () => { if (done) return; done = true; clearTimeout(grace); this._forget(child); resolve(); };
      const grace = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } end(); }, this.killGraceMs);
      // Not unref'd: the SIGKILL escalation must be able to fire. end() always clears it.
      child.once("exit", end);
      try { child.kill("SIGTERM"); } catch { end(); }
    });
  }

  /** Stop then start with a freshly built plan (so a new kernel mode takes effect). */
  async restart() {
    await this.stop();
    return this.start();
  }

  _forget(child) { if (this.child === child) { this.child = null; this.info = null; } }
  _killQuietly(child) { try { child.kill("SIGTERM"); } catch { /* already gone */ } }
}

/** Poll GET <url>/health until {ok:true}. fetchImpl is injected for tests. */
export async function waitForHealth(url, { fetchImpl = fetch, timeoutMs = 10_000, intervalMs = 150, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  for (;;) {
    try {
      const res = await fetchImpl(new URL("/health", url).toString(), { headers: { accept: "application/json" } });
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        if (j && j.ok === true) return true;
        last = "health not ok";
      } else last = `HTTP ${res.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (Date.now() >= deadline) throw new Error(`gateway /health did not answer: ${last}`);
    await sleep(intervalMs);
  }
}
