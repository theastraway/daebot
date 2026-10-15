// Scripted demo: runs the real TUI against an in-memory fake Runtime.
//   node src/ui/demo.ts                       interactive when attached to a terminal
//   printf 'hi\n/cost\n' | node src/ui/demo.ts   plain line mode
// Try: "hello", "run the tool", "email bob the report" (gate + confirm), then "send it", "write a long story" (Ctrl+C it).
import type { AgentEvent, AgentSession, Runtime, Violation } from "../types.ts";
import { runTui } from "./index.ts";

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res) => {
  if (signal?.aborted) return res();
  const t = setTimeout(res, ms); signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
});

export function createDemoRuntime(opts: { delayMs?: number } = {}): Runtime {
  const delay = opts.delayMs ?? 18;
  const sessions: { id: string; surface: string; title: string; updatedAt: number }[] = [];
  let n = 0;
  return {
    async openSession({ surface, title, resumeId }) {
      const id = resumeId ?? `demo-${(++n).toString().padStart(4, "0")}-${Math.random().toString(16).slice(2, 10)}`;
      if (!sessions.find((s) => s.id === id)) sessions.push({ id, surface, title: title ?? "Demo", updatedAt: Date.now() });
      const violations: Violation[] = [];
      let totalCost = 0;
      let awaiting = false;
      let pendingMindReply = true;
      const session: AgentSession = {
        id, surface,
        async *send(msg: string, o?: { signal?: AbortSignal }): AsyncGenerator<AgentEvent> {
          const signal = o?.signal;
          const say = async function* (text: string): AsyncGenerator<AgentEvent> {
            for (const chunk of text.match(/[\s\S]{1,7}/g) ?? []) { if (signal?.aborted) return; yield { type: "text", delta: chunk }; await sleep(delay, signal); }
          };
          const usage = (cost: number): AgentEvent => { totalCost += cost; return { type: "usage", usage: { promptTokens: 1200, completionTokens: 340, costUsd: cost }, totalCostUsd: totalCost }; };
          if (pendingMindReply) { pendingMindReply = false; yield { type: "notice", level: "info", text: "1 pending MIND reply: \"Use the Q3 numbers, not Q2.\" (from MIND Chat)" }; }
          if (/^\s*(send it|do it|yes run it|go ahead)/i.test(msg) && awaiting) {
            awaiting = false;
            yield { type: "toolStart", receiptId: "c3", tool: "send_email", args: { to: "bob@example.com", subject: "Report" } };
            await sleep(150, signal);
            yield { type: "toolEnd", receiptId: "c3", tool: "send_email", ok: true, preview: "delivered (id em_9f2a)" };
            yield* say("Sent. Bob has the report; you are BCC'd.\n");
            yield usage(0.0021);
            yield { type: "done", finalText: "Sent." };
            return;
          }
          if (/email|send/i.test(msg)) {
            yield { type: "toolStart", receiptId: "c1", tool: "mind_query", args: { query: "Who is Bob and what is his address?" } };
            await sleep(200, signal);
            yield { type: "toolEnd", receiptId: "c1", tool: "mind_query", ok: true, preview: "Bob Lee, bob@example.com, vendor contact" };
            yield* say("I drafted the email to **Bob Lee**. ");
            const verdict = { gate: "danger", action: "needs-confirmation" as const, reason: "send_email reaches a real person: needs your explicit go-ahead before I run it." };
            violations.push({ at: Date.now(), sessionId: id, gate: "danger", action: "needs-confirmation", reason: verdict.reason, enforced: true });
            yield { type: "gate", verdict, enforced: true };
            yield { type: "confirm", id: "conf-1", tool: "send_email", args: { to: "bob@example.com", subject: "Report", body: "Hi Bob, attached is the report." }, reason: verdict.reason };
            awaiting = true;
            yield usage(0.0034);
            yield { type: "done", finalText: "Waiting for confirmation." };
            return;
          }
          if (/long|story/i.test(msg)) {
            for (let i = 1; i <= 60; i++) { if (signal?.aborted) break; yield* say(`Paragraph ${i}: the quick brown fox keeps going and going.\n\n`); }
            yield { type: "done", finalText: "" };
            return;
          }
          // default: markdown reply, a tool call, a shadow-mode gate
          yield* say("Here is what I found. The **receipt gate** checks claims, and `mind_query` returns evidence.\n\n");
          yield { type: "toolStart", receiptId: "c1", tool: "read", args: { path: "/repo/src/loop.ts", limit: 40 } };
          await sleep(250, signal);
          yield { type: "toolEnd", receiptId: "c1", tool: "read", ok: true, preview: "export function createAgentSession(deps) {\n  const state = newTurnState();\n  // ...\n}\n(40 lines)" };
          const shadow = { gate: "receipt", action: "block" as const, reason: "Claim 'built' has no SURFACE✓ receipt from this turn: run a read of the surface first." };
          violations.push({ at: Date.now(), sessionId: id, gate: "receipt", action: "block", reason: shadow.reason, enforced: false });
          yield { type: "gate", verdict: shadow, enforced: false };
          yield* say("Steps:\n\n- read the file\n- check the **gate** wiring\n- see [the spec](https://example.com/spec)\n\n```ts\nexport const answer = 42;\n// a long line to show the left rule wrapping behaviour for code that is wider than the terminal can possibly be\n```\n\nDone reading.\n");
          yield usage(0.0012);
          yield { type: "done", finalText: "Here is what I found." };
        },
        violations: () => violations,
        async close() { /* nothing to flush */ },
      };
      return session;
    },
    listSessions: () => sessions.map((s) => ({ ...s })),
  };
}

const isMain = import.meta.filename === process.argv[1];
if (isMain) {
  runTui({ mode: "local", runtime: createDemoRuntime() }).then((code) => process.exit(code));
}
