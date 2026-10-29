import { createHash } from "node:crypto";
import type { MindClient, Tool, ToolClass, ToolResult, ToolSpec } from "../types.ts";

const MAX_OUT = 24_000;

/** Which MINDs a tool set can reach. `home` is where WRITES always go ("main" or a bot slug); reads may name another one. */
export interface TenantResolver {
  home: string;
  /** Live list of the user's bots (the roster the model sees). */
  roster(): { slug: string; name: string; purpose: string }[];
  /** A client for "main" or a bot slug (a bot client sends X-MIND-Bot with the MAIN key). */
  clientFor(mind: string): MindClient;
  /** Optional: reconcile the roster with MIND before it is listed. */
  refresh?(): Promise<void>;
}

export interface MindToolsOptions {
  /** The signed-in username, used in the owner_check wording (never a hardcoded name). */
  user?: string;
  /** Max cross-MIND reads in flight at once (default 3). */
  maxCrossReads?: number;
}

/** Small counting semaphore (the cap on cross-MIND reads in flight). */
export class Semaphore {
  private free: number;
  private waiters: (() => void)[] = [];
  constructor(n: number) { this.free = Math.max(1, n); }
  async acquire(): Promise<() => void> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((r) => this.waiters.push(r));
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiters.shift();
      if (next) next(); else this.free++;
    };
  }
}

const isResolver = (x: MindClient | TenantResolver): x is TenantResolver => typeof (x as TenantResolver).clientFor === "function";

function ownerCheckDesc(user: string): string {
  return `Name who owns the material and who ${user} asked about, then confirm they match. Example, filled in with real names: 'the call notes belong to Acme; ${user} asked about Acme; Acme == Acme'. If the two differ, do not write; tell ${user} in plain words.`;
}

const MIND_PROP = {
  type: "string",
  description: 'Which MIND to read: "main" or a bot slug (see mind_tenants). Default: your own MIND. Writes always go to your own MIND and take no such argument.',
};

