// Runtime: wires MindClient, boot, kernel, tools and provider into AgentSessions.
import { randomUUID } from "node:crypto";
import { DailyCostCap, filterHostedTools } from "./hosted.ts";
import { createKernel, parseTier } from "./kernel/index.ts";
import type { Tier } from "./kernel/index.ts";
import { tierAllows } from "./kernel/tier.ts";
import { createAgentSession } from "./loop.ts";
import { bootMind, createMindClient, createMindTools, createSessionSync } from "./mind/index.ts";
import { createProvider } from "./provider/index.ts";
import { createBuiltinTools } from "./tools/index.ts";
import type { AgentEvent, AgentSession, Config, Provider, Runtime } from "./types.ts";

export function composeSystemPrompt(o: { identity?: string; tier?: Tier; bootContext: string; surface: string; cwd: string; now?: Date }): string {
  const lines = [
    o.identity ?? "You are Daebot (Dae), Anthony Conti's own agent. MIND is your memory and the only source of truth about his world.",
    "Register: chat replies are caveman-short. Short sentences, no preamble. Anything that ships (code, emails, docs) stays polished.",
    "Receipts: tool results carry ids like [#c3]. Before you claim something exists or does not exist, say done/built/live/working, or state a number, price, email, name or id, put a receipt line on its own line first:",
    "  MIND✓ #cN <what you asked> -> <what it returned>",
    "  SURFACE✓ #cN <what you looked at> -> <what you saw>",
    "cN must be a tool call from this turn. No receipt means you are guessing: go get it.",
    "Never post to the public feed or social surfaces unless the user explicitly says post, share, tweet or feed. Never contact a third party or do anything irreversible without an explicit go-ahead.",
    "When a tool result says blocked or not executed, follow its instruction instead of retrying the same call.",
    `Surface: ${o.surface}. Working directory: ${o.cwd}. Date: ${(o.now ?? new Date()).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric" })} (America/New_York).`,
  ];
  if (o.tier === "public") lines.push("Identity: public. You can read and answer only. You cannot write, send, post, run a shell or change anything; say so plainly if asked.");
  if (o.tier === "staff") lines.push("Identity: staff. You can read and make local writes. You cannot contact third parties, post publicly or do anything irreversible; say so plainly if asked.");
  if (o.bootContext.trim()) lines.push("", "## MIND context (booted this session)", o.bootContext.trim());
  return lines.join("\n");
}

interface Entry { session: AgentSession; surface: string; title: string; updatedAt: number; tier: Tier }

export interface HostedRuntimeOptions {
  /** Daily spend cap in USD for the whole process (UTC day). */
  dailyUsdCap: number;
  now?: () => Date;
}

