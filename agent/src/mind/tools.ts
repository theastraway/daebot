import type { MindClient, Tool, ToolClass, ToolResult, ToolSpec } from "../types.ts";

const MAX_OUT = 24_000;

const OWNER_CHECK_DESC =
  "State: '<material> belongs to <entity A>; Anthony asked about <entity B>; A == B'. If A differs from B, stop.";

const ownerCheckProp = { type: "string", description: OWNER_CHECK_DESC };

function cap(s: string): string {
  return s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n[truncated ${s.length - MAX_OUT} chars]` : s;
}

function fail(msg: string): ToolResult {
  return { ok: false, output: msg };
}

// owner_check must be present and assert A == B. The kernel does the hard check; this is the cheap first line.
function ownerProblem(args: Record<string, unknown>): string | undefined {
  const v = args.owner_check;
  if (typeof v !== "string" || !v.includes("==")) {
    return "owner_check required: state '<material> belongs to <A>; Anthony asked about <B>; A == B' before any MIND write.";
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

function stripLocal(args: Record<string, unknown>): Record<string, unknown> {
  const { owner_check: _o, ...rest } = args;
  return rest;
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
  run: (client: MindClient, args: Record<string, unknown>) => Promise<string>;
}

function build(client: MindClient, d: Def): Tool {
  const properties: Record<string, unknown> = { ...d.properties };
  const required = [...(d.required ?? [])];
  if (d.ownerGate) {
    properties.owner_check = ownerCheckProp;
    required.push("owner_check");
  }
  const spec: ToolSpec = {
    name: d.name,
    description: d.description,
    parameters: { type: "object", properties, required, additionalProperties: true },
  };
  const tool: Tool = {
    spec,
    class: d.cls,
    async run(args) {
      if (d.ownerGate) {
        const p = ownerProblem(args);
        if (p) return fail(p);
      }
      if (d.actions) {
        const action = String(args.action ?? d.actions[0]);
        if (!d.actions.includes(action)) {
          return fail(`${d.name}: action '${action}' not allowed here. Allowed: ${d.actions.join(", ")}.`);
        }
      }
      try {
        const out = await d.run(client, stripLocal(args));
        return { ok: true, output: cap(out) };
      } catch (e) {
        return fail((e as Error).message);
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
    return c.call(tool, { ...(fields ?? {}), ...rest });
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

export function createMindTools(client: MindClient): Tool[] {
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
  defs.push(...pair("agents", "the agent registry (admin key)", "slug",
    ["list", "get"], ["create", "update", "heartbeat", "delete"]));

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

  return defs.map((d) => build(client, d));
}