function cap(s: string): string {
  return s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n[truncated ${s.length - MAX_OUT} chars]` : s;
}

function fail(msg: string): ToolResult {
  return { ok: false, output: msg };
}

// owner_check must be present and assert A == B. The kernel does the hard check; this is the cheap first line.
function ownerProblem(args: Record<string, unknown>, user: string): string | undefined {
  const v = args.owner_check;
  if (typeof v !== "string" || !v.includes("==")) {
    return `owner_check required: before a MIND write, fill owner_check with the real owner of the material and who ${user} asked about, for example 'the call notes belong to Acme; ${user} asked about Acme; Acme == Acme'. Retry with real names, or tell ${user} why you cannot write.`;
  }
  return undefined;
}

// delete actions (args.action === "delete", or an HTTP-style DELETE method) are irreversible whatever the tool's base class.
export function isDeleteCall(args: Record<string, unknown>): boolean {
  const a = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
  const m = typeof args.method === "string" ? args.method.trim().toLowerCase() : "";
  const f = args.fields && typeof args.fields === "object" ? (args.fields as Record<string, unknown>) : {};
  const fa = typeof f.action === "string" ? f.action.trim().toLowerCase() : "";
  return a === "delete" || m === "delete" || fa === "delete";
}

// Arguments that steer the tool locally and never reach MIND: the owner check and the `mind` (tenant) choice.
// Removed at EVERY depth (a model may tuck them inside fields, arrays of fields, nested objects), before any body is built.
const LOCAL_ARG_KEYS = new Set(["owner_check", "mind"]);
function deepStrip(v: unknown, depth = 0): unknown {
  if (depth > 12 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => deepStrip(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!LOCAL_ARG_KEYS.has(k)) out[k] = deepStrip(x, depth + 1);
  return out;
}
export function stripLocal(args: Record<string, unknown>): Record<string, unknown> {
  return deepStrip(args) as Record<string, unknown>;
}

/** A client whose every request is aborted with the caller's signal (a turn abort or a bot_talk timeout). */
function withSignal(c: MindClient, signal?: AbortSignal): MindClient {
  if (!signal) return c;
  return {
    context: (s, f) => c.context(s, f, signal),
    query: (q, o) => c.query(q, { ...o, signal }),
    remember: (a) => c.remember(a, signal),
    call: (t, a) => c.call(t, a, signal),
  };
}

function botUnsupported(e: unknown): boolean {
  const x = e as { payload?: { error?: unknown }; message?: unknown };
  return x?.payload?.error === "bot_unsupported" || /\bbot_unsupported\b/.test(String(x?.message ?? ""));
}

interface Def {
  name: string;
  description: string;
  properties: Record<string, unknown>;
  required?: string[];
  cls: ToolClass;
  receipt?: "mind";
  ownerGate?: boolean;
  actions?: string[];                 // allowed actions (enforced in run); undefined = no action arg
  run: (client: MindClient, args: Record<string, unknown>) => Promise<string | { text: string; meta?: Record<string, unknown> }>;
}

function build(t: TenantResolver, user: string, cross: Semaphore, d: Def): Tool {
  const properties: Record<string, unknown> = { ...d.properties };
  const required = [...(d.required ?? [])];
  if (d.ownerGate) {
    properties.owner_check = { type: "string", description: ownerCheckDesc(user) };
    required.push("owner_check");
  }
  if (d.cls === "read") properties.mind = MIND_PROP; // only READ tools may name another MIND
  const spec: ToolSpec = {
    name: d.name,
    description: d.description,
    parameters: { type: "object", properties, required, additionalProperties: true },
  };
  const tool: Tool = {
    spec,
    class: d.cls,
    async run(args, ctx) {
      if (d.ownerGate) {
        const p = ownerProblem(args, user);
        if (p) return fail(p);
      }
      if (d.actions) {
        const action = String(args.action ?? d.actions[0]);
        if (!d.actions.includes(action)) {
          return fail(`${d.name}: action '${action}' not allowed here. Allowed: ${d.actions.join(", ")}.`);
        }
      }
      // Which MIND? Writes ALWAYS go to the home MIND. Reads default to home and may name "main" or any bot of the roster.
      let target = t.home;
      const asked = args.mind;
      if (asked !== undefined && asked !== null && asked !== "") {
        if (typeof asked !== "string") return fail('mind must be "main" or a bot slug');
        if (d.cls === "read") {
          const valid = [...new Set(["main", t.home, ...t.roster().map((b) => b.slug)])];
          if (!valid.includes(asked)) return fail(`unknown MIND "${asked}". Valid: ${valid.join(", ")}`);
          target = asked;
        } else if (asked !== t.home) {
          return fail(`${d.name} writes only to your own MIND (${t.home}). To change another MIND, ask the bot that owns it with bot_talk.`);
        }
      }
      const crossRead = d.cls === "read" && target !== t.home;
      const release = crossRead ? await cross.acquire() : undefined;
      try {
        const out = await d.run(withSignal(t.clientFor(target), ctx?.signal), stripLocal(args));
        if (typeof out === "string") return { ok: true, output: cap(out) };
        return { ok: true, output: cap(out.text), ...(out.meta ? { meta: out.meta } : {}) };
      } catch (e) {
        if (botUnsupported(e)) {
          const what = d.name.replace(/^mind_/, "");
          return fail(target === "main"
            ? `MIND does not support ${what} on this route.`
            : d.cls === "read"
              ? `that MIND (${target}) doesn't support ${what} for bots; use mind:"main" (bot MINDs support query, context, documents, entries, graph and profile).`
              : `your bot MIND (${target}) doesn't support ${what}: bot MINDs support query, context, documents, entries, graph and profile. Ask a main session to do it.`);
        }
        return fail((e as Error).message);
      } finally {
        release?.();
      }
    },
  };
  if (d.receipt) tool.receipt = d.receipt;
  if (d.cls === "write") {
    tool.classFor = (args) => (isDeleteCall(args) ? "irreversible" : "write");
  }
  return tool;
}

const actionProp = (actions: string[], dflt?: string) => ({
  type: "string", enum: actions, ...(dflt ? { default: dflt } : {}), description: `One of: ${actions.join(", ")}`,
});
const idProps = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, { type: "string", description: `${k} (for get/update/delete/complete)` }]));
const fieldsProp = { type: "object", description: "Remaining fields for the action (title, status, description, name, email, ...)", additionalProperties: true };