export function createRuntime(cfg: Config, overrides: { provider?: Provider; fetchImpl?: typeof fetch; hosted?: HostedRuntimeOptions } = {}): Runtime {
  const hosted = overrides.hosted;
  // Hosted: the kernel is always on and always enforcing, whatever the env says.
  if (hosted) cfg = { ...cfg, kernel: true, shadow: false };
  const costCap = hosted ? new DailyCostCap(hosted.dailyUsdCap, hosted.now) : undefined;
  const client = createMindClient(cfg, overrides.fetchImpl);
  const provider = overrides.provider ?? createProvider(cfg, overrides.fetchImpl);
  // Agent Session sync may need a different key (chat:write); falls back to the main key.
  const sessionClient = cfg.mindSessionApiKey && cfg.mindSessionApiKey !== cfg.mindApiKey
    ? createMindClient({ ...cfg, mindApiKey: cfg.mindSessionApiKey }, overrides.fetchImpl)
    : client;
  const everyTool = [...createBuiltinTools({ fetchImpl: overrides.fetchImpl }), ...createMindTools(client)];
  // Hosted: shell and file tools are not just gated, they do not exist in this process's tool list.
  const allTools = hosted ? filterHostedTools(everyTool) : everyTool;
  // One kernel per identity tier (each enforces its tier's tool classes on top of the shared gates).
  const kernels = new Map<Tier, ReturnType<typeof createKernel>>();
  const kernelFor = (tier: Tier) => {
    let k = kernels.get(tier);
    if (!k) { k = createKernel({ shadow: cfg.shadow, enabled: cfg.kernel, clientNames: cfg.clientNames, tier, hosted: !!hosted }); kernels.set(tier, k); }
    return k;
  };
  const sessions = new Map<string, Entry>();

  return {
    async openSession(opts) {
      const tier = parseTier(opts.identity);
      if (opts.resumeId) {
        const existing = sessions.get(opts.resumeId);
        if (existing) {
          if (existing.tier !== tier) throw new Error("session belongs to a different identity tier");
          return existing.session;
        }
      }
      const id = opts.resumeId ?? randomUUID();
      const title = opts.title ?? `Daebot ${opts.surface} session`;
      const cwd = process.cwd();
      const sourceKey = `mindclaw-${opts.surface}-${id}`;
      const sync = createSessionSync(sessionClient, sourceKey);
      // Tools a tier may not use are neither offered nor executable (the loop only knows this list).
      const tools = tier === "admin" ? allTools : allTools.filter((t) => tierAllows(tier, t));

      let boot: { ok: boolean; context: string; error?: string; degraded?: boolean };
      try { boot = await bootMind(client); } catch (e) { boot = { ok: false, context: "", error: String((e as Error)?.message ?? e) }; }
      try { await sync.open({ title, sourceKey, externalId: id }); } catch { /* sync is best effort */ }

      const bootContext = boot.ok ? boot.context : "";
      const inner = createAgentSession({
        id, surface: opts.surface, provider, kernel: kernelFor(tier), tools, sync, cfg, cwd, bootContext,
        systemPrompt: composeSystemPrompt({ tier, bootContext, surface: opts.surface, cwd }),
      });

      const entry: Entry = { session: inner, surface: opts.surface, title, updatedAt: Date.now(), tier };
      const startNotices: AgentEvent[] = boot.ok ? [] : [{
        type: "notice", level: "warn",
        text: `MIND boot failed (${(boot.error ?? "unreachable").split("\n")[0].slice(0, 160)}); running unbooted, MIND tools are gated until mind_context succeeds.`,
      }];

      // A degraded (but working) boot is one info notice, shown at the end of the first turn: never a headline.
      let degradedNotice: AgentEvent | undefined = boot.ok && boot.degraded
        ? { type: "notice", level: "info", text: `MIND context loaded from the fallback path (${(boot.error ?? "mind_context was slow").split("\n")[0].slice(0, 160)}).` }
        : undefined;

      let lastTotal = 0; // session-cumulative cost already counted against the daily cap
      const session: AgentSession = {
        id: inner.id,
        surface: inner.surface,
        async *send(msg, o) {
          entry.updatedAt = Date.now();
          if (costCap?.exceeded()) {
            yield { type: "notice", level: "warn", text: costCap.notice() };
            yield { type: "done", finalText: "" };
            return;
          }
          while (startNotices.length) yield startNotices.shift()!;
          for await (const ev of inner.send(msg, o)) {
            if (ev.type === "usage" && costCap) {
              // totalCostUsd is cumulative for the session: add only the delta (fall back to the per-call cost).
              const delta = ev.totalCostUsd >= lastTotal ? ev.totalCostUsd - lastTotal : ev.usage.costUsd;
              lastTotal = ev.totalCostUsd;
              costCap.add(delta);
            }
            if (ev.type === "done" && degradedNotice) { yield degradedNotice; degradedNotice = undefined; }
            yield ev;
          }
          entry.updatedAt = Date.now();
        },
        violations: () => inner.violations(),
        async close(summary) {
          sessions.delete(id);
          await inner.close(summary);
        },
      };
      entry.session = session;
      sessions.set(id, entry);
      return session;
    },
    listSessions() {
      return [...sessions.entries()].map(([id, e]) => ({ id, surface: e.surface, title: e.title, updatedAt: e.updatedAt }));
    },
  };
}
