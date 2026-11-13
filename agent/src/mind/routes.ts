// Maps an MCP-style tool name + args onto the real MIND REST route. Discovered 2026-10-15 by reading
// the MIND MCP tool surface and probing the
// live API with read-only calls. MIND REST is resource-based (/life/items, /crm/contacts, ...), NOT a
// uniform POST /<tool>, so each tool+action needs a route. Unknown tools fall back to POST /<tool>.

export interface Route {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;                       // relative to the /developer/v1 base, or "/admin/..." (origin-rooted)
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  timeoutMs?: number;                 // override
  /** "backend": MIND's API origin (Email Manager lives at /email/*, outside /developer/v1). Default: the /developer/v1 base. */
  root?: "backend";
  /** Never re-send this request after a network error or a 502/503 (a send or a create must not run twice). */
  noRetry?: boolean;
}

// Args that never go to MIND.
// "mind" picks which MIND a read goes to (it becomes the X-MIND-Bot header); it is never part of a request.
const LOCAL_KEYS = new Set(["owner_check", "mind"]);

function enc(v: unknown): string {
  return encodeURIComponent(String(v ?? ""));
}

function clean(args: Record<string, unknown>, drop: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (LOCAL_KEYS.has(k) || k === "action" || drop.includes(k) || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

function toQuery(o: Record<string, unknown>): Record<string, string> {
  const q: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || typeof v === "object") continue;
    q[k] = String(v);
  }
  return q;
}

function need(args: Record<string, unknown>, key: string, tool: string, action: string): string {
  const v = args[key];
  if (v === undefined || v === null || v === "") throw new Error(`${tool} ${action} needs ${key}`);
  return enc(v);
}

// Generic CRUD router for resources shaped /<base>, /<base>/<id>.
function crud(
  tool: string, base: string, idKey: string, args: Record<string, unknown>,
  extra: Record<string, (args: Record<string, unknown>) => Route> = {},
): Route {
  const action = String(args.action ?? "list");
  if (extra[action]) return extra[action](args);
  switch (action) {
    case "list": return { method: "GET", path: base, query: toQuery(clean(args)) };
    case "get": return { method: "GET", path: `${base}/${need(args, idKey, tool, action)}` };
    case "create": return { method: "POST", path: base, body: clean(args) };
    case "update": return { method: "PATCH", path: `${base}/${need(args, idKey, tool, action)}`, body: clean(args, [idKey]) };
    case "delete": return { method: "DELETE", path: `${base}/${need(args, idKey, tool, action)}` };
    default: throw new Error(`${tool}: unknown action '${action}'`);
  }
}

