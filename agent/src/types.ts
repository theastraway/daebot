// THE CONTRACT. Every module codes against this file. Do not change signatures without
// updating agent/SPEC.md and telling the orchestrator. Erasable TypeScript only (no enums,
// no parameter properties, no namespaces) so Node strips types natively.

// ---------- messages ----------
export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;            // provider-assigned call id
  name: string;
  args: Record<string, unknown>;
}

export interface Message {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];   // assistant messages
  toolCallId?: string;      // tool messages
  name?: string;            // tool messages: tool name
}

// ---------- provider ----------
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
}

export interface Usage { promptTokens: number; completionTokens: number; costUsd: number }

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "toolCall"; call: ToolCall }
  | { type: "done"; usage: Usage; finishReason: string };

export interface Provider {
  readonly name: string;
  stream(req: { model: string; messages: Message[]; tools: ToolSpec[]; signal?: AbortSignal }): AsyncIterable<StreamEvent>;
}

// ---------- tools ----------
// class drives the kernel: read = harmless, write = local mutation, outward = reaches a real
// third party or public surface, irreversible = delete/refund/env/DNS/DB-write, public = posts publicly.
export type ToolClass = "read" | "write" | "outward" | "irreversible" | "public";

export interface ToolResult { ok: boolean; output: string; meta?: Record<string, unknown> }

