// THE CONTRACT. Every module codes against this file. Do not change signatures without
// updating agent/SPEC.md and telling the orchestrator. Erasable TypeScript only (no enums,
// no parameter properties, no namespaces) so Node strips types natively.

import type { BotsApi } from "./bots/types.ts";
import type { SessionPermMode } from "./permissions/store.ts";

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
  images?: string[];        // data: URLs sent to the model, never persisted. Tool messages: screenshots. User messages: only the one-off view_photo vision call.
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
  | { type: "done"; usage: Usage; finishReason: string; notice?: string; model?: string }; // notice: a one-line info for the user (e.g. answered on the free model); model: the model that actually answered, when the provider chose another

export interface Provider {
  readonly name: string;
  /** pinModel: use exactly req.model, with no tier swap and no fallback list (a vision call must not land on a text-only chat model). */
  stream(req: { model: string; messages: Message[]; tools: ToolSpec[]; signal?: AbortSignal; pinModel?: boolean }): AsyncIterable<StreamEvent>;
}

// ---------- tools ----------
// class drives the kernel: read = harmless, write = local mutation, outward = reaches a real
// third party or public surface, irreversible = delete/refund/env/DNS/DB-write, public = posts publicly.
export type ToolClass = "read" | "write" | "outward" | "irreversible" | "public";

export interface ToolResult { ok: boolean; output: string; meta?: Record<string, unknown>; /** data: URLs the model should see (e.g. a screenshot) */ images?: string[] }

