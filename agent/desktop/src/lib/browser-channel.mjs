// Desktop side of the browser bridge. Long-poll GET /browser/poll, run the command on the pane, POST /browser/result.
// Auth is the gateway bearer token, the same header as POST /screen/frame. The token is never written to the log.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{ fetch: Function, origin: string, token: string, pane: { handle: Function, snapshot: Function, subscribe?: Function },
 *   log?: Function, waitMs?: number, retryMs?: number, sleep?: (ms: number) => Promise<void> }} opts
 */
export function startBrowserChannel(opts) {
  if (!opts || typeof opts.fetch !== "function") throw new Error("browser channel needs fetch");
  if (!opts.origin || !opts.token) throw new Error("browser channel needs the gateway origin and token");
  if (!opts.pane || typeof opts.pane.handle !== "function") throw new Error("browser channel needs a pane");
  const log = opts.log ?? (() => {});
  const wait = opts.sleep ?? sleep;
  const waitMs = opts.waitMs ?? 20000;
  const retryMs = opts.retryMs ?? 400;
  const headers = { authorization: `Bearer ${opts.token}` };
  const jsonHeaders = { ...headers, "content-type": "application/json" };
  let stopped = false;
  let posting = false;

  async function postState() {
    if (stopped || posting) return;
    posting = true;
    try {
      const snap = opts.pane.snapshot();
      await opts.fetch(`${opts.origin}/browser/state`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ ...snap, gatewayOrigin: opts.origin }),
      });
    } catch (e) {
      log("browser state failed:", String(e?.message ?? e).slice(0, 160));
    } finally { posting = false; }
  }

  async function postResult(id, body) {
    await opts.fetch(`${opts.origin}/browser/result`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ id, ...body }) });
  }

  async function runCommand(cmd) {
    try {
      const result = await opts.pane.handle(cmd.op, cmd.args ?? {});
      await postResult(cmd.id, { ok: true, result });
    } catch (e) {
      const error = String(e?.message ?? e).split("\n")[0].slice(0, 300);
      try { await postResult(cmd.id, { ok: false, error }); } catch (err) { log("browser result failed:", String(err?.message ?? err).slice(0, 160)); }
    }
    await postState();
  }

  async function loop() {
    while (!stopped) {
      try {
        const res = await opts.fetch(`${opts.origin}/browser/poll?waitMs=${waitMs}`, { headers });
        if (stopped) return;
        if (!res.ok) { await wait(retryMs); continue; }
        const body = await res.json();
        const commands = Array.isArray(body?.commands) ? body.commands : [];
        if (!commands.length) await wait(15);
        for (const cmd of commands) {
          if (stopped) return;
          if (!cmd || typeof cmd.id !== "string" || typeof cmd.op !== "string") continue;
          await runCommand(cmd);
        }
      } catch (e) {
        if (!stopped) {
          log("browser poll failed:", String(e?.message ?? e).slice(0, 160));
          await wait(retryMs);
        }
      }
    }
  }

  const unsub = typeof opts.pane.subscribe === "function" ? opts.pane.subscribe(() => { void postState(); }) : () => {};
  void postState();
  void loop();
  return {
    stop() { stopped = true; try { unsub(); } catch { /* ignore */ } },
  };
}
