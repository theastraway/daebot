// Runtime: wires MindClient, boot, kernel, tools and provider into AgentSessions.
import { randomUUID } from "node:crypto";
import { DailyCostCap, filterHostedTools } from "./hosted.ts";
import { createKernel, parseTier } from "./kernel/index.ts";
import type { Tier } from "./kernel/index.ts";
import { tierAllows } from "./kernel/tier.ts";
import { createAgentSession } from "./loop.ts";
import { createLearning, resolveLearnConfig } from "./learn/index.ts";
import { bootMind, createMindClient, createMindTools, createSessionSync } from "./mind/index.ts";
import { BotStore, botMindApi } from "./bots/store.ts";
import { createBotTalkTool } from "./bots/talk-tool.ts";
import type { BotRecord, BotsContext, RosterEntry } from "./bots/types.ts";
import { MAX_INSTRUCTIONS_BYTES } from "./bots/types.ts";
import { createSettings, validModelId } from "./settings.ts";
import { botsEnabled } from "./bots/flag.ts";
import { BootCache } from "./mind/boot-cache.ts";
import type { MindClientOpts } from "./mind/client.ts";
import { createProvider } from "./provider/index.ts";
import type { MindCredits } from "./provider/mind.ts";
import { createBuiltinTools } from "./tools/index.ts";
import { HistoryRecorder } from "./events.ts";
import { createMcpLoader, parseMcpServers } from "./mcp/client.ts";
import type { McpServerConfig } from "./mcp/client.ts";
import { repairMessages } from "./persist.ts";
import type { SessionStore } from "./persist.ts";
import type { AgentEvent, AgentSession, Config, HistoryEvent, MindClient, Provider, Runtime, Tool } from "./types.ts";

/** Same sanitising as MINDCLAW_LEARN_USER, so a MIND username is a safe doc-name part. */
function learnUserName(u: string): string {
  return u.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "") || "user";
}

