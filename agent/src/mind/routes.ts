// Maps an MCP-style tool name + args onto the real MIND REST route. Discovered 2026-10-15 by reading
// the MIT-licensed @astramindapp/openclaw-mind client (concepts only, no code copied) and probing the
// live API with read-only calls. MIND REST is resource-based (/life/items, /crm/contacts, ...), NOT a
// uniform POST /<tool>, so each tool+action needs a route. Unknown tools fall back to POST /<tool>.

export interface Route {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;                       // relative to the /developer/v1 base, or "/admin/..." (origin-rooted)
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  timeoutMs?: number;                 // override
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
      if (type === "feed_post" || type === "thought") return { method: "POST", path: "/thoughts", body: { content: args.content } };
      const body = clean(args, ["type"]);
      return { method: "POST", path: type === "document" ? "/documents" : "/entries", body };
    }
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
      });
    case "crm":
      return crud(tool, "/crm/contacts", "contact_id", args, {
        log_activity: (a) => ({ method: "POST", path: `/crm/contacts/${need(a, "contact_id", tool, "log_activity")}/activities`, body: clean(a, ["contact_id"]) }),
        activities: (a) => ({ method: "GET", path: `/crm/contacts/${need(a, "contact_id", tool, "activities")}/activities` }),
      });
    case "checklists":
      return crud(tool, "/checklists", "checklist_id", args);
    case "tasks":
      return crud(tool, "/tasks", "task_id", args, {
        complete: (a) => ({ method: "POST", path: `/tasks/${need(a, "task_id", tool, "complete")}/complete`, body: {} }),
        assign: (a) => ({ method: "POST", path: `/tasks/${need(a, "task_id", tool, "assign")}/assign`, body: clean(a, ["task_id"]) }),
      });
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
      if (action === "open") return { method: "POST", path: "/agent-sessions/open", body: clean(args), timeoutMs: 15_000 };
      if (action === "append") return { method: "POST", path: `/agent-sessions/${sid}/append`, body: clean(args, ["session_id"]), timeoutMs: 15_000 };
      if (action === "close") return { method: "POST", path: `/agent-sessions/${sid}/close`, body: clean(args, ["session_id"]), timeoutMs: 15_000 };
      throw new Error(`agent_sessions: unsupported action '${action}'`);
    }
    default:
      return { method: "POST", path: `/${enc(tool)}`, body: clean(args) };
  }
}
