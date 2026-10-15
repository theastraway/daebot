// Runtime: wires MindClient, boot, kernel, tools and provider into AgentSessions.
import { randomUUID } from "node:crypto";
import { DailyCostCap, filterHostedTools } from "./hosted.ts";
import { createKernel, parseTier } from "./kernel/index.ts";
import type { Tier } from "./kernel/index.ts";
import { tierAllows } from "./kernel/tier.ts";
import { createAgentSession } from "./loop.ts";
import { bootMind, createMindClient, createMindTools, createSessionSync } from "./mind/index.ts";
import { BootCache } from "./mind/boot-cache.ts";
import { createProvider } from "./provider/index.ts";
import { createBuiltinTools } from "./tools/index.ts";
import { HistoryRecorder } from "./events.ts";
import { createMcpLoader, parseMcpServers } from "./mcp/client.ts";
import type { McpServerConfig } from "./mcp/client.ts";
import { repairMessages } from "./persist.ts";
import type { SessionStore } from "./persist.ts";
import type { AgentEvent, AgentSession, Config, HistoryEvent, Provider, Runtime } from "./types.ts";

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

interface Entry { session: AgentSession; surface: string; title: string; updatedAt: number; tier: Tier; recorder: HistoryRecorder; createdAt: number }

const DEFAULT_TITLE = /^(New session|Daebot .+ session)$/;

export interface HostedRuntimeOptions {
  /** Daily spend cap in USD for the whole process (UTC day). */
  dailyUsdCap: number;
  now?: () => Date;
}

export interface RuntimeOverrides {
  provider?: Provider;
  fetchImpl?: typeof fetch;
  hosted?: HostedRuntimeOptions;
  /** Session persistence (DATA_DIR). Absent = sessions live in memory only, as before. */
  store?: SessionStore;
  bootCache?: BootCache;
  /** Remote MCP servers (default: parsed from MINDCLAW_MCP_SERVERS). */
  mcpServers?: McpServerConfig[];
  mcpFetch?: typeof fetch;
}

