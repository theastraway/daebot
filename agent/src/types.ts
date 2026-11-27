// THE CONTRACT. Every module codes against this file. Do not change signatures without
// updating agent/SPEC.md and telling the orchestrator. Erasable TypeScript only (no enums,
// no parameter properties, no namespaces) so Node strips types natively.

import type { BotsApi } from "./bots/types.ts";
import type { MemoryOrigin } from "./mind/origin.ts";
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
  // The model's reasoning (a <think> block in the content stream, or the provider's reasoning delta). Shown to the user as its inner voice;
  // never answer text, never part of the transcript the model sees again, never a receipt.
  | { type: "thinking"; delta: string }
  | { type: "toolCall"; call: ToolCall }
  | { type: "done"; usage: Usage; finishReason: string; notice?: string; model?: string }; // notice: a one-line info for the user (e.g. answered on the free model); model: the model that actually answered, when the provider chose another

/** How hard a reasoning model should think on one call. Sent as OpenRouter's `reasoning.effort`; ignored by models without it. */
export type Effort = "low" | "medium" | "high";

export interface Provider {
  readonly name: string;
  /** pinModel: use exactly req.model, with no tier swap and no fallback list (a vision call must not land on a text-only chat model). effort: reasoning effort for this call (router). */
  stream(req: { model: string; messages: Message[]; tools: ToolSpec[]; signal?: AbortSignal; pinModel?: boolean; bot?: string; effort?: Effort }): AsyncIterable<StreamEvent>;
}

/** The model tiers the router chooses between (provider/policy.ts has the table; cheapest first). */
export type ModelTier = "local" | "reflex" | "light" | "coder" | "reasoner" | "frontier";

/** What the router decided for one user turn. applied=false in shadow mode (logged, the configured model still ran). */
export interface RouteDecision {
  tier: ModelTier;
  model: string;
  effort?: Effort;
  /** One line a person can read on the proof card: why this tier. */
  reason: string;
  /** rules = the policy table; later: classifier (a cheap model decision). */
  source: "rules" | "classifier";
  applied: boolean;
}

/** The proof of one turn: what ran, what the kernel blocked, whether the answer carried receipts. Shown on the board. */
export interface TurnProof {
  at: number;
  calls: number;
  failed: number;
  blocked: number;
  /** The final answer shipped with the unverified footer (the receipt gate refused it twice). */
  unverified: boolean;
  /** The answer made a claim that the receipt gate accepted (or needed no receipt). */
  verified: boolean;
  model?: string;
  effort?: Effort;
  tier?: ModelTier;
  route?: string;
  /** Slugs of the agents a successful bot_talk reached this turn ("reviewer" = the reviewer looked). */
  talked?: string[];
  /** The advisor tool answered this turn (a stronger model looked before the answer). */
  advised?: boolean;
  /** Consult-before-done (DAEBOT_CONSULT_BEFORE_DONE=1) on a standard or large build: "ok" = the advisor was consulted, "skipped" = it was not and the answer carries the footer. */
  consult?: "ok" | "skipped";
}