// A resource tool pair: <name> (read) and <name>_write (write + owner gate).
function pair(
  name: string, noun: string, idKey: string, readActions: string[], writeActions: string[],
): Def[] {
  const passthrough = (tool: string) => (c: MindClient, a: Record<string, unknown>) => {
    const { fields, ...rest } = a as { fields?: Record<string, unknown> };
    // `mind` may also be tucked inside fields by a model; it must never reach a request body.
    const { mind: _m, owner_check: _o, ...f } = fields && typeof fields === "object" ? fields : ({} as Record<string, unknown>);
    return c.call(tool, { ...f, ...rest });
  };
  return [
    {
      name: `mind_${name}`,
      description: `Read ${noun} from MIND (${readActions.join(", ")}). Writes use mind_${name}_write.`,
      properties: { action: actionProp(readActions, readActions[0]), ...idProps(idKey), fields: fieldsProp },
      cls: "read", receipt: "mind", actions: readActions, run: passthrough(name),
    },
    {
      name: `mind_${name}_write`,
      description: `Change ${noun} in MIND (${writeActions.join(", ")}). Every call needs owner_check.`,
      properties: { action: actionProp(writeActions), ...idProps(idKey), fields: fieldsProp },
      required: ["action"], cls: "write", ownerGate: true, actions: writeActions, run: passthrough(name),
    },
  ];
}

// ---------- decision_record ----------
// The OOC/EMR decision document. MIND titles never carry / ( ) [ ] or dashes other than the plain separators.
function titlePart(s: string): string {
  return s.replace(/[\/()\[\]]/g, " ").replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80);
}

function todayET(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? Object.entries(x as Record<string, unknown>).map(([k, val]) => `${k}: ${typeof val === "string" ? val : JSON.stringify(val)}`).join("; ") : String(x))).filter((x) => x.trim()) : [];
}

export function decisionTitle(subject: string, date: string): string {
  return `Decision - ${titlePart(subject)} - ${date}`;
}

export function renderDecision(a: Record<string, unknown>, date: string): string {
  const sec = (h: string, items: string[], numbered = false) => (items.length ? `## ${h}\n${items.map((x, i) => (numbered ? `${i + 1}. ${x}` : `- ${x}`)).join("\n")}\n\n` : "");
  const text = (h: string, v: unknown) => (typeof v === "string" && v.trim() ? `## ${h}\n${v.trim()}\n\n` : "");
  return (
    `# Decision: ${String(a.subject).trim()}\nDate: ${date}\n\n` +
    sec("Outcomes, ranked (first is the aim)", list(a.outcomes), true) +
    sec("Options", list(a.options)) +
    sec("Consequences and evidence", list(a.consequences)) +
    text("Evaluation", a.evaluation) +
    text("Decision", a.decision) +
    text("Confidence", a.confidence) +
    sec("Mitigations", list(a.mitigations)) +
    sec("Plan (action, owner)", list(a.plan), true) +
    text("Decision model result", a.decide_result)
  ).trimEnd();
}