export interface Tool {
  spec: ToolSpec;
  class: ToolClass;
  // MIND tools that satisfy a receipt: "mind" => MIND✓, "surface" => SURFACE✓ (read of a real surface)
  receipt?: "mind" | "surface";
  // Optional per-call class (e.g. a write tool whose delete action is irreversible). The kernel and the
  // loop read `classFor?.(args) ?? class` everywhere they need a tool's class.
  classFor?(args: Record<string, unknown>): ToolClass;
  // A client capability this tool needs (e.g. "apple_calendar"). The tool is offered only on turns whose send request listed it;
  // a call to it on any other turn is answered with `unavailable` and never reaches a gate or a card.
  requires?: string;
  unavailable?: string;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// Device relay: the agent never touches a client device itself. A tool asks the client attached to this turn (the web UI inside the
// iPhone or Mac app), which runs the request natively and posts the answer back. `code` tells a timeout from a stop from an error.
export type DeviceReply = { ok: true; result: unknown } | { ok: false; error: string; code?: "timeout" | "aborted" | "closed" | "device" };
export interface DeviceBridge {
  call(req: { tool: string; op: string; args: Record<string, unknown> }, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<DeviceReply>;
}

/** A decision filed this turn with mind_decision_record: the OOC/EMR receipt a peer request or a peer-triggered action must carry. */
export interface DecisionReceipt { id: string; subject: string; at: number; /** true = the decision was to decline: it never unlocks an action. */ declined?: boolean }

export interface ToolContext {
  cwd: string; signal?: AbortSignal; sessionId: string;
  /** Decisions filed in THIS turn only (a new turn starts empty). */
  decisions?: readonly DecisionReceipt[];
  /** Peer turns only: the decision receipt the requesting agent attached to the request (set by the bot bus, never by message text). */
  peerReceipt?: string;
  /** "bot" when the turn was started by a peer bot, not the human. */
  origin?: "user" | "bot";
  /** What the client that sent this turn can do (e.g. "apple_calendar"). */
  capabilities?: string[];
  /** The relay to that client, present only on a turn that listed a capability. */
  device?: DeviceBridge;
}

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
  deniedCalls?: string[];          // call signatures the user denied on a card this session: never asked again (no repeat card)
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
  context(sections?: string[], forTask?: string, signal?: AbortSignal): Promise<string>;
  query(query: string, opts?: { mode?: string; maxContextTokens?: number; signal?: AbortSignal }): Promise<string>;
  remember(a: { type?: "entry" | "document"; title: string; content: string; tags?: string[]; source?: string }, signal?: AbortSignal): Promise<string>;
  call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>; // generic /developer/v1/<tool>; signal aborts the HTTP request
}

export interface SessionSync {
  open(meta: { title: string; sourceKey: string; externalId?: string }): Promise<void>;
  append(role: "user" | "assistant", content: string): Promise<void>;
  pendingReplies(): Promise<string[]>;   // replies Anthony wrote in MIND Chat while away
  close(summary?: string): Promise<void>;
}

// ---------- config ----------
export interface VisionConfig {
  model: string;       // the photo-reading model
  fallback: string[];  // tried in order when it fails or answers with nothing
  freeModel: string;   // the only model a MIND free-tier (Explorer) user's photo is read with
}

export interface Config {
  mindBaseUrl: string;       // default https://m-i-n-d.ai/developer/v1
  mindApiKey: string;        // from env MIND_API_KEY or ~/.daebot/config.json
  mindBackendUrl?: string;   // env MIND_BACKEND_URL; MIND's API origin for the routes that live outside /developer/v1 (Email Manager). Default: derived from mindBaseUrl.
  mindSessionApiKey?: string; // env MIND_SESSION_API_KEY; key with chat:write for Agent Session sync; falls back to mindApiKey
  clientNames?: string[];    // optional registry of client entity names (env MINDCLAW_CLIENT_NAMES, comma separated); default empty
  openrouterKey: string;     // env OPENROUTER_API_KEY (not needed when billing is "mind")
  billing?: "openrouter" | "mind"; // env DAEBOT_BILLING; "mind" bills each user's MIND plan/credits instead of our OpenRouter key. Default openrouter.
  freeModel?: string;        // env DAEBOT_FREE_MODEL; the model MIND's free tier (Explorer) runs on
  vision?: VisionConfig;     // models behind the view_photo tool (env DAEBOT_VISION_MODEL, DAEBOT_VISION_FALLBACK, DAEBOT_VISION_FREE_MODEL)
  models: { default: string; cheap: string; fallback: string[] };
  shadow: boolean;           // MINDCLAW_SHADOW=1
  kernel: boolean;           // MINDCLAW_KERNEL=0 turns the kernel off (used by the eval harness)
  maxToolRoundsPerTurn?: number; // optional operator override (env MINDCLAW_MAX_TOOL_ROUNDS); unset = no round limit
  checkInMs?: number;        // env DAEBOT_CHECKIN_MS; default 300000. A running turn gets a one-line-update reminder this often. Absent = off
  contextWindow?: number;    // model context window in tokens, used for compaction (env MINDCLAW_CONTEXT_WINDOW); default 128000
  compactAt?: number;        // fraction of contextWindow that triggers compaction (env MINDCLAW_COMPACT_AT); default 0.6
}

/** One end of an agent exchange: the user's own Daebot ("main") or one of their bots. */
export interface ExchangeParty { id: string; kind: "main" | "bot"; name: string; slug?: string; face?: string; color?: string }

// ---------- agent session + gateway (all surfaces speak this) ----------
// Every surface (terminal, web, desktop, Telegram, Discord, iMessage...) is a thin client of the
// gateway. The gateway owns AgentSessions. Surfaces never touch the provider, tools or kernel.
export type AgentEvent =
  | { type: "text"; delta: string }                                   // streaming assistant text
  | { type: "toolStart"; receiptId: string; tool: string; args: Record<string, unknown> }
  | { type: "toolEnd"; receiptId: string; tool: string; ok: boolean; preview: string; /** mind_decision_record: the receipt id it filed */ decisionId?: string }
  | { type: "gate"; verdict: GateVerdict; enforced: boolean }         // kernel intervened (or would have)
  | { type: "confirm"; id: string; tool: string; args: Record<string, unknown>; reason: string } // needs a new user message
  // A tool call is waiting for the user's click (Allow once / Always allow / Deny / Always deny). The turn is paused until
  // POST /permissions/<id>/decide answers it (or it expires). Surfaces without a UI never get this: they keep the typed `confirm`.
  | { type: "permission"; id: string; tool: string; cls: ToolClass; title: string; detail: { label: string; value: string }[]; args: Record<string, unknown>;
      allowOptions: PermissionOption[]; denyOptions: PermissionOption[];
      suggest?: { effect: "allow" | "deny"; optionId: string; label: string; count: number }; expiresAt: number }
  | { type: "permissionResolved"; id: string; outcome: "allowed" | "denied" | "expired"; by: "user" | "rule"; remembered?: string }
  // A tool is waiting for the client DEVICE (not the model) to run `op` natively and POST the answer to /sessions/:id/device-result.
  // Relay-only: published into the run feed, never part of the saved transcript.
  | { type: "device_call"; id: string; tool: string; op: string; args: Record<string, unknown> }
  | { type: "notice"; level: "info" | "warn"; text: string }          // e.g. pending MIND reply surfaced
  // A bot_talk call just happened in this turn: shown as a small "Messaged <agent>" card with the message and (when it answered) the reply.
  // `exchangeId` opens the read-only two-sided transcript of that pair of agents (GET /exchanges/:id).
  | { type: "exchange"; exchangeId: string; from: ExchangeParty; to: ExchangeParty; message: string; reply?: { text: string; ok: boolean }; at: number }
  | { type: "usage"; usage: Usage; totalCostUsd: number; model?: string } // model = the model that produced this call
  // The draft just streamed (the text since the last tool/gate/confirm boundary) was withheld by a gate.
  // Clients replace that assistant block with a "rewriting: <reason>" note; the regenerated text streams after it.
  | { type: "retract"; reason: string }
  | { type: "done"; finalText: string };

/** One scope choice behind "Always allow..." / "Always deny...". Generated by the server from the real call; the client only picks an id. */
export interface PermissionOption { id: string; label: string; broad: boolean }

/** A photo the user attached to a message. The bytes live server-side per session (src/photos.ts); the model reaches them only through view_photo. */
export interface PhotoRef { id: string; name: string; width: number; height: number }

// A persisted transcript item: live AgentEvents plus the user's own messages (which are never live events).
// id = stable message id (menu: reactions, unread, reply). rid = the run (request) that produced it. quote = the message a user reply answers.
export type HistoryEvent = (AgentEvent & { id?: string; rid?: string }) | { type: "user"; text: string; photos?: PhotoRef[]; id?: string; rid?: string; quote?: MessageQuote };

/** The earlier message a reply answers: shown above the user's bubble; the model receives the text as "Replying to: ...". */
export interface MessageQuote { id?: string; text: string }

/** Per-message extras kept with the session: emoji reactions and the user's thumbs feedback. */
export interface MessageMeta {
  reactions?: string[];
  feedback?: { rating: "up" | "down"; comment?: string; reason?: string; at: number; report?: boolean };
}
export interface SessionMessageMeta { messages: Record<string, MessageMeta>; unreadFrom?: string }

export interface AgentSession {
  readonly id: string;
  readonly surface: string;             // "tui" | "web" | "desktop" | "telegram" | "discord" | "imessage" | "headless"
  // Sends one user message; yields events until "done". Calling again after done = next turn.
  // origin "bot": the text came from another bot (bot_talk), not from the human. Such a turn can never grant a pending confirmation.
  // interactive: a person is looking at a UI that can answer a `permission` card (web, desktop, mobile). Absent/false = typed confirmations only.
  // photos: already stored for this session (Runtime.photos); the model is told about them in the message text and reads them with view_photo.
  // capabilities/device: what the sending client can do and the relay to it, for this turn only (see DeviceBridge).
  send(userMessage: string, opts?: { signal?: AbortSignal; origin?: "user" | "bot"; peerReceipt?: string; interactive?: boolean; photos?: PhotoRef[]; quote?: MessageQuote; capabilities?: string[]; device?: DeviceBridge }): AsyncIterable<AgentEvent>;
  /** Model for the next turn (per-session model). undefined = the configured default. */
  setModel?(model: string | undefined): void;
  /** This chat's permission mode for the next call onward. undefined = the account default. The caller has already checked bypass against the waiver. */
  setPermMode?(mode: SessionPermMode | undefined): void;
  violations(): Violation[];
  close(summary?: string): Promise<void>;
  // Model-facing history (without the system prompt) so a session can be persisted and resumed.
  exportState?(): SessionState;
}

export interface SessionState { messages: Message[]; receiptCounter: number; totalCostUsd: number; userMessageIndex: number }

export interface Runtime {
  // boot: runs mind_context before returning; throws only if tools are unreachable.
  // botId: open a session of that bot (home MIND = the bot's); peer: the other end of a bot-to-bot DM thread; model: per-session model.
  openSession(opts: { surface: string; title?: string; resumeId?: string; identity?: string; botId?: string; peer?: string; model?: string }): Promise<AgentSession>;
  listSessions(): { id: string; surface: string; title: string; updatedAt: number; bot?: string; peer?: string; model?: string; permMode?: string; unread?: boolean; archived?: boolean }[];
  /** Bots of this runtime's owner (absent on runtimes built without a bots context). */
  bots?: BotsApi;
  /** Bot / peer / model of a live or persisted session of this owner. */
  sessionInfo?(id: string): { bot?: string; peer?: string; model?: string; permMode?: string } | undefined;
  /** Deletes every saved session of a deleted bot: its own threads and the DM threads where it is the peer or the recipient. */
  purgeBotSessions?(botId: string): Promise<number>;
  /** Permanently deletes one saved or live session of this owner (its transcript and state). false = no such session. */
  deleteSession?(id: string): Promise<boolean>;
  /** Renames one saved or live session of this owner (the title is already cleaned). The name is kept for good: the auto title never replaces it. false = no such session. */
  renameSession?(id: string, title: string): Promise<boolean>;
  /** Hides (on) or restores (off) one session of this owner in the lists; nothing is deleted. false = no such session. */
  archiveSession?(id: string, on: boolean): Promise<boolean>;
  /** Reactions / feedback of each message and the unread marker of a session of this owner. Undefined = unknown id. */
  messageMeta?(id: string): SessionMessageMeta | undefined;
  /** history() and messageMeta() in one read. live = the session is running in this process (its transcript changes under the reader). */
  historyWithMeta?(id: string): { events: HistoryEvent[]; meta: SessionMessageMeta; live: boolean } | undefined;
  /** Text of one saved message (the quote of a reply). */
  messageText?(id: string, mid: string): string | undefined;
  /** Marks the thread unread from a message (mid) or clears the marker (null). "nomsg" = that message is not in this session. */
  setUnread?(id: string, mid: string | null): Promise<"ok" | "nosession" | "nomsg">;
  /** Toggles one emoji on a message. 👍 / 👎 are also the message's thumbs feedback (mutually exclusive). */
  reactMessage?(id: string, mid: string, emoji: string): Promise<{ reactions: string[]; feedback?: MessageMeta["feedback"]; learned: boolean } | "nosession" | "nomsg">;
  /** Saves thumbs feedback (or a Report) on a message and routes it into the learning store. */
  feedbackMessage?(id: string, mid: string, f: { rating: "up" | "down" | null; comment?: string; reason?: string; report?: boolean }): Promise<{ feedback?: MessageMeta["feedback"]; learned: boolean; excerpt: string } | "nosession" | "nomsg">;
  /** The owner's per-user settings (default model). */
  settings?: { get(): import("./settings.ts").UserSettings; set(patch: import("./settings.ts").SettingsPatch): void };
  // Visible transcript of a live or persisted session (replayed after a resume or restart). Undefined = unknown id.
  history?(id: string): HistoryEvent[] | undefined;
  /** Granular permissions of this owner (rules, mode, pending cards). Absent on runtimes built without a data dir. */
  permissions?: import("./permissions/index.ts").PermissionService;
  /** Suggested replies for the user's next message (1-3, in their voice) and the learning feedback. Absent = not offered. */
  suggestReplies?(id: string, signal?: AbortSignal): Promise<{ replies: string[] }>;
  recordSuggestionFeedback?(id: string, fb: import("./suggest/index.ts").SuggestionFeedback): boolean;
  /** This owner's photo store (photos attached to chat messages). Absent on runtimes built without a data dir: attaching is then refused. */
  photos?: import("./photos.ts").PhotoStore;
  /** Task board rows of this owner: tasks the model declared per session, or one derived row per session. Most recent sessions first. */
  boardRows?(): import("./board/board.ts").BoardRow[];
  /** Task board rows of ONE bot's own threads (the Heartbeat's cheap check reads these). */
  botBoardRows?(botId: string): import("./board/board.ts").BoardRow[];
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