/** The handoff card: what a session (or a delegated piece) is about, in the shape the next worker needs. Written by compaction and by bot_talk delegation. */
export interface HandoffCard {
  objective: string;
  /** Facts and receipts established so far, one per line (paths, ids, what already works). */
  evidence: string[];
  /** What is still to do. */
  left: string[];
  next: string;
  /** How the result is proven. */
  verify?: string;
  /** The tier the piece should run on (delegation). */
  tier?: ModelTier;
  at: number;
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
  /** Set only on tools that come from a connected MCP server: where the server really is and what the server calls the tool. The per-user coder grant is decided on this, never on the model's text. */
  mcp?: { server: string; host: string; tool: string };
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
  /** Calls already finished this turn. The call in flight is not included yet. mind_remember reads this for a prior web_fetch or web_search. */
  calls?: readonly { tool: string }[];
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
  remember(a: { type?: "entry" | "document"; title: string; content: string; tags?: string[]; source?: string; supersedes?: string[]; origin?: MemoryOrigin }, signal?: AbortSignal): Promise<string>;
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
  mindBaseUrl: string;       // default https://mindapp.onrender.com/developer/v1
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
  astraPortalUrl?: string;   // env ASTRA_PORTAL_URL; the Astra AI portal API for the astra_board tool. Default https://api.theastraway.com (theastraway.com is the website and is mapped to it).
  portalDaebotToken?: string; // env PORTAL_DAEBOT_TOKEN; Bearer token for the portal's Daebot board API. Absent = no astra_board tool. Never printed.
  checkInMs?: number;        // env DAEBOT_CHECKIN_MS; default 300000. A running turn gets a one-line-update reminder this often. Absent = off
  contextWindow?: number;    // model context window in tokens, used for compaction (env MINDCLAW_CONTEXT_WINDOW); default 128000
  compactAt?: number;        // fraction of contextWindow that triggers compaction (env MINDCLAW_COMPACT_AT); default 0.6
}

/** One end of an agent exchange: the user's own Daebot ("main") or one of their bots. */
export interface ExchangeParty { id: string; kind: "main" | "bot"; name: string; slug?: string; face?: string; color?: string }

// ---------- agent session + gateway (all surfaces speak this) ----------
// Every surface (terminal, web, desktop, Telegram, Discord, iMessage...) is a thin client of the
// gateway. The gateway owns AgentSessions. Surfaces never touch the provider, tools or kernel.
export interface NoticeAction { kind: "move_to_cloud" | "run_here"; label: string; sessionId: string }
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
  | { type: "notice"; level: "info" | "warn"; text: string; /** One button under the notice, e.g. "Move to MIND Cloud" when the computer a session lives on is off. */ action?: NoticeAction }          // e.g. pending MIND reply surfaced
  // A bot_talk call just happened in this turn: shown as a small "Messaged <agent>" card with the message and (when it answered) the reply.
  // `exchangeId` opens the read-only two-sided transcript of that pair of agents (GET /exchanges/:id).
  | { type: "exchange"; exchangeId: string; from: ExchangeParty; to: ExchangeParty; message: string; reply?: { text: string; ok: boolean }; at: number }
  | { type: "usage"; usage: Usage; totalCostUsd: number; model?: string } // model = the model that produced this call
  // The model's inner voice for the block being produced: shown dimmed and collapsible ahead of the answer, kept in the transcript, never sent back to the model.
  | { type: "thinking"; delta: string }
  // The router's decision for this turn (shadow: applied=false). One per user turn, before the first model call.
  | { type: "route"; decision: RouteDecision }
  // The proof of the turn that just ended (receipts, blocks, model): the board's proof card reads it.
  | { type: "proof"; proof: TurnProof }
  // Compaction wrote a handoff card for this session (objective, evidence, what is left, next action): kept on the session, shown on the board, filed in MIND.
  | { type: "handoff"; card: HandoffCard }
  // The draft just streamed (the text since the last tool/gate/confirm boundary) was withheld by a gate.
  // Clients replace that assistant block with a "rewriting: <reason>" note; the regenerated text streams after it.
  | { type: "retract"; reason: string }
  | { type: "done"; finalText: string };

/** One scope choice behind "Always allow..." / "Always deny...". Generated by the server from the real call; the client only picks an id. */
export interface PermissionOption { id: string; label: string; broad: boolean }

