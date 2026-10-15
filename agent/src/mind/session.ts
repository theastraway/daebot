import type { MindClient, SessionSync } from "../types.ts";

const MAX_QUEUE = 50;
const MAX_MESSAGE_CHARS = 20_000;
const SECRET_RE = /(api[_-]?key|secret|token|password)\s*=\s*\S+/gi;

function redact(s: string): string {
  return s.replace(SECRET_RE, (_m, k) => `${k}=[redacted]`).replace(/mind_[A-Za-z0-9]{12,}/g, "[key]");
}

interface Msg { role: "user" | "assistant"; content: string }

// Agent Session sync against MIND /developer/v1/agent-sessions:
//   POST /open   {source_key, external_session_id, runtime, ...} -> {session_id, pending_replies[]}
//   POST /:id/append {messages:[{role,content}], title?}          -> {pending_replies[]}
//   POST /:id/close  {summary, status:"ended"}
// pending_replies are marked delivered server-side the moment they are returned, so every response
// is harvested into an in-memory inbox and handed out exactly once by pendingReplies().
export function createSessionSync(client: MindClient, sourceKey: string): SessionSync {
  let title = "";
  let externalId = sourceKey;
  let mindSessionId = "";
  let titleSent = false;
  let queue: Msg[] = [];
  const inbox: string[] = [];
  const seen = new Set<string>();
  let chain: Promise<unknown> = Promise.resolve();

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  }

  function parse(text: string): any {
    try { return JSON.parse(text); } catch { return {}; }
  }

  function harvest(data: any): void {
    const list: any[] = Array.isArray(data?.pending_replies) ? data.pending_replies : [];
    for (const r of list) {
      const content = typeof r === "string" ? r : String(r?.content ?? "");
      if (!content) continue;
      const id = typeof r === "object" && r?.id ? String(r.id) : content;
      if (seen.has(id)) continue;
      seen.add(id);
      const who = typeof r === "object" && r?.meta?.replied_by ? String(r.meta.replied_by) : "";
      inbox.push(who ? `[${who}] ${content}` : content);
    }
  }

  async function tryOpen(): Promise<boolean> {
    if (mindSessionId) return true;
    try {
      const data = parse(await client.call("agent_sessions", {
        action: "open", source_key: sourceKey, external_session_id: externalId, runtime: "mindclaw", title,
      }));
      if (data?.session_id) mindSessionId = String(data.session_id);
      harvest(data);
      return !!mindSessionId;
    } catch {
      return false;
    }
  }

  async function flush(): Promise<void> {
    if (!queue.length) return;
    if (!(await tryOpen())) return;
    const batch = queue.slice();
    try {
      const payload: Record<string, unknown> = { action: "append", session_id: mindSessionId, messages: batch };
      if (!titleSent) payload.title = title;
      const data = parse(await client.call("agent_sessions", payload));
      titleSent = true;
      queue = queue.slice(batch.length);
      harvest(data);
    } catch {
      // keep the queue; retried on the next append/close
    }
  }

  return {
    async open(meta) {
      const t = (meta.title ?? "").trim();
      if (!t) throw new Error("session title required: never log an unnamed session");
      if (mindSessionId && t === title) return; // idempotent: already open under this title
      if (t !== title) titleSent = false;       // renamed: next append carries the new title
      title = t;
      if (meta.externalId && meta.externalId.trim()) externalId = meta.externalId.trim();
      await serial(async () => { await tryOpen(); });
    },
    async append(role, content) {
      if (!title) throw new Error("session not opened: call open({title, sourceKey}) first");
      const text = redact(content).slice(0, MAX_MESSAGE_CHARS);
      if (!text.trim()) return;
      await serial(async () => {
        queue.push({ role, content: text });
        if (queue.length > MAX_QUEUE) queue = queue.slice(queue.length - MAX_QUEUE);
        await flush();
      });
    },
    async pendingReplies() {
      await serial(async () => { if (queue.length) await flush(); });
      return inbox.splice(0, inbox.length);
    },
    async close(summary) {
      if (!title) return;
      await serial(async () => {
        await flush();
        if (!mindSessionId) return;
        try {
          const data = parse(await client.call("agent_sessions", {
            action: "close", session_id: mindSessionId, status: "ended", summary: redact(summary ?? "").slice(0, 2000),
          }));
          harvest(data);
        } catch { /* best effort */ }
      });
    },
  };
}
