// Shared bot types. A bot is a named persistent agent with its own MIND (a workspace inside the user's account,
// addressed with the user's MAIN key plus the header X-MIND-Bot: <slug>), its own DAEBOT.md and its own threads.

export interface BotRecord {
  id: string;            // b_<12 hex>
  slug: string;          // ^[a-z0-9-]{1,32}$, unique per owner, never "main"
  name: string;
  purpose: string;
  color: string;
  /** Face id from faces.ts (a personality preset). Absent on bots made before faces: the UI shows the letter badge. */
  face?: string;
  createdAt: number;
  updatedAt: number;
  /** Definition version installed (absent = 1). See versions.ts. */
  version?: number;
  /** LLM override: every turn of THIS bot's threads runs on this model, whatever the header/global choice is. Absent = no override. */
  model?: string;
}

/** One line of the roster shown to the model (sessions and bots alike). */
export interface RosterEntry { slug: string; name: string; purpose: string }

/** Thrown by BotsApi for conditions the REST layer maps to a status code. */
export class BotError extends Error {
  status: number;
  code: string;
  extra?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** What a runtime exposes for its owner's bots. Everything is scoped to ONE owner: another owner's id is simply "not found". */
export interface BotsApi {
  /** MIND is the source of truth for existence: reconciles with GET /bots first (falls back to the local list when MIND is unreachable). */
  list(): Promise<BotRecord[]>;
  /** Local, synchronous view (what prompts and tools read). */
  snapshot(): BotRecord[];
  get(id: string): BotRecord | undefined;
  bySlug(slug: string): BotRecord | undefined;
  create(a: { slug: string; name?: string; purpose?: string; color?: string; face?: unknown }): Promise<BotRecord>;
  /** `model`: a model id sets the override; null or "" clears it. The caller checks the id against the user's model list; the store checks its shape. */
  update(id: string, patch: { name?: string; purpose?: string; color?: string; face?: unknown; model?: string | null }): BotRecord;
  remove(id: string): Promise<void>;
  /** Moves a bot to the latest definition. Keeps its DAEBOT.md, threads and MIND data. */
  upgrade(id: string): BotRecord;
  instructions(id: string): string;
  setInstructions(id: string, text: string): void;
  roster(): RosterEntry[];
}

/** An upgrade link is shown to the user as a clickable link, so only m-i-n-d.ai (and its subdomains) over https passes. */
export function safeUpgradeUrl(u: unknown): string | undefined {
  if (typeof u !== "string") return undefined;
  try {
    const x = new URL(u);
    if (x.protocol !== "https:" || x.username || x.password) return undefined;
    const h = x.hostname.toLowerCase();
    return h === "m-i-n-d.ai" || h.endsWith(".m-i-n-d.ai") ? x.href : undefined;
  } catch { return undefined; }
}

export const SLUG_RE = /^[a-z0-9-]{1,32}$/;
export const MAX_INSTRUCTIONS_BYTES = 8 * 1024;

/** The in-process bot-to-bot message bus (set by startGateway; sessions and bots reach it through the bot_talk tool). */
export interface BotBus {
  talk(req: { owner: string; fromSession: string; selfBot?: string; to: string; message: string; signal?: AbortSignal }): Promise<{ ok: boolean; output: string }>;
}
/** Late-bound holder: runtimes are built before the gateway (and its SessionManager) exists. */
export interface BotBusRef { current?: BotBus }
/** What a runtime needs to host bots: where to keep them, and how to reach the bus. */
export interface BotsContext { dir: string; bus: BotBusRef; /** Late-bound helpers the gateway lends bot_manage (plan models, cleanup after a delete). */ manage?: { current?: import("./manage-tool.ts").BotManageHooks } }
