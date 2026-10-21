// The turn loop (SPEC section 3). One AgentSession per conversation. The kernel hooks run at
// pre_turn, pre_tool, pre_answer and post_turn; this file only routes verdicts, it holds no policy.
import { createHash } from "node:crypto";
import { effectiveClass } from "./tool-class.ts";
import type { LearnHooks } from "./learn/types.ts";
import type {
  AgentEvent, AgentSession, CallRecord, Config, GateVerdict, Kernel, Message, Provider,
  SessionState, SessionSync, StreamEvent, Tool, ToolCall, ToolResult, TurnState, Usage, Violation,
} from "./types.ts";
import { clipToolOutputs, compactMessages, estimateTokens, needsCompaction } from "./compact.ts";

export const UNVERIFIED_FOOTER = "[unverified: receipt gate]";
const MAX_REGENERATIONS = 2;
const MAX_TOOL_OUTPUT = 100_000;

// Stable JSON (sorted keys) so the same arguments always hash the same.
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

// Confirmation.forCallSignature = "<tool>:<first 16 hex of sha256(stableStringify(args))>"
export function callSignature(call: Pick<ToolCall, "name" | "args">): string {
  return `${call.name}:${createHash("sha256").update(stableStringify(call.args ?? {})).digest("hex").slice(0, 16)}`;
}

const isShadowNote = (v: GateVerdict) => v.action === "allow" && v.reason.startsWith("[shadow]");

export interface SessionDeps {
  id: string;
  surface: string;
  provider: Provider;
  kernel: Kernel;
  tools: Tool[];
  sync: SessionSync;
  cfg: Config;
  cwd: string;
  /** A function is re-evaluated at the start of EVERY turn (so DAEBOT.md edits and roster changes apply on the next message). */
  systemPrompt: string | (() => string);
  bootContext: string;
  /** Model for this session's turns (read per turn); absent = cfg.models.default. */
  model?: string;
  /** Resume: model-facing history from a persisted session (violations too). The system prompt is always rebuilt fresh. */
  restore?: SessionState & { violations?: Violation[] };
  /** Optional learning layer (src/learn). Absent = the loop behaves exactly as before. */
  learn?: LearnHooks;
  /** Tools that can appear or change between turns (e.g. MCP servers the user connected mid-chat). Re-read every round; a name already in `tools` is never shadowed. */
  dynamicTools?: () => Tool[];
}

/** Plain-words reply used when the model ends a turn with no text. A refused tool call must never leave the user with a blank reply. */
export function emptyReplyFallback(blocked: { tool: string; gate: string }[]): string {
  if (blocked.length === 0) return "I did not produce a reply to that. Please send it again.";
  const tools = [...new Set(blocked.map((b) => b.tool))].join(", ");
  const owner = blocked.some((b) => b.gate === "owner");
  return owner
    ? `I could not save that to MIND (${tools}): the ownership check did not pass, so nothing was written. Everything else in this chat is unchanged. Tell me whose material this is and I will try again.`
    : `I could not finish that step (${tools}): a safety check refused it, so nothing was changed. Tell me how you would like to proceed.`;
}

const isAbort = (e: unknown, signal?: AbortSignal) => signal?.aborted === true || (e as Error)?.name === "AbortError";