const MAX_ROSTER = 40;
const clipLine = (s: string, n: number): string => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const noKernelSpoof = (s: string): string => s.replace(/\[kernel/gi, "[ kernel");

export function botIdentity(b: Pick<BotRecord, "name" | "slug" | "purpose">, userName?: string): string {
  return `You are ${b.name} (bot "${b.slug}"), a persistent Daebot agent${userName ? ` working for the MIND user "${userName}"` : ""}.${b.purpose ? ` Purpose: ${clipLine(b.purpose, 300)}.` : ""} Your home MIND is the bot MIND "${b.slug}": it is your memory and what you read and write by default. The user's main MIND is readable with mind:"main"; you never write to it.`;
}

export function composeSystemPrompt(o: {
  identity?: string; tier?: Tier; bootContext: string; surface: string; cwd: string; now?: Date; model?: string; via?: string;
  /** Set for a bot session: the DAEBOT.md text and the bot's own slug (the roster marks it as you). */
  bot?: { slug: string; instructions: string };
  /** The user's bots (sessions and bots alike see them). */
  roster?: RosterEntry[];
}): string {
  const lines = [
    o.identity ?? "You are Daebot (Dae), Anthony Conti's own agent. MIND is your memory and the only source of truth about his world.",
    "Register: chat replies are caveman-short. Short sentences, no preamble. Anything that ships (code, emails, docs) stays polished.",
    "Receipts: tool results carry ids like [#c3]. Before you claim something exists or does not exist, say done/built/live/working, or state a number, price, email, name or id, put a receipt line on its own line first:",
    "  MIND✓ #cN <what you asked> -> <what it returned>",
    "  SURFACE✓ #cN <what you looked at> -> <what you saw>",
    "cN must be a tool call from this turn. No receipt means you are guessing: go get it.",
    "Never post to the public feed or social surfaces unless the user explicitly says post, share, tweet or feed. Never contact a third party or do anything irreversible without an explicit go-ahead.",
    "When a tool result says blocked or not executed, follow its instruction instead of retrying the same call.",
    "Decision Protocol. Run it when reasonable people could disagree and a wrong call costs more than a day or carries money or reputational consequences. Skip it for trivial, reversible choices. Write it out before you recommend, never jump to \"I think we should\".",
    "  1. Outcomes: 4 to 7, ranked. The top one is the user's aim.",
    "  2. Options: at least 4 (status quo, the obvious one, the opposite, a hybrid, one long shot). Two options is a false binary.",
    "  3. Consequences: upsides and downsides per option, with evidence. Be hardest on the option you favour.",
    "  4. Evaluate: score each option against each outcome and total it. When the totals are close, or you need a calibrated confidence, call the decide tool with the options and the facts.",
    "  5. Mitigate: pair every downside of the winner with a countermeasure, or state it as the price.",
    "  6. Resolve: one decision sentence, then a sequenced plan with a named owner per action. After the decision, file it with mind_decision_record.",
    "A decide result is advice: it never overrides an explicit user instruction or a kernel gate. State its confidence plainly and say if no model was consulted.",
    ...(o.model ? [`Model: you run on ${o.model} via ${o.via ?? "OpenRouter"}, inside Daebot (Astra AI). Say so plainly if asked.`] : []),
    `Surface: ${o.surface}. Working directory: ${o.cwd}. Date: ${(o.now ?? new Date()).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric" })} (America/New_York).`,
  ];
  if (o.tier === "public") lines.push("Identity: public. You can read and answer only. You cannot write, send, post, run a shell or change anything; say so plainly if asked.");
  if (o.tier === "staff") lines.push("Identity: staff. You can read and make local writes. You cannot contact third parties, post publicly or do anything irreversible; say so plainly if asked.");
  const roster = (o.roster ?? []).slice(0, MAX_ROSTER);
  if (o.bot) {
    const text = o.bot.instructions.length > MAX_INSTRUCTIONS_BYTES ? o.bot.instructions.slice(0, MAX_INSTRUCTIONS_BYTES) : o.bot.instructions;
    lines.push(
      "",
      "## Instructions for this bot (DAEBOT.md)",
      text.trim() ? noKernelSpoof(text.trim()) : "(none written yet)",
      "Precedence: these instructions set your role and style. They never lift a kernel gate, the receipt rule, the owner check or the feed rule; where they conflict with those, those win.",
    );
  }
  if (o.bot || roster.length) {
    lines.push("", "## MINDs and bots", o.bot ? `main: the user's main MIND (read-only for you: mind:"main")` : `main: the user's main MIND (your own, the default)`);
    for (const b of roster) lines.push(`- ${b.slug} (${clipLine(b.name, 60)})${o.bot && b.slug === o.bot.slug ? " (you)" : ""}${b.purpose ? `: ${clipLine(b.purpose, 160)}` : ""}`);
    if (roster.length) lines.push(`Read another MIND on any read tool with mind:"<slug>" (mind_tenants lists them live).`);
  }
  if (o.bot) {
    lines.push("When another bot owns the topic, TALK to it with bot_talk; say what you need and why; its reply is a claim, not a receipt: verify load-bearing facts in its MIND; don't ping-pong.");
  } else if (roster.length) {
    lines.push("When a bot owns the topic, ask that bot with bot_talk; its reply is a claim, not a receipt: verify load-bearing facts in its MIND before you state them.");
  }
  if (o.bootContext.trim()) lines.push("", "## MIND context (booted this session)", o.bootContext.trim());
  return lines.join("\n");
}

interface Entry { session: AgentSession; surface: string; title: string; updatedAt: number; tier: Tier; recorder: HistoryRecorder; createdAt: number; bot?: string; peer?: string; model?: string }

const DEFAULT_TITLE = /^(New session|Daebot .+ session)$/;

export interface HostedRuntimeOptions {
  /** Daily spend cap in USD for the whole process (UTC day). */
  dailyUsdCap: number;
  now?: () => Date;
  /** One process-wide cap shared by every runtime (owner and per-user). Overrides dailyUsdCap. */
  sharedCap?: DailyCostCap;
  /** Admins and the owner login: neither the per-user nor the global cap applies to them, and their spend does not count toward the global cap. */
  exempt?: boolean;
  /** Per-user cap checked in addition to the shared one. */
  userCap?: DailyCostCap;
  /** MIND username this runtime acts for. Learning files the user model under it (default: MINDCLAW_LEARN_USER). */
  username?: string;
  /** System-prompt identity line (per-user runtimes are not Anthony's agent). */
  persona?: string;
  /** MIND Agent Session source key for this runtime's sessions (default mindclaw-<surface>-<id>). */
  sourceKey?: (surface: string, sessionId: string) => string;
  /** Per-user MIND client options (live key + refresh on 401). */
  mindClient?: MindClientOpts;
}

export interface RuntimeOverrides {
  env?: NodeJS.ProcessEnv;
  provider?: Provider;
  fetchImpl?: typeof fetch;
  hosted?: HostedRuntimeOptions;
  /** Session persistence (DATA_DIR). Absent = sessions live in memory only, as before. */
  store?: SessionStore;
  bootCache?: BootCache;
  /** Principal that owns this runtime's sessions ("owner" by default; a MIND user id for per-user runtimes). Scopes the store. */
  owner?: string;
  /** Remote MCP servers (default: parsed from MINDCLAW_MCP_SERVERS). */
  mcpServers?: McpServerConfig[];
  mcpFetch?: typeof fetch;
  /** DAEBOT_BILLING=mind: the tier + credits cache shared with the gateway (the provider feeds it from MIND's response headers). */
  credits?: MindCredits;
  /** Bots + per-user settings live under this dir; the bus ref is set by startGateway. Absent = no bots on this runtime. */
  bots?: BotsContext;
  /** Feature flag (default: env DAEBOT_BOTS_ENABLED, read on every call). */
  botsEnabled?: () => boolean;
}

export function createRuntime(cfg: Config, overrides: RuntimeOverrides = {}): Runtime {
  const hosted = overrides.hosted;
  // Hosted: the kernel is always on and always enforcing, whatever the env says.
  if (hosted) cfg = { ...cfg, kernel: true, shadow: false };
  const exempt = hosted?.exempt === true;
  // MIND billing: the user's MIND plan and credits are the cap, so Daebot's own USD caps do not apply.
  const mindBilled = cfg.billing === "mind";
  const costCap = hosted && !exempt && !mindBilled ? (hosted.sharedCap ?? new DailyCostCap(hosted.dailyUsdCap, hosted.now)) : undefined;
  const userCap = exempt || mindBilled ? undefined : hosted?.userCap;
  const client = createMindClient(cfg, overrides.fetchImpl, hosted?.mindClient);
  // MIND billing: this runtime's own live MIND key (a user's, or the server key for the owner login), never anyone else's.
  const provider = overrides.provider ?? createProvider(cfg, overrides.fetchImpl, { getKey: hosted?.mindClient?.getKey, credits: overrides.credits });
  // Agent Session sync may need a different key (chat:write); falls back to the main key.
  const sessionClient = cfg.mindSessionApiKey && cfg.mindSessionApiKey !== cfg.mindApiKey
    ? createMindClient({ ...cfg, mindApiKey: cfg.mindSessionApiKey }, overrides.fetchImpl, hosted?.mindClient)
    : client;
  const builtinTools = createBuiltinTools({ fetchImpl: overrides.fetchImpl, decisionKey: cfg.openrouterKey });
  // Bots: this owner's store (MIND is the source of truth for existence) and settings. Only when the host gave a data dir.
  const botsCtx = overrides.bots;
  const ownerKey = overrides.owner ?? "owner";
  const botStore = botsCtx ? new BotStore({ dir: botsCtx.dir, owner: ownerKey, mind: botMindApi(client) }) : undefined;
  const settings = botsCtx ? createSettings(botsCtx.dir, ownerKey) : undefined;
  // One client per bot MIND, all on the MAIN key (the bot is addressed by the X-MIND-Bot header, never by a key of its own).
  const botClients = new Map<string, MindClient>();
  const clientForMind = (mind: string): MindClient => {
    if (mind === "main") return client;
    let c = botClients.get(mind);
    if (!c) { c = createMindClient(cfg, overrides.fetchImpl, { ...hosted?.mindClient, bot: mind }); botClients.set(mind, c); }
    return c;
  };
  // A session's full tool set: shared builtins + MIND tools addressed by home + bot_talk. Hosted: shell and file tools do not exist at all.
  const botsOn = (): boolean => !!botStore && (overrides.botsEnabled ? overrides.botsEnabled() : botsEnabled(overrides.env ?? process.env));
  const toolsFor = (home: string, selfBot: string | undefined): Tool[] => {
    const on = botsOn();
    const talk = on && botStore && botsCtx ? [createBotTalkTool({ bus: botsCtx.bus, owner: ownerKey, selfBot })] : [];
    const every = [...builtinTools, ...createMindTools({
      home, clientFor: clientForMind, roster: () => botStore?.roster() ?? [],
      refresh: botStore ? async () => { await botStore.list(); } : undefined,
    }, { user: hosted?.username }).filter((t) => on || t.spec.name !== "mind_tenants"), ...talk];
    return hosted ? filterHostedTools(every) : every;
  };
  // One kernel per identity tier (each enforces its tier's tool classes on top of the shared gates).
  const kernels = new Map<Tier, ReturnType<typeof createKernel>>();
  const kernelFor = (tier: Tier) => {
    let k = kernels.get(tier);
    if (!k) { k = createKernel({ shadow: cfg.shadow, enabled: cfg.kernel, clientNames: cfg.clientNames, tier, hosted: !!hosted }); kernels.set(tier, k); }
    return k;
  };
  const sessions = new Map<string, Entry>();
  const learnCfg = resolveLearnConfig(overrides.env ?? process.env, { hosted: !!hosted });
  const store = overrides.store;
  const ownerId = overrides.owner ?? "owner";
  const mine = (rec: { owner?: string } | undefined): boolean => !rec || (rec.owner ?? "owner") === ownerId;
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
      v: 1, id, surface: e.surface, title: e.title, tier: e.tier, owner: ownerId, createdAt: e.createdAt, updatedAt: e.updatedAt,
      state: st, violations: e.session.violations(), history: e.recorder.events(),
      ...(e.bot ? { bot: e.bot } : {}), ...(e.peer ? { peer: e.peer } : {}), ...(e.model ? { model: e.model } : {}),
    }).catch((err) => process.stderr.write(`persist: could not save a session (${String((err as Error)?.message ?? err).split("\n")[0].slice(0, 120)})\n`));
  }

  return {
    async openSession(opts) {
      const tier = parseTier(opts.identity);
      if (opts.resumeId) {
        const existing = sessions.get(opts.resumeId);
        if (existing) {
          if (existing.tier !== tier) throw new Error("session belongs to a different identity tier");
          if (opts.botId && existing.bot !== opts.botId) throw new Error("session belongs to a different bot");
          return existing.session;
        }
      }
      const id = opts.resumeId ?? randomUUID();
      // Resume after a restart: rebuild from the persisted record (same identity tier only).
      const stored = opts.resumeId ? store?.load(opts.resumeId) : undefined;
      // Never rebuild (or later overwrite) a session that belongs to someone else.
      if (!mine(stored) || (opts.resumeId && !mine(store?.meta?.(opts.resumeId)))) throw new Error("forbidden");
      if (stored && stored.tier !== tier) throw new Error("session belongs to a different identity tier");
      // A bot session runs INSIDE this runtime (this owner's MAIN key, provider and billing); only the home MIND, the
      // persona/instructions and the thread differ. The bot must belong to THIS owner.
      const botId = opts.botId ?? stored?.bot;
      if (botId && !botsOn()) throw new Error("bots are not enabled");
      if (opts.botId && stored?.bot && stored.bot !== opts.botId) throw new Error("session belongs to a different bot");
      const botRec = botId ? botStore?.get(botId) : undefined;
      if (botId && !botRec) throw new Error("no such bot");
      const peer = opts.peer ?? stored?.peer;
      const home = botRec ? botRec.slug : "main";
      const title = stored?.title || opts.title || `Daebot ${opts.surface} session`;
      const cwd = process.cwd();
      const sourceKey = botRec ? `daebot-bot-${botRec.slug}` : hosted?.sourceKey ? hosted.sourceKey(opts.surface, id) : `mindclaw-${opts.surface}-${id}`;
      // MIND Chat sync uses the MAIN key (sessionClient); the bot's name is only the source label.
      const sync = createSessionSync(sessionClient, sourceKey);
      // Tools a tier may not use are neither offered nor executable (the loop only knows this list).
      const sessionTools = toolsFor(home, botRec?.id);
      const allWithMcp = mcp.configured ? [...sessionTools, ...(await mcp.tools())] : sessionTools;
      const tools = tier === "admin" ? allWithMcp : allWithMcp.filter((t) => tierAllows(tier, t));
      // The model: an explicit choice (open / PATCH), else the stored one, else the user's default, else the configured default.
      const explicitModel = opts.model && validModelId(opts.model) ? opts.model : stored?.model && validModelId(stored.model) ? stored.model : undefined;
      const userDefault = () => settings?.get().defaultModel;
      let curModel: string | undefined = explicitModel;

      let boot: { ok: boolean; context: string; error?: string; degraded?: boolean };
      try { boot = await bootCache.get(botRec ? `${cfg.mindApiKey}|bot:${botRec.slug}` : cfg.mindApiKey, () => bootMind(clientForMind(home))); } catch (e) { boot = { ok: false, context: "", error: String((e as Error)?.message ?? e) }; }
      try { await sync.open({ title, sourceKey, externalId: id }); } catch { /* sync is best effort */ }

      const bootContext = boot.ok ? boot.context : "";
      // Learning (src/learn): admin-tier sessions only. Public/staff identities neither read nor write lessons,
      // so nothing from the owner's private MIND can reach them and nothing they say can reach it.
      const learn = learnCfg.enabled && tier === "admin" && !botRec // bots never learn
        ? createLearning({ client, provider, cfg, learn: hosted?.username ? { ...learnCfg, user: learnUserName(hosted.username) } : learnCfg, tier, onCost: (usd) => costCap?.add(usd) })
        : undefined;
      const inner = createAgentSession({
        id, surface: opts.surface, provider, kernel: kernelFor(tier), tools, sync, cfg, cwd, bootContext, learn,
        model: explicitModel ?? userDefault(),
        // A function: DAEBOT.md edits, renames and roster changes apply on the very next message.
        systemPrompt: () => {
          const live = botId ? botStore?.get(botId) ?? botRec : undefined;
          const used = curModel ?? userDefault();
          return composeSystemPrompt({
            identity: live ? botIdentity(live, hosted?.username) : hosted?.persona, tier, bootContext, surface: opts.surface, cwd,
            model: used ?? (mindBilled ? `${cfg.models.default} on paid MIND plans and ${cfg.freeModel} on the free MIND plan (Explorer)` : cfg.models.default),
            via: mindBilled ? "MIND" : undefined,
            bot: live && botId ? { slug: live.slug, instructions: botStore!.instructions(botId) } : undefined,
            roster: botsOn() ? botStore?.roster() : undefined,
          });
        },
        restore: stored ? { ...stored.state, messages: repairMessages(stored.state.messages), violations: stored.violations } : undefined,
      });

      const entry: Entry = {
        session: inner, surface: stored?.surface ?? opts.surface, title, updatedAt: Date.now(), tier,
        recorder: new HistoryRecorder(stored?.history), createdAt: stored?.createdAt ?? Date.now(),
        bot: botRec?.id, peer, model: explicitModel,
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
          if (userCap?.exceeded() || costCap?.exceeded()) {
            yield { type: "notice", level: "warn", text: userCap?.exceeded() ? userCap.notice() : costCap!.notice() };
            yield { type: "done", finalText: "" };
            return;
          }
          if (DEFAULT_TITLE.test(entry.title) && !entry.recorder.events().some((h) => h.type === "user")) entry.title = msg.trim().slice(0, 60) || entry.title;
          entry.recorder.user(msg);
          while (startNotices.length) { const n = startNotices.shift()!; entry.recorder.push(n); yield n; }
          for await (const ev of inner.send(msg, o)) {
            entry.recorder.push(ev);
            if (ev.type === "done") { entry.updatedAt = Date.now(); persist(id); }
            if (ev.type === "usage" && (costCap || userCap)) {
              // totalCostUsd is cumulative for the session: add only the delta (fall back to the per-call cost).
              const delta = ev.totalCostUsd >= lastTotal ? ev.totalCostUsd - lastTotal : ev.usage.costUsd;
              lastTotal = ev.totalCostUsd;
              costCap?.add(delta);
              userCap?.add(delta);
            }
            if (ev.type === "done" && degradedNotice) { entry.recorder.push(degradedNotice); yield degradedNotice; degradedNotice = undefined; }
            yield ev;
          }
          entry.updatedAt = Date.now();
        },
        violations: () => inner.violations(),
        exportState: () => inner.exportState!(),
        setModel(m) {
          const next = m && validModelId(m) ? m : undefined;
          curModel = next;
          entry.model = next;
          inner.setModel?.(next ?? userDefault());
          persist(id);
        },
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
      type Row = { id: string; surface: string; title: string; updatedAt: number; bot?: string; peer?: string; model?: string };
      const out = new Map<string, Row>();
      const row = (m: Row): Row => ({ id: m.id, surface: m.surface, title: m.title, updatedAt: m.updatedAt, ...(m.bot ? { bot: m.bot } : {}), ...(m.peer ? { peer: m.peer } : {}), ...(m.model ? { model: m.model } : {}) });
      for (const m of store?.list() ?? []) if (mine(m)) out.set(m.id, row(m));
      for (const [id, e] of sessions) if (out.has(id) || e.recorder.events().some((h) => h.type === "user")) out.set(id, row({ id, surface: e.surface, title: e.title, updatedAt: e.updatedAt, bot: e.bot, peer: e.peer, model: e.model }));
      return [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    },
    bots: botStore,
    settings,
    sessionInfo(id) {
      const live = sessions.get(id);
      if (live) return { bot: live.bot, peer: live.peer, model: live.model };
      const m = store?.meta?.(id);
      return m && mine(m) ? { bot: m.bot, peer: m.peer, model: m.model } : undefined;
    },
    history(id): HistoryEvent[] | undefined {
      const live = sessions.get(id);
      if (live) return live.recorder.events();
      const rec = store?.load(id);
      return mine(rec) ? rec?.history : undefined;
    },
  };
}