export function routeFor(toolIn: string, args: Record<string, unknown>): Route {
  const tool = toolIn.replace(/^mind_/, "");
  const action = String(args.action ?? "");
  switch (tool) {
    case "context":
      return {
        method: "POST", path: "/context", timeoutMs: 120_000,
        body: { sections: args.sections ?? ["soul", "user", "rules", "priorities", "recent"], ...(args.for_task ? { for_task: args.for_task } : {}) },
      };
    case "query":
      return { method: "POST", path: "/query", body: clean(args) };
    case "remember": {
      const type = String(args.type ?? "entry");
      // Removing something this client wrote itself (the admin ledger feed replaces its own documents). Never the public feed.
      if (action === "delete") return { method: "DELETE", path: `${type === "document" ? "/documents" : "/entries"}/${need(args, "item_id", tool, action)}` };
      if (type === "feed_post" || type === "thought") return { method: "POST", path: "/thoughts", body: { content: args.content } };
      const body = clean(args, ["type"]);
      return { method: "POST", path: type === "document" ? "/documents" : "/entries", body };
    }
    case "documents":
      // One document by id (title, tags, and with include_content its text). Without an id: the list.
      if (action === "get") return { method: "GET", path: `/documents/${need(args, "doc_id", tool, action)}`, query: toQuery(clean(args, ["doc_id"])) };
      return { method: "GET", path: "/documents", query: toQuery(clean(args)) };
    case "focuses":
      return crud(tool, "/focuses", "focus_id", args);
    case "sense": {
      const a = (action || "state").replace(/_/g, "-");
      if (a === "acknowledge") return { method: "POST", path: `/mindsense/acknowledge/${need(args, "signal_id", tool, a)}`, body: {} };
      return { method: "GET", path: `/mindsense/${a}`, query: toQuery(clean(args)) };
    }
    case "profile": {
      if (args.username) return { method: "GET", path: `/profile/${enc(args.username)}` };
      return { method: "GET", path: "/profile" };
    }
    case "life":
      return crud(tool, "/life/items", "item_id", args, {
        stats: () => ({ method: "GET", path: "/life/stats" }),
        complete: (a) => ({ method: "POST", path: `/life/items/${need(a, "item_id", tool, "complete")}/complete`, body: {} }),
        move: (a) => ({ method: "POST", path: `/life/items/${need(a, "item_id", tool, "move")}/move`, body: { new_status: a.new_status } }),
        calendar: (a) => ({ method: "GET", path: "/life/calendar", query: toQuery(clean(a)) }),
        // Adding an event to the MIND Life calendar (mind_calendar create). Never retried: a second POST would be a second event.
        calendar_create: (a) => ({ method: "POST", path: "/life/calendar", body: clean(a), noRetry: true }),
      });
    case "crm":
      return crud(tool, "/crm/contacts", "contact_id", args, {
        log_activity: (a) => ({ method: "POST", path: `/crm/contacts/${need(a, "contact_id", tool, "log_activity")}/activities`, body: clean(a, ["contact_id"]) }),
        activities: (a) => ({ method: "GET", path: `/crm/contacts/${need(a, "contact_id", tool, "activities")}/activities` }),
      });
    case "email": return emailRoute(args, action || "inbox");
    case "checklists":
      return crud(tool, "/checklists", "checklist_id", args);
    case "tasks":
      return crud(tool, "/tasks", "task_id", args, {
        complete: (a) => ({ method: "POST", path: `/tasks/${need(a, "task_id", tool, "complete")}/complete`, body: {} }),
        assign: (a) => ({ method: "POST", path: `/tasks/${need(a, "task_id", tool, "assign")}/assign`, body: clean(a, ["task_id"]) }),
      });
    case "todos": return todosRoute(args, action || "list");
    case "agents":
      return crud(tool, "/admin/agents", "slug", args, {
        heartbeat: (a) => ({ method: "POST", path: `/admin/agents/${need(a, "slug", tool, "heartbeat")}/heartbeat`, body: clean(a, ["slug"]) }),
      });
    case "bots": {
      // The bots admin API (always the MAIN key, never a bot header): POST /bots {slug,label}, GET /bots, DELETE /bots/{slug}.
      if (action === "create") return { method: "POST", path: "/bots", body: { slug: args.slug, label: args.label } };
      if (action === "delete") return { method: "DELETE", path: `/bots/${need(args, "slug", tool, action)}` };
      if (action === "list" || action === "") return { method: "GET", path: "/bots" };
      throw new Error(`bots: unknown action '${action}'`);
    }
    case "folders":
      return crud(tool, "/folders", "folder_id", args, {
        routes: () => ({ method: "GET", path: "/folders/routes" }),
        suggest: (a) => ({ method: "POST", path: "/folders/suggest", body: clean(a) }),
        move_documents: (a) => ({ method: "POST", path: "/documents/move", body: clean(a) }),
        set_route: (a) => ({ method: "PUT", path: `/folders/routes/${need(a, "source_type", tool, "set_route")}`, body: clean(a, ["source_type"]) }),
      });
    case "social":
      if (action === "create_thought") return { method: "POST", path: "/social/thoughts", body: clean(args) };
      if (action === "feed") return { method: "GET", path: "/social/feed", query: toQuery(clean(args)) };
      throw new Error(`social: unsupported action '${action}'`);
    case "agent_sessions": {
      const sid = args.session_id ? enc(args.session_id) : "";
      // Read side + reply, used by the mind_sessions tool (the user's own Agent Sessions: their Grok bots, Claude Code, Daebot).
      if (action === "list") return { method: "GET", path: "/agent-sessions", query: toQuery(pick(args, ["source_key", "status", "q", "limit", "before", "shared_only"])) };
      if (action === "get") return { method: "GET", path: `/agent-sessions/${need(args, "session_id", tool, action)}`, query: toQuery(pick(args, ["limit", "before_seq"])) };
      // Read-only list of the owner's replies no agent has fetched yet. (The per-session /inbox route marks them delivered, so it is never used here.)
      if (action === "pending") return { method: "GET", path: "/agent-sessions/replies/pending", query: toQuery(pick(args, ["min_age_seconds", "max_age_hours", "limit"])) };
      // The owner's reply: role user, origin mind. This is what wakes the bot. Never re-sent after a network error.
      if (action === "reply") return { method: "POST", path: `/agent-sessions/${need(args, "session_id", tool, action)}/reply`, body: pick(args, ["content"]), timeoutMs: 20_000, noRetry: true };
      if (action === "wake_targets") return { method: "GET", path: "/agent-sessions/wake-targets" };
      if (action === "open") return { method: "POST", path: "/agent-sessions/open", body: clean(args), timeoutMs: 15_000 };
      if (action === "append") return { method: "POST", path: `/agent-sessions/${sid}/append`, body: clean(args, ["session_id"]), timeoutMs: 15_000 };
      if (action === "close") return { method: "POST", path: `/agent-sessions/${sid}/close`, body: clean(args, ["session_id"]), timeoutMs: 15_000 };
      // Every agent source that syncs into the user's MIND, with session counts and stale flags (read-only).
      if (action === "sources") return { method: "GET", path: "/agent-sessions/sources" };
      // The activity map: agents, projects, cells, totals over a time window (read-only). days defaults to 7.
      if (action === "activity") return { method: "GET", path: "/agent-sessions/activity", query: toQuery(pick(args, ["days"])) };
      // Sharing one session with another MIND account (viewer = read, editor = read + post). Used by Daebot's shared threads; owner-only on MIND's side.
      if (action === "shares") return { method: "GET", path: `/agent-sessions/${need(args, "session_id", tool, action)}/shares` };
      if (action === "share_add") return { method: "POST", path: `/agent-sessions/${need(args, "session_id", tool, action)}/shares`, body: pick(args, ["grantee_username", "role"]), timeoutMs: 15_000, noRetry: true };
      if (action === "share_remove") return { method: "DELETE", path: `/agent-sessions/${need(args, "session_id", tool, action)}/shares/${need(args, "share_id", tool, action)}`, timeoutMs: 15_000 };
      if (action === "share_targets") return { method: "GET", path: "/agent-sessions/share-targets", query: toQuery(pick(args, ["q", "limit"])) };
      throw new Error(`agent_sessions: unsupported action '${action}'`);
    }
    default:
      return { method: "POST", path: `/${enc(tool)}`, body: clean(args) };
  }
}

