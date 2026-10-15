// Dev server: the real gateway + web UI over a scripted fake Runtime (no models, no MIND).
//   node src/gateway/dev-fake.ts            (PORT=7788 by default, HOST=127.0.0.1)
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentSession, Runtime, Violation } from "../types.ts";
import { startGateway } from "./index.ts";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
  });

export function createFakeRuntime(opts: { speed?: number } = {}): Runtime {
  const speed = opts.speed ?? 1;
  const sessions = new Map<string, { id: string; surface: string; title: string; updatedAt: number }>();
  let n = 0;
  let calls = 0;

  function make(id: string, surface: string): AgentSession {
    const violations: Violation[] = [
      { at: Date.now() - 90_000, sessionId: id, gate: "receipt", action: "block", enforced: false, reason: "Claim 'it is deployed' has no SURFACE✓ receipt from this turn; open the live page first." },
    ];
    let userMsgs = 0;
    let total = 0;
    return {
      id, surface,
      violations: () => violations.slice(),
      close: async () => {},
      async *send(msg: string, o?: { signal?: AbortSignal }): AsyncIterable<AgentEvent> {
        const signal = o?.signal;
        userMsgs++;
        const wait = (ms: number) => sleep(ms * speed, signal);
        const words = (s: string) => s.split(/(?<=\s)/);
        const wantsEmail = /email|confirm/i.test(msg);
        let final = "";
        const say = async function* (s: string): AsyncGenerator<AgentEvent> {
          for (const w of words(s)) { final += w; yield { type: "text", delta: w }; await wait(22); }
        };
        const tool = async function* (name: string, args: Record<string, unknown>, ok: boolean, preview: string): AsyncGenerator<AgentEvent> {
          const receiptId = `c${++calls}`;
          yield { type: "toolStart", receiptId, tool: name, args };
          await wait(650);
          yield { type: "toolEnd", receiptId, tool: name, ok, preview };
        };
        try {
          yield* say("Checking MIND before I answer.\n\n");
          yield* tool("mind_query", { query: "What is the current state of the gateway work?" }, true,
            "Gateway: HTTP + WebSocket, token auth, static web UI. Open item: channel webhook adapters.");
          yield* say("MIND says the gateway is in build. Here is the shape of it:\n\n- **Transport:** HTTP, SSE and a hand-written WebSocket\n- **Auth:** bearer token, `0600` file\n- **Surfaces:** terminal, web, desktop\n\n");
          yield { type: "gate", verdict: { gate: "receipt", action: "block", reason: "Draft claims 'shipped' without a SURFACE✓ receipt; verify on the live surface first." }, enforced: true };
          yield* tool("bash", { command: "curl -s http://127.0.0.1:7777/health" }, true, '{"ok":true,"name":"mindclaw-gateway","sessions":1}');
          yield { type: "gate", verdict: { gate: "owner", action: "rewrite", reason: "owner_check added: Astra AI == Astra AI." }, enforced: false };
          yield* tool("read", { path: "/tmp/missing.txt" }, false, "ENOENT: no such file or directory");
          if (wantsEmail) {
            yield* say("I have a draft ready. It reaches a real person, so I need your go.\n");
            yield { type: "confirm", id: `k${userMsgs}`, tool: "send_email", args: { to: "jane@example.com", subject: "Gateway status", body: "Hi Jane, the gateway is live on localhost. Notes attached." }, reason: "Outward action: emails a real third party. Reply 'send it' to approve." };
          } else {
            yield* say("Verified on the live health route: it answers `ok`.\n\n```ts\nconst gw = await startGateway({ runtime, port: 7777 });\nconsole.log(gw.url);\n```\n\nTry a message with the word *email* to see the confirmation card.");
          }
          const cost = 0.0042 + userMsgs * 0.0017;
          total += cost;
          yield { type: "usage", usage: { promptTokens: 1840 + userMsgs * 220, completionTokens: 312, costUsd: cost }, totalCostUsd: total };
          yield { type: "done", finalText: final };
        } catch (e) {
          if (signal?.aborted) return;
          throw e;
        }
      },
    };
  }

  return {
    async openSession(o) {
      const id = o.resumeId ?? `s${++n}-${Math.random().toString(36).slice(2, 7)}`;
      const meta = sessions.get(id) ?? { id, surface: o.surface, title: o.title ?? "New session", updatedAt: Date.now() };
      sessions.set(id, meta);
      return make(id, o.surface);
    },
    listSessions: () => [...sessions.values()],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const runtime = createFakeRuntime();
  // seed one older, non-live session so resume can be tried
  void runtime.openSession({ surface: "web", title: "Earlier: claims triage", resumeId: "seed-claims" }).then((s) => s.close());
  const gw = await startGateway({
    runtime,
    port: Number(process.env.PORT ?? 7788),
    host: process.env.HOST ?? "127.0.0.1",
    tokenPath: join(homedir(), ".mindclaw", "dev-fake-token"), // dev-only token, separate from the real gateway token
  });
  console.log(`MINDClaw gateway (FAKE runtime) listening\n  ${gw.url}/?token=${gw.token}`);
  const stop = () => void gw.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