/** An attachment on a user's message: a photo, or a document (PDF). The bytes live server-side per session (src/photos.ts); the model reaches a photo through view_photo and a document through read_document. */
export interface PhotoRef { id: string; name: string; width: number; height: number; kind?: "photo" | "document"; pages?: number }

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
  send(userMessage: string, opts?: { signal?: AbortSignal; origin?: "user" | "bot"; peerReceipt?: string; interactive?: boolean; photos?: PhotoRef[]; quote?: MessageQuote; capabilities?: string[]; device?: DeviceBridge; /** A delegating agent's tier for this piece (a handoff card): the router's floor for this turn. */ routeHint?: ModelTier }): AsyncIterable<AgentEvent>;
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
  openSession(opts: { surface: string; title?: string; resumeId?: string; identity?: string; botId?: string; peer?: string; model?: string; /** Resume the saved thread (transcript, title, board) but start the MODEL with an empty memory. Routine runs. */ fresh?: boolean }): Promise<AgentSession>;
  listSessions(): { id: string; surface: string; title: string; updatedAt: number; bot?: string; peer?: string; model?: string; permMode?: string; unread?: boolean; archived?: boolean; env?: import("./env.ts").EnvTag; envBy?: import("./env.ts").EnvBy; pinnedAt?: number }[];
  /** Bots of this runtime's owner (absent on runtimes built without a bots context). */
  bots?: BotsApi;
  /** Bot / peer / model of a live or persisted session of this owner. */
  sessionInfo?(id: string): { bot?: string; peer?: string; model?: string; permMode?: string; env?: import("./env.ts").EnvTag } | undefined;
  /** Deletes every saved session of a deleted bot: its own threads and the DM threads where it is the peer or the recipient. */
  purgeBotSessions?(botId: string): Promise<number>;
  /** Permanently deletes one saved or live session of this owner (its transcript and state). false = no such session. */
  deleteSession?(id: string): Promise<boolean>;
  /** Renames one saved or live session of this owner (the title is already cleaned). The name is kept for good: the auto title never replaces it. false = no such session. */
  renameSession?(id: string, title: string): Promise<boolean>;
  /** Hides (on) or restores (off) one session of this owner in the lists; nothing is deleted. false = no such session. */
  archiveSession?(id: string, on: boolean): Promise<boolean>;
  /** Pins (on) or unpins (off) one session of this owner. The pin is saved with the session and syncs to every device. false = no such session. */
  setPinned?(id: string, on: boolean): Promise<boolean>;
  /** This runtime's home environment: where its new sessions and bots live (MIND Cloud, this machine, this server). */
  ownEnv?(): import("./env.ts").EnvTag;
  /** Records where this session runs (MIND Cloud or a computer) as the person's decision; saved with the session and synced, the latest decision wins. false = no such session. */
  setHome?(id: string, env: import("./env.ts").EnvTag, by?: import("./env.ts").EnvBy, at?: number): Promise<boolean>;
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
  settings?: import("./settings.ts").SettingsStore;
  // Visible transcript of a live or persisted session (replayed after a resume or restart). Undefined = unknown id.
  history?(id: string): HistoryEvent[] | undefined;
  /** Adds the lines of a finished voice conversation (the live voice agent) to a live or saved session of this owner, as the person's and the bot's messages. false = unknown id. */
  appendVoiceTranscript?(id: string, lines: { role: "user" | "agent"; text: string }[]): Promise<boolean>;
  /** Granular permissions of this owner (rules, mode, pending cards). Absent on runtimes built without a data dir. */
  permissions?: import("./permissions/index.ts").PermissionService;
  /** Suggested replies for the user's next message (1-3, in their voice) and the learning feedback. Absent = not offered. */
  suggestReplies?(id: string, signal?: AbortSignal): Promise<{ replies: string[] }>;
  recordSuggestionFeedback?(id: string, fb: import("./suggest/index.ts").SuggestionFeedback): boolean;
  /** This owner's photo store (photos attached to chat messages). Absent on runtimes built without a data dir: attaching is then refused. */
  photos?: import("./photos.ts").PhotoStore;
  /** Task board rows of this owner: only the tasks Daebot declared (task_board). Most recent sessions first. */
  boardRows?(): import("./board/board.ts").BoardRow[];
  /** Cancel a task: it stays on the board as cancelled and its MIND LIFE item is tagged. */
  /** Runtime-owned card write (the portal engineer): creates or updates one card with the portal link and progress the model cannot set. false = no such session. */
  boardPut?(sessionId: string, task: { id: string; title?: string; status?: import("./board/board.ts").BoardStatus; question?: string; portal?: import("./board/board.ts").BoardPortal; progress?: string | null }): Promise<boolean>;
  boardCancel?(sessionId: string, taskId: string): Promise<"ok" | "notask" | "nosession">;
  /** Delete a task from the board and from MIND LIFE. "mind" = the LIFE item could not be deleted, so the card is still there. */
  boardDelete?(sessionId: string, taskId: string): Promise<"ok" | "nosession" | { error: "notask" | "mind"; message?: string }>;
  /** Pulls LIFE status changes made in MIND back onto the cards. Returns how many cards changed. */
  boardSync?(): Promise<number>;
  /** Hosted: makes this owner's MIND hold every saved session, message by message (all sessions, or `ids`). Idempotent; `dryRun` only reports. */
  mindReconcile?(o?: { ids?: string[]; dryRun?: boolean; force?: boolean }): Promise<import("./mind/session-log.ts").ReconcileSummary | undefined>;
  /** The text of a decision document filed for a task (read from the user's own MIND). */
  decisionDoc?(id: string): Promise<{ title: string; content: string } | undefined>;
  /** Task board rows of ONE bot's own threads (the Heartbeat's cheap check reads these). */
  botBoardRows?(botId: string): import("./board/board.ts").BoardRow[];
  /** Daebot Studio: the user's bots as workers on the floor (studio/index.ts), from this owner's bots, sessions, board rows and pending permission cards. */
  studio?(extra: { exchanges: readonly import("./studio/index.ts").StudioExchangeIn[] }): Promise<import("./studio/index.ts").StudioView & { live?: ReturnType<import("./agents/hub.ts").HelperHub["list"]> }>;
  /** Daebot Studio's Live room: this owner's helpers and loops right now (agents/hub.ts). Cheap: polled every few seconds while something runs. */
  studioLive?(): ReturnType<import("./agents/hub.ts").HelperHub["list"]>;
  /** "Rebuild office": a fresh layout plan from the account's bots (the model's when one is offered), keeping the user's edits. */
  studioRebuild?(): Promise<{ builtBy: string; islands: number; note?: string }>;
  /** The token team (Studio): the route log's bill per tier today, all time and for one session, with the all-frontier counterfactual, plus the rules in play. */
  team?(sessionId?: string): import("./studio/index.ts").TeamView;
  /** The lessons and learned skills in play for a session (the lesson drawer), with their counters. Undefined = unknown session or no learning there. */
  lessons?(id: string): { scope?: string; items: LessonView[] } | undefined;
  /** The user's thumbs on a lesson or learned skill: up = it helped, down = it hurt. Written to MIND. false = unknown session or key. */
  voteLesson?(id: string, key: string, up: boolean): Promise<boolean>;
  /** The model router's mode and policy table of this runtime. */
  /** Desktop and self-host: look again for the local model server (after the Connections panel changed it) and refresh the router's local model. Hosted: undefined. */
  refreshLocal?(): Promise<{ base: string; models: string[] } | undefined>;
  routing?(): { mode: "off" | "shadow" | "enforce"; tiers: { tier: ModelTier; model: string; use: string; effort?: Effort }[]; local?: string; frontierSpentUsd?: number; frontierCapUsd?: number; learned?: string[]; factGate?: string };
}

/** One lesson or learned skill as the lesson drawer shows it. */
export interface LessonView {
  key: string; type: "lesson" | "skill"; title: string; text: string; status: "active" | "demoted" | "retired";
  uses: number; helped: number; hurt: number; updated: string; scope?: string; scopes?: string[];
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