// MIND Email Manager (the mailbox synced from Google or Microsoft 365). The REST routes live at the backend origin, not under
// /developer/v1: GET /email/status|inbox|search|thread/<id>|message/<id>, POST /email/draft|draft/save|send. Found in the MIND MCP
// server (mind_email) and probed read-only on 2026-10-28. A send or a saved draft is never retried.
function pick(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (args[k] !== undefined && args[k] !== null && args[k] !== "") out[k] = args[k];
  return out;
}

function emailRoute(args: Record<string, unknown>, action: string): Route {
  const root = "backend" as const;
  const timeoutMs = 30_000;
  switch (action) {
    case "status": return { method: "GET", path: "/email/status", root, timeoutMs };
    case "inbox": return { method: "GET", path: "/email/inbox", root, timeoutMs, query: toQuery(pick(args, ["top", "unread_only", "page_token"])) };
    case "search": return { method: "GET", path: "/email/search", root, timeoutMs, query: toQuery(pick(args, ["q", "limit"])) };
    case "thread": return { method: "GET", path: `/email/thread/${need(args, "thread_id", "email", action)}`, root, timeoutMs };
    case "message": return { method: "GET", path: `/email/message/${need(args, "message_id", "email", action)}`, root, timeoutMs };
    case "draft": return { method: "POST", path: "/email/draft", root, timeoutMs: 90_000, noRetry: true, body: pick(args, ["message_id", "instructions"]) };
    case "save_draft": return { method: "POST", path: "/email/draft/save", root, timeoutMs, noRetry: true, body: pick(args, ["message_id", "body_text"]) };
    case "send": return { method: "POST", path: "/email/send", root, timeoutMs, noRetry: true, body: pick(args, ["to", "cc", "subject", "body_text", "reply_to_message_id"]) };
    default: throw new Error(`email: unknown action '${action}'`);
  }
}

// MIND to-dos (Workspace > Project > To-do): the store the Astra AI portal reads and writes, /developer/v1/todos. Routes read from the MIND MCP
// server (mind_todos, mcp-server/src/mind-client.ts in MINDapp). Ids are MIND to-do UUIDs, not the portal ids astra_board uses.
// There is deliberately no delete route: an unknown action (including delete) throws. A create or a comment is never retried (a second POST would be a second row).
const TODO_FIELDS = ["title", "description", "notes", "status", "priority", "due_date", "assignee_type", "assignee_id", "spec", "external_ref"];
function todosRoute(args: Record<string, unknown>, action: string): Route {
  const tool = "todos";
  const todo = () => `/todos/${need(args, "todo_id", tool, action)}`;
  switch (action) {
    case "list": return { method: "GET", path: "/todos", query: toQuery(pick(args, ["workspace_id", "project_id", "status", "q", "assignee", "due_before", "waiting"])) };
    case "waiting": return { method: "GET", path: "/todos", query: { ...toQuery(pick(args, ["workspace_id", "project_id"])), waiting: "true" } };
    case "search": return { method: "GET", path: "/todos/search", query: (need(args, "q", tool, action), { q: String(args.q), ...toQuery(pick(args, ["workspace_id", "project_id"])) }) };
    case "get": return { method: "GET", path: todo() };
    case "thread": return { method: "GET", path: `${todo()}/comments` };
    case "progress": return { method: "GET", path: `/projects/${need(args, "project_id", tool, action)}/progress` };
    case "create": {
      need(args, "project_id", tool, action); need(args, "title", tool, action);
      return { method: "POST", path: "/todos", body: pick(args, ["project_id", ...TODO_FIELDS]), noRetry: true };
    }
    case "update": return { method: "PATCH", path: todo(), body: pick(args, TODO_FIELDS) };
    case "start": case "reopen": return { method: "POST", path: `${todo()}/${action}`, body: {} };
    case "complete": return { method: "POST", path: `${todo()}/complete`, body: args.notes ? { note: String(args.notes) } : {} };
    case "comment": {
      need(args, "body", tool, action);
      return { method: "POST", path: `${todo()}/comments`, body: { kind: "comment", body: String(args.body) }, noRetry: true };
    }
    default: throw new Error(`todos: unknown action '${action}'`);
  }
}
