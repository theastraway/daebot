// The board's side of the user's own MIND: LIFE projects to pick from, a LIFE item (an outcome under the project) that mirrors each task,
// status pushed there and pulled back, and the OOC/EMR decision document. Everything goes through ONE MindClient, the signed-in user's own
// (their key or OAuth key; the owner login falls back to the server key exactly as billing does). A task never lands in anyone else's MIND.
import { createHash } from "node:crypto";
import type { MindClient } from "../types.ts";
import type { BoardMind, BoardScope, BoardStatus, BoardTask, ProjectLite } from "./board.ts";

/** Board status -> LIFE column. LIFE has thought / ready / action / active_mind / completed and no "cancelled". */
const TO_LIFE: Record<BoardStatus, string> = {
  not_started: "ready",
  in_progress: "active_mind",
  stopped: "action", // the user has to act
  ready_to_test: "action", // the user has to try it
  cancelled: "thought", // parked, and tagged "cancelled"
};
export const lifeStatusOf = (s: BoardStatus): string => TO_LIFE[s];

/** LIFE column -> board status, for a change made in MIND. "action" and "thought" say nothing certain, so they change nothing. */
export function boardStatusOf(life: string): BoardStatus | undefined {
  if (life === "active_mind") return "in_progress";
  if (life === "ready") return "not_started";
  if (life === "completed") return "ready_to_test";
  return undefined;
}

const STATUS_WORDS: Record<BoardStatus, string> = { not_started: "not started", in_progress: "in progress", stopped: "waiting on the user", ready_to_test: "ready to test", cancelled: "cancelled" };

/** The scope a Focus or project name says: Astra AI (the consulting firm, its clients) or MIND (the product, the user's own work). A name that says neither is MIND. */
export function scopeOfNames(names: Array<string | undefined>, clientNames: string[] = []): BoardScope {
  const hay = names.filter(Boolean).join(" ").toLowerCase();
  if (/\bastra\b/.test(hay)) return "astra";
  for (const c of clientNames) if (c.trim() && hay.includes(c.trim().toLowerCase())) return "astra";
  return "mind";
}

const FOCUS_NAME: Record<BoardScope, string> = { astra: "Astra AI", mind: "MIND" };

async function json(c: MindClient, tool: string, args: Record<string, unknown>): Promise<any> {
  const text = await c.call(tool, args);
  try { return JSON.parse(text); } catch { throw new Error(String(text).slice(0, 160) || `MIND ${tool}: empty answer`); }
}

export function createBoardMind(c: MindClient, o: { clientNames?: string[] } = {}): BoardMind {
  const describe = (t: BoardTask): string => `Declared by Daebot. Board status: ${STATUS_WORDS[t.status]}.${t.decision ? ` Decision: ${t.decision.winner}.` : ""}`;
  const tags = (t: BoardTask, extra: string[] = []): string[] => ["daebot", ...(t.scope ? [t.scope] : []), ...extra];
  return {
    async projects() {
      const [f, p] = await Promise.all([
        json(c, "focuses", { action: "list" }).catch(() => ({ focuses: [] })),
        json(c, "life", { action: "list", item_type: "project", include_completed: false, limit: 200 }),
      ]);
      const focus = new Map<string, string>();
      for (const x of Array.isArray(f?.focuses) ? f.focuses : []) if (x?.focus_id) focus.set(String(x.focus_id), String(x.name ?? ""));
      const out: ProjectLite[] = [];
      for (const it of Array.isArray(p?.items) ? p.items : []) {
        if (!it?.item_id || !it?.title) continue;
        const fname = it.focus_id ? focus.get(String(it.focus_id)) : undefined;
        out.push({ id: String(it.item_id), name: String(it.title), ...(it.focus_id ? { focusId: String(it.focus_id) } : {}), ...(fname ? { focus: fname } : {}), scope: scopeOfNames([fname, String(it.title)], o.clientNames) });
      }
      return out;
    },
    async ensureProject(name, scope) {
      const f = await json(c, "focuses", { action: "list" });
      const want = FOCUS_NAME[scope].toLowerCase();
      let focusId: string | undefined = (Array.isArray(f?.focuses) ? f.focuses : []).find((x: any) => String(x?.name ?? "").trim().toLowerCase() === want)?.focus_id;
      if (!focusId) focusId = (await json(c, "focuses", { action: "create", name: FOCUS_NAME[scope] }))?.focus_id;
      if (!focusId) throw new Error("MIND did not create the Focus");
      const made = await json(c, "life", { action: "create", item_type: "project", title: name, focus_id: focusId, status: "active_mind", tags: ["daebot", scope] });
      if (!made?.item_id) throw new Error("MIND did not create the project");
      return { id: String(made.item_id), name, focusId: String(focusId), focus: FOCUS_NAME[scope], scope };
    },
    async create(t) {
      if (!t.project) throw new Error("the task has no project");
      const lifeStatus = lifeStatusOf(t.status);
      const made = await json(c, "life", { action: "create", item_type: "outcome", title: t.title, parent_id: t.project.id, status: lifeStatus, description: describe(t), tags: tags(t) });
      if (!made?.item_id) throw new Error("MIND did not create the LIFE item");
      return { lifeId: String(made.item_id), lifeStatus };
    },
    async push(t) {
      const lifeStatus = lifeStatusOf(t.status);
      await json(c, "life", { action: "update", item_id: t.lifeId, title: t.title, status: lifeStatus, description: describe(t) });
      return lifeStatus;
    },
    async cancel(t) {
      const lifeStatus = lifeStatusOf("cancelled");
      await json(c, "life", { action: "update", item_id: t.lifeId, status: lifeStatus, description: describe(t), tags: tags(t, ["cancelled"]) });
      return lifeStatus;
    },
    async remove(t) {
      await c.call("life", { action: "delete", item_id: t.lifeId });
    },
    async pull(projectId) {
      const r = await json(c, "life", { action: "list", parent_id: projectId, limit: 500 });
      const out = new Map<string, string>();
      for (const it of Array.isArray(r?.items) ? r.items : []) if (it?.item_id) out.set(String(it.item_id), String(it.status ?? ""));
      return out;
    },
    async saveDecision(title, body) {
      try {
        const text = await c.remember({ type: "document", title, content: body, tags: ["decision", "oocemr", "daebot-task"], source: "daebot" });
        const id = /^saved \w+ (\S+)/.exec(text)?.[1];
        if (id && id !== "document:") return { id };
        return { id: "local-" + createHash("sha256").update(`${title}|${text}|${Date.now()}`).digest("hex").slice(0, 12), local: true };
      } catch {
        return { id: "local-" + createHash("sha256").update(`${title}|${body}|${Date.now()}`).digest("hex").slice(0, 12), local: true };
      }
    },
  };
}