export interface Tool {
  spec: ToolSpec;
  class: ToolClass;
  // MIND tools that satisfy a receipt: "mind" => MIND✓, "surface" => SURFACE✓ (read of a real surface)
  receipt?: "mind" | "surface";
  // Optional per-call class (e.g. a write tool whose delete action is irreversible). The kernel and the
  // loop read `classFor?.(args) ?? class` everywhere they need a tool's class.
  classFor?(args: Record<string, unknown>): ToolClass;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext { cwd: string; signal?: AbortSignal; sessionId: string }

// One executed tool call this turn, with a kernel-assigned short id used in receipts.
export interface CallRecord {
  receiptId: string;      // "c1", "c2", ... unique within a session
  call: ToolCall;
  tool: string;
  class: ToolClass;
  receipt?: "mind" | "surface";
  result: ToolResult;
  at: number;
}

// ---------- kernel ----------
export type GateAction = "allow" | "block" | "rewrite" | "needs-confirmation";

export interface GateVerdict {
  gate: string;                 // e.g. "boot", "receipt"
  action: GateAction;
  reason: string;               // ONE line telling the model/user what to do next
  rewriteArgs?: Record<string, unknown>;
}

export interface TurnState {
  sessionId: string;
  booted: boolean;                 // mind_context receipt exists
  turnIndex: number;
  userMessage: string;             // latest user message (raw)
  userMessageIndex: number;        // increments per user message; confirmations bind to it
  calls: CallRecord[];             // calls made since the latest user message
  allCalls: CallRecord[];          // whole session
  confirmations: Confirmation[];   // outstanding + granted
  shadow: boolean;                 // shadow mode: verdicts are logged but never block
}

export interface Confirmation {
  forCallSignature: string;        // tool name + stable hash of args
  proposedAtUserMsg: number;       // user message index when proposed
  grantedAtUserMsg?: number;       // must be > proposedAtUserMsg to count
  used?: boolean;                  // approvals are single-use: set true once the approved call has run
}

export interface Gate {
  name: string;
  // Phase hooks. Return undefined to abstain.
  preTurn?(s: TurnState): GateVerdict | undefined;
  preTool?(s: TurnState, call: ToolCall, tool: Tool): GateVerdict | undefined;
  preAnswer?(s: TurnState, draft: string): GateVerdict | undefined;
  postTurn?(s: TurnState, finalAnswer: string): void;
}

export interface Violation {
  at: number;
  sessionId: string;
  gate: string;
  action: GateAction;
  reason: string;
  enforced: boolean;               // false when shadow mode downgraded it to a log
  detail?: Record<string, unknown>;
}

// ---------- MIND ----------
export interface MindClient {
  context(sections?: string[], forTask?: string): Promise<string>;
  query(query: string, opts?: { mode?: string; maxContextTokens?: number }): Promise<string>;
  remember(a: { type?: "entry" | "document"; title: string; content: string; tags?: string[]; source?: string }): Promise<string>;
  call(tool: string, args: Record<string, unknown>): Promise<string>; // generic /developer/v1/<tool>
}

export interface SessionSync {
  open(meta: { title: string; sourceKey: string; externalId?: string }): Promise<void>;
  append(role: "user" | "assistant", content: string): Promise<void>;
  pendingReplies(): Promise<string[]>;   // replies Anthony wrote in MIND Chat while away
  close(summary?: string): Promise<void>;
}

// ---------- config ----------
export interface Config {
  mindBaseUrl: string;       // default https://m-i-n-d.ai/developer/v1
  mindApiKey: string;        // from env MIND_API_KEY or ~/.mindclaw/config.json
  mindSessionApiKey?: string; // env MIND_SESSION_API_KEY; key with chat:write for Agent Session sync; falls back to mindApiKey
  clientNames?: string[];    // optional registry of client entity names (env MINDCLAW_CLIENT_NAMES, comma separated); default empty
  openrouterKey: string;     // env OPENROUTER_API_KEY
  models: { default: string; cheap: string; fallback: string[] };
  shadow: boolean;           // MINDCLAW_SHADOW=1
  kernel: boolean;           // MINDCLAW_KERNEL=0 turns the kernel off (used by the eval harness)
  maxToolRoundsPerTurn: number;
}

// ---------- agent session + gateway (all surfaces speak this) ----------
// Every surface (terminal, web, desktop, Telegram, Discord, iMessage...) is a thin client of the
// gateway. The gateway owns AgentSessions. Surfaces never touch the provider, tools or kernel.
export type AgentEvent =
  | { type: "text"; delta: string }                                   // streaming assistant text
  | { type: "toolStart"; receiptId: string; tool: string; args: Record<string, unknown> }
  | { type: "toolEnd"; receiptId: string; tool: string; ok: boolean; preview: string }
  | { type: "gate"; verdict: GateVerdict; enforced: boolean }         // kernel intervened (or would have)
  | { type: "confirm"; id: string; tool: string; args: Record<string, unknown>; reason: string } // needs a new user message
  | { type: "notice"; level: "info" | "warn"; text: string }          // e.g. pending MIND reply surfaced
  | { type: "usage"; usage: Usage; totalCostUsd: number }
  | { type: "done"; finalText: string };

export interface AgentSession {
  readonly id: string;
  readonly surface: string;             // "tui" | "web" | "desktop" | "telegram" | "discord" | "imessage" | "headless"
  // Sends one user message; yields events until "done". Calling again after done = next turn.
  send(userMessage: string, opts?: { signal?: AbortSignal }): AsyncIterable<AgentEvent>;
  violations(): Violation[];
  close(summary?: string): Promise<void>;
}

export interface Runtime {
  // boot: runs mind_context before returning; throws only if tools are unreachable.
  openSession(opts: { surface: string; title?: string; resumeId?: string; identity?: string }): Promise<AgentSession>;
  listSessions(): { id: string; surface: string; title: string; updatedAt: number }[];
}

// Wire protocol over HTTP (JSON) + WebSocket: gateway <-> surface. See agent/SPEC.md section 5.
export type ClientFrame =
  | { t: "open"; surface: string; title?: string; resumeId?: string }
  | { t: "send"; sessionId: string; text: string }
  | { t: "abort"; sessionId: string }
  | { t: "close"; sessionId: string };
export type ServerFrame =
  | { t: "opened"; sessionId: string }
  | { t: "event"; sessionId: string; event: AgentEvent }
  | { t: "error"; message: string };

// Channel adapters (Telegram, Discord, iMessage...) implement this and talk to the gateway like any surface.
export interface ChannelAdapter {
  readonly name: string;
  // opts.identity is a tier: "public" | "staff" (undefined or "admin" = unrestricted). The gateway forwards it to openSession.
  start(gateway: { open(surface: string, title?: string, opts?: { identity?: string }): Promise<AgentSession> }): Promise<void>;
  stop(): Promise<void>;
}

// ---------- module entry points (index.ts exports; builders must match exactly) ----------
export interface Kernel {
  // Returns the subset of tools the model may be offered right now (feed gate, boot gate hide tools).
  allowedTools(s: TurnState, all: Tool[]): Tool[];
  preTurn(s: TurnState): GateVerdict[];
  preTool(s: TurnState, call: ToolCall, tool: Tool): GateVerdict[];   // first non-allow verdict wins in the loop
  preAnswer(s: TurnState, draft: string): GateVerdict[];
  postTurn(s: TurnState, finalAnswer: string): void;
  // Called by the loop when a new user message arrives (s.userMessageIndex already updated): grants pending confirmations.
  onUserMessage(s: TurnState, userMessage: string): void;
  violations(): Violation[];
}
// kernel/index.ts:  export function createKernel(opts: { shadow: boolean; enabled: boolean; onViolation?: (v: Violation) => void; isolation?; clientNames?: string[]; tier?: "public" | "staff" | "admin" }): Kernel
// mind/index.ts:    export function createMindClient(cfg: Config, fetchImpl?: typeof fetch): MindClient
//                   export function createMindTools(client: MindClient): Tool[]
//                   export function createSessionSync(client: MindClient, sourceKey: string): SessionSync
//                   export async function bootMind(client: MindClient): Promise<{ ok: boolean; context: string; error?: string; degraded?: boolean }>
// provider/index.ts: export function createProvider(cfg: Config, fetchImpl?: typeof fetch): Provider
//                    export function pickModel(cfg: Config, hint: "default" | "cheap"): string
// tools/index.ts:   export function createBuiltinTools(): Tool[]
// config.ts:        export function loadConfig(env?: NodeJS.ProcessEnv): Config
// loop.ts:          export function createAgentSession(deps: { id: string; surface: string; provider: Provider; kernel: Kernel; tools: Tool[]; sync: SessionSync; cfg: Config; cwd: string; systemPrompt: string; bootContext: string }): AgentSession
// runtime.ts:       export function createRuntime(cfg: Config, overrides?: { provider?: Provider; fetchImpl?: typeof fetch }): Runtime