export function createRuntime(cfg: Config, overrides: RuntimeOverrides = {}): Runtime {
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
  const store = overrides.store;
  const bootCache = overrides.bootCache ?? new BootCache();
  // Remote MCP tools (operator-configured). Added after the hosted filter on purpose: the operator chose them,
  // and every one of them is class "outward" unless the config says otherwise, so the danger gate asks first.
  let mcpServers = overrides.mcpServers;
  if (!mcpServers) {
    const parsed = parseMcpServers(process.env.MINDCLAW_MCP_SERVERS);
    for (const p of parsed.problems) process.stderr.write(`mcp: ${p}\n`);
    mcpServers = parsed.servers;
  }
  const mcp = createMcpLoader({ servers: mcpServers, fetchImpl: overrides.mcpFetch });
  if (mcp.configured) void mcp.tools(0); // warm up in the background so the first chat does not wait

  function persist(id: string): void {
    const e = sessions.get(id);
    const st = e?.session.exportState?.();
    if (!store || !e || !st) return;
    void store.save({
      v: 1, id, surface: e.surface, title: e.title, tier: e.tier, createdAt: e.createdAt, updatedAt: e.updatedAt,
      state: st, violations: e.session.violations(), history: e.recorder.events(),
    }).catch((err) => process.stderr.write(`persist: could not save a session (${String((err as Error)?.message ?? err).split("\n")[0].slice(0, 120)})\n`));
  }

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
      // Resume after a restart: rebuild from the persisted record (same identity tier only).
      const stored = opts.resumeId ? store?.load(opts.resumeId) : undefined;
      if (stored && stored.tier !== tier) throw new Error("session belongs to a different identity tier");
      const title = stored?.title || opts.title || `Daebot ${opts.surface} session`;
      const cwd = process.cwd();
      const sourceKey = `mindclaw-${opts.surface}-${id}`;
      const sync = createSessionSync(sessionClient, sourceKey);
      // Tools a tier may not use are neither offered nor executable (the loop only knows this list).
      const allWithMcp = mcp.configured ? [...allTools, ...(await mcp.tools())] : allTools;
      const tools = tier === "admin" ? allWithMcp : allWithMcp.filter((t) => tierAllows(tier, t));

      let boot: { ok: boolean; context: string; error?: string; degraded?: boolean };
      try { boot = await bootCache.get(cfg.mindApiKey, () => bootMind(client)); } catch (e) { boot = { ok: false, context: "", error: String((e as Error)?.message ?? e) }; }
      try { await sync.open({ title, sourceKey, externalId: id }); } catch { /* sync is best effort */ }

      const bootContext = boot.ok ? boot.context : "";
      const inner = createAgentSession({
        id, surface: opts.surface, provider, kernel: kernelFor(tier), tools, sync, cfg, cwd, bootContext,
        systemPrompt: composeSystemPrompt({ tier, bootContext, surface: opts.surface, cwd }),
        restore: stored ? { ...stored.state, messages: repairMessages(stored.state.messages), violations: stored.violations } : undefined,
      });

      const entry: Entry = {
        session: inner, surface: stored?.surface ?? opts.surface, title, updatedAt: Date.now(), tier,
        recorder: new HistoryRecorder(stored?.history), createdAt: stored?.createdAt ?? Date.now(),
      };
      const startNotices: AgentEvent[] = boot.ok ? [] : [{
        type: "notice", level: "warn",
        text: `MIND boot failed (${(boot.error ?? "unreachable").split("\n")[0].slice(0, 160)}); running unbooted, MIND tools are gated until mind_context succeeds.`,
      }];

      // A degraded (but working) boot is one info notice, shown at the end of the first turn: never a headline.
      let degradedNotice: AgentEvent | undefined = boot.ok && boot.degraded
        ? { type: "notice", level: "info", text: `MIND context loaded from the fallback path (${(boot.error ?? "mind_context was slow").split("\n")[0].slice(0, 160)}).` }
        : undefined;

      let lastTotal = stored?.state.totalCostUsd ?? 0; // session-cumulative cost already counted against the daily cap
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
          if (DEFAULT_TITLE.test(entry.title) && !entry.recorder.events().some((h) => h.type === "user")) entry.title = msg.trim().slice(0, 60) || entry.title;
          entry.recorder.user(msg);
          while (startNotices.length) { const n = startNotices.shift()!; entry.recorder.push(n); yield n; }
          for await (const ev of inner.send(msg, o)) {
            entry.recorder.push(ev);
            if (ev.type === "done") { entry.updatedAt = Date.now(); persist(id); }
            if (ev.type === "usage" && costCap) {
              // totalCostUsd is cumulative for the session: add only the delta (fall back to the per-call cost).
              const delta = ev.totalCostUsd >= lastTotal ? ev.totalCostUsd - lastTotal : ev.usage.costUsd;
              lastTotal = ev.totalCostUsd;
              costCap.add(delta);
            }
            if (ev.type === "done" && degradedNotice) { entry.recorder.push(degradedNotice); yield degradedNotice; degradedNotice = undefined; }
            yield ev;
          }
          entry.updatedAt = Date.now();
        },
        violations: () => inner.violations(),
        exportState: () => inner.exportState!(),
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
      const out = new Map<string, { id: string; surface: string; title: string; updatedAt: number }>();
      for (const m of store?.list() ?? []) out.set(m.id, m);
      for (const [id, e] of sessions) if (out.has(id) || e.recorder.events().some((h) => h.type === "user")) out.set(id, { id, surface: e.surface, title: e.title, updatedAt: e.updatedAt });
      return [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    },
    history(id): HistoryEvent[] | undefined {
      const live = sessions.get(id);
      if (live) return live.recorder.events();
      return store?.load(id)?.history;
    },
  };
}