export function createAgentSession(deps: SessionDeps): AgentSession {
  const { id, surface, provider, kernel, tools, sync, cfg, cwd } = deps;
  const byName = new Map(tools.map((t) => [t.spec.name, t]));
  const staticNames = new Set(byName.keys());
  // Dynamic tools (connected MCP servers) are re-read each round; the static set always wins a name clash.
  let liveTools: Tool[] = tools;
  function refreshDynamic(): void {
    if (!deps.dynamicTools) return;
    const extra = safe(deps.dynamicTools, [] as Tool[]).filter((t) => !staticNames.has(t.spec.name));
    for (const n of [...byName.keys()]) if (!staticNames.has(n)) byName.delete(n);
    for (const t of extra) byName.set(t.spec.name, t);
    liveTools = extra.length ? [...tools, ...extra] : tools;
  }

  const state: TurnState = {
    sessionId: id,
    booted: false,
    turnIndex: 0,
    userMessage: "",
    userMessageIndex: 0,
    calls: [],
    allCalls: [],
    confirmations: [],
    shadow: cfg.shadow,
  };

  const buildSystem = (): string => {
    let t = typeof deps.systemPrompt === "function" ? deps.systemPrompt() : deps.systemPrompt;
    if (deps.bootContext && !t.includes(deps.bootContext)) t += `\n\n${deps.bootContext}`;
    return t;
  };
  const messages: Message[] = [{ role: "system", content: buildSystem() }];
  let model: string | undefined = deps.model;
  const modelNow = (): string => model || cfg.models.default;

  // Learning hook state: the one "What you learned before" note currently in the transcript, and earlier user messages.
  const learn = deps.learn;
  let learnedNote: Message | undefined;
  const userHistory: string[] = [];

  let receiptCounter = 0;
  let totalCost = 0;
  const localViolations: Violation[] = [];
  if (deps.restore) {
    messages.push(...deps.restore.messages.filter((m) => !(m.role === "system" && m.content.startsWith("[learned]"))));
    for (const m of deps.restore.messages) if (m.role === "user") userHistory.push(m.content);
    receiptCounter = deps.restore.receiptCounter ?? 0;
    totalCost = deps.restore.totalCostUsd ?? 0;
    state.userMessageIndex = deps.restore.userMessageIndex ?? 0;
    localViolations.push(...(deps.restore.violations ?? []));
  }

  if (deps.bootContext.trim() !== "") {
    const rec: CallRecord = {
      receiptId: "c0",
      call: { id: "boot", name: "mind_context", args: {} },
      tool: "mind_context",
      class: "read",
      receipt: "mind",
      result: { ok: true, output: deps.bootContext },
      at: Date.now(),
    };
    state.allCalls.push(rec);
    state.booted = true;
  }

  const enforced = () => !state.shadow;
  let blockedThisTurn: { tool: string; gate: string }[] = [];
  let turnOrigin: "user" | "bot" = "user";

  async function* runTurn(userMessage: string, signal?: AbortSignal, origin: "user" | "bot" = "user"): AsyncGenerator<AgentEvent> {
    // ---- start of turn
    state.userMessageIndex += 1;
    state.turnIndex += 1;
    // A bot-originated turn is NOT the human speaking: its text is never the "latest user message" the gates read
    // (no confirmation grant, no feed-post unlock, no attribution exemption for the receipt gate).
    state.userMessage = origin === "bot" ? "" : userMessage;
    state.calls = [];
    turnOrigin = origin;
    // A granted confirmation is valid for ONE turn only (the one it was granted in); a bot-originated turn starts with none at all.
    state.confirmations = origin === "bot" ? [] : state.confirmations.filter((c) => c.grantedAtUserMsg === undefined);
    // The system prompt is rebuilt each turn (a function prompt reads fresh DAEBOT.md / roster).
    try { if (messages[0]?.role === "system") messages[0] = { role: "system", content: buildSystem() }; } catch { /* keep the previous prompt */ }

    // Pending confirmations from earlier turns are granted by the kernel only on an explicit action phrase, spoken by a HUMAN.
    if (origin !== "bot") { try { kernel.onUserMessage?.(state, userMessage); } catch { /* gate bug must not kill the turn */ } }

    let replies: string[] = [];
    try { replies = await sync.pendingReplies(); } catch { /* sync is best effort */ }
    for (const r of replies) yield { type: "notice", level: "info", text: `MIND reply from Anthony: ${r}` };
    const content = replies.length
      ? `[MIND replies from Anthony while you were away]\n${replies.map((r) => `- ${r}`).join("\n")}\n\n${userMessage}`
      : userMessage;
    messages.push({ role: "user", content });

    // ---- pre_turn
    for (const v of safe(() => kernel.preTurn(state), [] as GateVerdict[])) {
      if (v.action === "allow") { if (isShadowNote(v)) yield { type: "gate", verdict: v, enforced: false }; continue; }
      yield { type: "gate", verdict: v, enforced: enforced() };
      if (enforced()) messages.push({ role: "system", content: `[kernel:${v.gate}] ${v.reason}` });
    }

    // ---- learning: recalled lessons/skills for this message (bounded, fails open to no note)
    const turnStartedAt = Date.now();
    if (learn) {
      if (learnedNote) { const i = messages.indexOf(learnedNote); if (i >= 0) messages.splice(i, 1); learnedNote = undefined; }
      const note = await learn.beforeTurn(userMessage).catch(() => undefined);
      if (note) { learnedNote = { role: "system", content: note }; messages.push(learnedNote); }
    }

    let finalText: string | undefined;
    let pendingNarration = "";
    let regenerations = 0;
    let confirmed = false;
    let failed = false;
    blockedThisTurn = [];

    try {
      for (let round = 0; round < cfg.maxToolRoundsPerTurn; round++) {
        if (signal?.aborted) throw abortErr();

        yield* maybeCompact(signal);

        refreshDynamic();
        const offered = safe(() => kernel.allowedTools(state, liveTools), liveTools);
        const specs = offered.map((t) => t.spec);

        // ---- provider call. Text streams to the client as it arrives; if pre_answer then withholds the draft,
        // a `retract` event tells every surface to take it back before the regenerated text streams.
        let text = "";
        const toolCalls: ToolCall[] = [];
        let usage: Usage | undefined;
        const useModel = modelNow();
        let servedBy = useModel;
        for await (const ev of provider.stream({ model: useModel, messages: [...messages], tools: specs, signal }) as AsyncIterable<StreamEvent>) {
          if (ev.type === "text") { text += ev.delta; if (ev.delta) yield { type: "text", delta: ev.delta }; }
          else if (ev.type === "toolCall") toolCalls.push(ev.call);
          else if (ev.type === "done") { usage = ev.usage; if (ev.model) servedBy = ev.model; if (ev.notice) yield { type: "notice", level: "info", text: ev.notice }; }
        }
        if (signal?.aborted) throw abortErr();

        const emitUsage = function* (): Generator<AgentEvent> {
          if (usage) { totalCost += usage.costUsd; yield { type: "usage", usage, totalCostUsd: totalCost, model: servedBy }; }
        };

        // ---- tool round
        if (toolCalls.length) {
          // Narration is user-visible text: it gets the same pre_answer check as a final draft (this also covers the
          // confirm path, where the narration of the round that ends in a confirmation is the turn's last text).
          // A blocked narration is withheld and the model is told to restate it with receipts. The calls that came
          // with it are NOT dropped: each one still goes through pre_tool on its own.
          let shown = text;
          let withheldNudge: string | undefined;
          if (text.trim()) {
            const nv = safe(() => kernel.preAnswer(state, text), [] as GateVerdict[]);
            for (const n of nv) if (isShadowNote(n)) yield { type: "gate", verdict: n, enforced: false };
            const nverdict = nv.find((v) => v.action !== "allow");
            if (nverdict) {
              if (enforced()) yield { type: "retract", reason: nverdict.reason };
              yield { type: "gate", verdict: nverdict, enforced: enforced() };
              if (enforced()) {
                shown = "";
                withheldNudge = `[kernel:${nverdict.gate}] Your last message was withheld. ${nverdict.reason} Restate it with receipts once you have them.`;
              }
            }
          }
          messages.push({ role: "assistant", content: shown, toolCalls });
          if (shown) pendingNarration += (pendingNarration ? "\n" : "") + shown; // already streamed above
          yield* emitUsage();

          for (let i = 0; i < toolCalls.length; i++) {
            const call = toolCalls[i];
            if (signal?.aborted) { pushToolResults(messages, toolCalls.slice(i), "aborted by user"); throw abortErr(); }
            const outcome = yield* handleToolCall(call);
            if (outcome === "confirm") {
              pushToolResults(messages, toolCalls.slice(i + 1), "not executed: turn ended pending user confirmation");
              confirmed = true;
              break;
            }
          }
          if (withheldNudge) messages.push({ role: "system", content: withheldNudge });
          if (confirmed) break;
          continue;
        }

        // ---- final draft: pre_answer
        const answerVerdicts = safe(() => kernel.preAnswer(state, text), [] as GateVerdict[]);
        for (const n of answerVerdicts) if (isShadowNote(n)) yield { type: "gate", verdict: n, enforced: false };
        const verdict = answerVerdicts.find((v) => v.action !== "allow");
        if (!verdict) { finalText = text; yield* emitUsage(); break; }
        if (enforced()) yield { type: "retract", reason: verdict.reason };
        yield { type: "gate", verdict, enforced: enforced() };
        if (!enforced()) { finalText = text; yield* emitUsage(); break; }
        if (regenerations < MAX_REGENERATIONS) {
          regenerations++;
          messages.push({ role: "assistant", content: text });
          messages.push({ role: "system", content: `[kernel:${verdict.gate}] Your draft was withheld. ${verdict.reason} Revise your answer (call tools to get receipts if needed).` });
          yield* emitUsage();
          continue;
        }
        // Out of regenerations: ship, but visibly marked, and make sure the violation is on record.
        localViolations.push({
          at: Date.now(), sessionId: id, gate: verdict.gate, action: verdict.action, reason: verdict.reason, enforced: true,
          detail: { shippedUnverified: true, regenerations },
        });
        finalText = `${text}\n\n${UNVERIFIED_FOOTER}`;
        yield { type: "text", delta: finalText };
        yield* emitUsage();
        break;
      }

      if (finalText === undefined) {
        if (confirmed) {
          finalText = pendingNarration;
        } else {
          yield { type: "notice", level: "warn", text: `stopped after ${cfg.maxToolRoundsPerTurn} tool rounds` };
          finalText = pendingNarration || `[stopped after ${cfg.maxToolRoundsPerTurn} tool rounds without a final answer]`;
        }
      }
    } catch (e) {
      if (isAbort(e, signal)) {
        finalText = "[aborted]";
        yield { type: "notice", level: "warn", text: "turn aborted" };
      } else {
        failed = true;
        finalText = "";
        // A billing refusal (MIND plan/credits) carries its own user-facing line; everything else is a plain error.
        const userNotice = (e as { userNotice?: unknown })?.userNotice;
        yield { type: "notice", level: "warn", text: typeof userNotice === "string" && userNotice ? userNotice : `error: ${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 400)}` };
      }
    }

    // A turn that ended with no text (e.g. the model went silent after a gate refused one write) still answers the user.
    if (!failed && !confirmed && !(finalText ?? "").trim()) {
      finalText = emptyReplyFallback(blockedThisTurn);
      yield { type: "text", delta: finalText };
    }

    if (finalText && !confirmed) messages.push({ role: "assistant", content: finalText });

    // ---- post_turn
    if (!failed) {
      try { kernel.postTurn(state, finalText ?? ""); } catch { /* gates must not crash a turn */ }
      try {
        await sync.append("user", userMessage);
        if (finalText) await sync.append("assistant", finalText);
      } catch { /* best effort */ }
    }
    // ---- learning: reflect after the reply is out; never awaited, never able to fail the turn
    if (learn) {
      try {
        learn.afterTurn({
          sessionId: id, userMessage, finalText: finalText ?? "", userHistory: userHistory.slice(), calls: state.calls.slice(),
          violations: safe(() => kernel.violations(), [] as Violation[]).filter((v) => v.sessionId === id && v.at >= turnStartedAt),
          failed,
        });
      } catch { /* learning must not crash a turn */ }
      userHistory.push(userMessage);
    }
    yield { type: "done", finalText: finalText ?? "" };
  }

  // Context compaction: past compactAt x contextWindow, older turns become one summary note (cheap model).
  async function* maybeCompact(signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const window = cfg.contextWindow ?? 128_000;
    const ratio = cfg.compactAt ?? 0.6;
    if (!needsCompaction(messages, window, ratio)) return;
    let r: Awaited<ReturnType<typeof compactMessages>>;
    try { r = await compactMessages(messages, { provider, model: cfg.models.cheap, signal }); } catch (e) {
      if (isAbort(e, signal)) throw e;
      r = undefined;
    }
    if (r) {
      messages.splice(0, messages.length, ...r.messages);
      yield { type: "notice", level: "info", text: `Compacted ${r.compacted} earlier messages into a summary to keep the chat within the context window${r.mechanical ? " (summary model unavailable; used a plain digest)" : ""}.` };
      if (r.usage) { totalCost += r.usage.costUsd; yield { type: "usage", usage: r.usage, totalCostUsd: totalCost, model: cfg.models.cheap }; }
    }
    // The verbatim tail can itself be too big (huge tool outputs): clip old ones rather than fail the request.
    if (estimateTokens(messages) > window * 0.85) clipToolOutputs(messages);
  }

  // Runs one tool call through pre_tool. Yields events; returns "confirm" when the turn must end.
  async function* handleToolCall(call: ToolCall): AsyncGenerator<AgentEvent, "ok" | "confirm"> {
    const tool = byName.get(call.name);
    if (!tool) {
      messages.push(toolMsg(call, `unknown tool "${call.name}"`));
      return "ok";
    }
    if (typeof call.args?._invalidJson === "string") {
      messages.push(toolMsg(call, `${call.name}: arguments were not valid JSON; resend the call with a valid JSON object`));
      return "ok";
    }

    let args = call.args ?? {};
    // A peer (another bot) turn can never ask a human for an outward/irreversible/public action: refused outright, no confirmation is created.
    if (turnOrigin === "bot") {
      const cls = effectiveClass(tool, args);
      if (cls === "outward" || cls === "irreversible" || cls === "public") {
        messages.push(toolMsg(call, "blocked: peer turns cannot request outward actions. Tell the requester what you would do and let the user ask for it directly."));
        yield { type: "gate", verdict: { gate: "peer", action: "block", reason: "peer turns cannot request outward actions" }, enforced: true };
        localViolations.push({ at: Date.now(), sessionId: id, gate: "peer", action: "block", reason: `peer turn tried ${tool.spec.name} (${cls})`, enforced: true });
        return "ok";
      }
    }
    const verdicts = safe(() => kernel.preTool(state, call, tool), [] as GateVerdict[]);
    for (const n of verdicts) if (isShadowNote(n)) yield { type: "gate", verdict: n, enforced: false };
    const v = verdicts.find((x) => x.action !== "allow");
    if (v) {
      yield { type: "gate", verdict: v, enforced: enforced() };
      if (enforced()) {
        if (v.action === "block") {
          blockedThisTurn.push({ tool: tool.spec.name, gate: v.gate });
          messages.push(toolMsg(call, `blocked by ${v.gate}: ${v.reason} Only this one call was refused. Fix it and retry, or tell the user in plain words what was not done; never end the turn without a reply.`));
          return "ok";
        }
        if (v.action === "needs-confirmation") {
          // The danger gate records the pending Confirmation in state.confirmations itself.
          const conf = { forCallSignature: callSignature(call) };
          messages.push(toolMsg(call, `not executed: ${v.reason} Ask the user. If they reply with an explicit go-ahead (e.g. "send it"), call the tool again with identical arguments.`));
          yield { type: "confirm", id: conf.forCallSignature, tool: call.name, args, reason: v.reason };
          return "confirm";
        }
        if (v.action === "rewrite" && v.rewriteArgs) args = v.rewriteArgs;
      }
    }

    const receiptId = `c${++receiptCounter}`;
    const execCall: ToolCall = args === call.args ? call : { ...call, args };
    yield { type: "toolStart", receiptId, tool: tool.spec.name, args };
    const result = await execute(tool, args);
    const rec: CallRecord = { receiptId, call: execCall, tool: tool.spec.name, class: effectiveClass(tool, args), receipt: tool.receipt, result, at: Date.now() };
    state.calls.push(rec);
    state.allCalls.push(rec);
    if (tool.spec.name === "mind_context" && result.ok) state.booted = true;
    // A tool that spent money outside the chat model (e.g. decide) reports it in meta.costUsd; it counts in the turn's usage.
    const toolCost = result.meta?.costUsd;
    if (typeof toolCost === "number" && Number.isFinite(toolCost) && toolCost > 0) {
      totalCost += toolCost;
      const m = result.meta ?? {};
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      yield { type: "usage", usage: { promptTokens: n(m.inputTokens), completionTokens: n(m.outputTokens), costUsd: toolCost }, totalCostUsd: totalCost, model: typeof m.model === "string" ? m.model : tool.spec.name };
    }
    yield { type: "toolEnd", receiptId, tool: tool.spec.name, ok: result.ok, preview: result.output.replace(/\s+/g, " ").slice(0, 200) };
    messages.push(toolMsg(call, `[#${receiptId} ${tool.spec.name}${result.ok ? "" : " FAILED"}] ${result.output.length > MAX_TOOL_OUTPUT ? result.output.slice(0, MAX_TOOL_OUTPUT) + "\n[truncated]" : result.output}`));
    return "ok";
  }

  let currentSignal: AbortSignal | undefined;
  async function execute(tool: Tool, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const r = await tool.run(args, { cwd, signal: currentSignal, sessionId: id, origin: turnOrigin });
      return r && typeof r.output === "string" ? r : { ok: false, output: "tool returned an invalid result" };
    } catch (e) {
      return { ok: false, output: `${tool.spec.name}: ${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 300)}` };
    }
  }

  return {
    id,
    surface,
    send(userMessage, opts) {
      currentSignal = opts?.signal;
      return runTurn(userMessage, opts?.signal, opts?.origin === "bot" ? "bot" : "user");
    },
    setModel(m) { model = m && m.trim() ? m.trim() : undefined; },
    violations() {
      const fromKernel = safe(() => kernel.violations(), [] as Violation[]).filter((v) => v.sessionId === id);
      return [...fromKernel, ...localViolations].sort((a, b) => a.at - b.at);
    },
    async close(summary) {
      if (learn) { try { await learn.close(); } catch { /* best effort */ } }
      try { await sync.close(summary); } catch { /* best effort */ }
    },
    exportState() {
      // The recalled-lessons note is derived state (rebuilt each turn from MIND), so it is never persisted.
      return { messages: messages.slice(1).filter((m) => m !== learnedNote).map((m) => ({ ...m })), receiptCounter, totalCostUsd: totalCost, userMessageIndex: state.userMessageIndex };
    },
  };
}

function toolMsg(call: ToolCall, content: string): Message {
  return { role: "tool", toolCallId: call.id, name: call.name, content };
}

function pushToolResults(messages: Message[], calls: ToolCall[], why: string): void {
  for (const c of calls) messages.push(toolMsg(c, why));
}

function abortErr(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}