export function createMindTools(source: MindClient | TenantResolver, opts: MindToolsOptions = {}): Tool[] {
  // Back-compat: a plain client is a single-MIND tool set (home "main", no bots).
  const t: TenantResolver = isResolver(source)
    ? source
    : { home: "main", roster: () => [], clientFor: () => source };
  const user = opts.user?.trim() || "the user";
  const cross = new Semaphore(opts.maxCrossReads ?? 3);
  const defs: Def[] = [];

  defs.push({
    name: "mind_context",
    description: "Load persistent MIND context (identity, rules, priorities, recent). Slow (up to 2 min). Call at session start.",
    properties: {
      sections: { type: "array", items: { type: "string", enum: ["soul", "user", "rules", "priorities", "recent"] }, description: "Sections to load (default all five)" },
      for_task: { type: "string", description: "What the context is for" },
    },
    cls: "read", receipt: "mind",
    run: (c, a) => c.context(a.sections as string[] | undefined, a.for_task as string | undefined),
  });

  defs.push({
    name: "mind_query",
    description: "Query the MIND knowledge graph with a rich, specific, full-sentence question. Authoritative memory: query before asserting anything exists or not.",
    properties: {
      query: { type: "string", description: "Full-sentence question" },
      mode: { type: "string", enum: ["hybrid", "mix", "global", "local", "naive"], description: "Retrieval mode (default hybrid)" },
      max_context_tokens: { type: "integer", minimum: 1000, description: "Context budget (min 1000, default 4000)" },
    },
    required: ["query"], cls: "read", receipt: "mind",
    run: (c, a) => {
      if (typeof a.query !== "string" || !a.query.trim()) throw new Error("mind_query needs a non-empty query");
      return c.query(a.query, { mode: a.mode as string | undefined, maxContextTokens: a.max_context_tokens as number | undefined });
    },
  });

  defs.push({
    name: "mind_remember",
    description: "Write a PRIVATE entry (outcome, decision, log) or document (knowledge) to MIND. Public posts use mind_feed_post. Every call needs owner_check.",
    properties: {
      type: { type: "string", enum: ["entry", "document"], default: "entry" },
      title: { type: "string" },
      content: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      source: { type: "string" },
    },
    required: ["title", "content"], cls: "write", ownerGate: true,
    run: (c, a) => {
      const type = String(a.type ?? "entry");
      if (type === "feed_post" || type === "thought") throw new Error("mind_remember is private only. Public posts go through mind_feed_post.");
      if (type !== "entry" && type !== "document") throw new Error(`mind_remember: unknown type '${type}'`);
      if (typeof a.title !== "string" || typeof a.content !== "string" || !a.title || !a.content) throw new Error("mind_remember needs title and content");
      return c.remember({ type, title: a.title, content: a.content, tags: a.tags as string[] | undefined, source: a.source as string | undefined });
    },
  });

  defs.push({
    name: "mind_decision_record",
    description: "After a decision, file the decision document as a PRIVATE MIND document titled 'Decision - <subject> - YYYY-MM-DD'. Every call needs owner_check.",
    properties: {
      subject: { type: "string", description: "What was decided, a few words" },
      outcomes: { type: "array", items: { type: "string" }, description: "Ranked outcomes, the user's aim first" },
      options: { type: "array", items: { type: "string" }, description: "Every option considered, each with a short definition" },
      consequences: { type: "array", items: { type: "string" }, description: "Upsides and downsides per option, with evidence" },
      evaluation: { type: "string", description: "How options scored against outcomes" },
      decision: { type: "string", description: "The one decision sentence" },
      confidence: { type: "string", description: "Confidence, stated plainly (include the decide tool's number if used)" },
      mitigations: { type: "array", items: { type: "string" }, description: "One countermeasure per downside of the winner" },
      plan: { type: "array", items: { type: "string" }, description: "Sequenced actions, each with a named owner" },
      decide_result: { type: "string", description: "Paste of the decide tool result, if used" },
      date: { type: "string", description: "YYYY-MM-DD (default today, New York)" },
      stance: { type: "string", enum: ["act", "decline"], description: "Peer requests: \"act\" = you decided to do what another agent asked; \"decline\" = you decided not to (declining is allowed and is recorded too). Only \"act\" unlocks an outward action on a peer-requested turn. Default act." },
    },
    required: ["subject", "decision"], cls: "write", ownerGate: true,
    run: async (c, a) => {
      if (typeof a.subject !== "string" || !titlePart(a.subject)) throw new Error("mind_decision_record needs a subject");
      if (typeof a.decision !== "string" || !a.decision.trim()) throw new Error("mind_decision_record needs the decision sentence");
      const date = typeof a.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(a.date) ? a.date : todayET();
      const declined = a.stance === "decline";
      const body = renderDecision(a, date) + (declined ? "\n\nStance: DECLINED" : "");
      let text: string;
      try {
        text = await c.remember({ type: "document", title: decisionTitle(a.subject, date), content: body, tags: ["decision", "oocemr"], source: "daebot" });
      } catch (e) {
        // MIND unreachable: the decision still gets a local receipt id (clearly marked, NOT in MIND) so the work is not blocked on an outage.
        const local = "local-" + createHash("sha256").update(`${a.subject}|${a.decision}|${Date.now()}`).digest("hex").slice(0, 12);
        return { text: `NOT saved to MIND (${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 120)}). Local decision receipt: ${local}. File it again in MIND when it is back.`, meta: { decisionId: local, subject: a.subject.trim().slice(0, 120), local: true, ...(declined ? { declined: true } : {}) } };
      }
      const id = /^saved \w+ (\S+)/.exec(text)?.[1];
      const rid = id && id !== "document:" ? id : "local-" + createHash("sha256").update(`${a.subject}|${text}|${Date.now()}`).digest("hex").slice(0, 12);
      return { text: `${text}\nDecision receipt: ${rid}`, meta: { decisionId: rid, subject: a.subject.trim().slice(0, 120), ...(declined ? { declined: true } : {}) } };
    },
  });

  defs.push({
    name: "mind_feed_post",
    description: "PUBLIC: post a thought to Anthony's public feed. Only when he explicitly said post, share, tweet or feed.",
    properties: { content: { type: "string", description: "Text to post publicly" } },
    required: ["content"], cls: "public",
    run: (c, a) => {
      if (typeof a.content !== "string" || !a.content.trim()) throw new Error("mind_feed_post needs content");
      return c.call("remember", { type: "feed_post", content: a.content });
    },
  });

  defs.push({
    name: "mind_social",
    description: "PUBLIC social actions: create_thought posts publicly. Only when Anthony explicitly said post, share, tweet or feed.",
    properties: { action: actionProp(["create_thought"], "create_thought"), content: { type: "string" } },
    required: ["action", "content"], cls: "public", actions: ["create_thought"],
    run: (c, a) => c.call("social", a),
  });

  defs.push({
    name: "mind_sense",
    description: "Read MINDsense emotional/context state (state, signals, timeline, spikes, summary).",
    properties: { action: actionProp(["state", "signals", "timeline", "spikes", "summary", "kg_weights"], "state"), days: { type: "integer" }, limit: { type: "integer" } },
    cls: "read", receipt: "mind", actions: ["state", "signals", "timeline", "spikes", "summary", "kg_weights"],
    run: (c, a) => c.call("sense", a),
  });

  defs.push({
    name: "mind_profile",
    description: "Read the MIND profile of the connected user (proves the tenant).",
    properties: { action: actionProp(["get"], "get"), username: { type: "string" } },
    cls: "read", receipt: "mind", actions: ["get"],
    run: (c, a) => c.call("profile", a),
  });

  defs.push(...pair("life", "LIFE items (Focus, Project, Outcome, Task)", "item_id",
    ["list", "get", "stats", "calendar"], ["create", "update", "complete", "move", "delete"]));
  defs.push(...pair("crm", "CRM contacts", "contact_id",
    ["list", "get", "activities"], ["create", "update", "log_activity", "delete"]));
  defs.push(...pair("checklists", "Kanon checklists", "checklist_id",
    ["list", "get"], ["create", "update", "delete"]));
  defs.push(...pair("tasks", "MIND tasks", "task_id",
    ["list", "get"], ["create", "update", "complete", "assign", "delete"]));
  // mind_agents is withheld: /admin/agents lives at the origin root and returned the web app shell
  // on the hosted deploy (2026-10-15). Re-add once the backend admin base URL is confirmed.

  // mind_folders is the WRITE tool (owner gate); listing lives in mind_folders_read.
  defs.push({
    name: "mind_folders_read",
    description: "Read MIND folders (list, routes, suggest).",
    properties: { action: actionProp(["list", "routes", "suggest"], "list"), fields: fieldsProp },
    cls: "read", receipt: "mind", actions: ["list", "routes", "suggest"],
    run: (c, a) => { const { fields, ...r } = a as { fields?: Record<string, unknown> }; return c.call("folders", { ...(fields ?? {}), ...r }); },
  });
  defs.push({
    name: "mind_folders",
    description: "Change MIND folders or filing (create, update, delete, move_documents, set_route). Never file a client's material under our own folders or the reverse. Every call needs owner_check.",
    properties: { action: actionProp(["create", "update", "delete", "move_documents", "set_route"]), ...idProps("folder_id"), fields: fieldsProp },
    required: ["action"], cls: "write", ownerGate: true, actions: ["create", "update", "delete", "move_documents", "set_route"],
    run: (c, a) => { const { fields, ...r } = a as { fields?: Record<string, unknown> }; return c.call("folders", { ...(fields ?? {}), ...r }); },
  });

  const tools = defs.map((d) => build(t, user, cross, d));
  tools.push(tenantsTool(t));
  return tools;
}

// mind_tenants: the live roster of MINDs this tool set can read.
function tenantsTool(t: TenantResolver): Tool {
  return {
    spec: {
      name: "mind_tenants",
      description: 'List the MINDs you can read: "main" (the user\'s main MIND) and every bot with its purpose. Pass a slug as `mind` on any read tool to read it. Writes always go to your own MIND.',
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    class: "read",
    receipt: "mind",
    async run() {
      try { await t.refresh?.(); } catch { /* the local roster is still valid */ }
      const bots = t.roster();
      const lines = [
        `home: ${t.home === "main" ? "main (the user's main MIND)" : `bot ${t.home}`}`,
        `main: the user's main MIND`,
        ...bots.map((b) => `bot ${b.slug} (${b.name})${b.purpose ? `: ${b.purpose}` : ""}`),
      ];
      if (!bots.length) lines.push("(no bots yet)");
      return { ok: true, output: cap(lines.join("\n")) };
    },
  };
}
