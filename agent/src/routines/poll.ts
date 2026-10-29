// What the polled triggers look at. Each source reads ONE list from the user's MIND with the user's own key (through `call`, the same
// client the mind_* tools use) and turns it into items with a stable id. The runner keeps the ids it has already reported, so every
// new item fires once; the first look only records what is already there. Everything read here was written by other people or systems:
// it is cut to one short line and handed to the bot as untrusted data.
import { instantPasses, wallOf } from "./clock.ts";
import type { Trigger } from "./triggers.ts";

export interface PollItem { id: string; text: string }
export type MindCall = (owner: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;

const line = (v: unknown, max: number): string => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
function json(text: string): any {
  try { return JSON.parse(text); } catch { return undefined; }
}
const rows = (j: any, key: string): any[] => (Array.isArray(j?.[key]) ? j[key] : []);

/** Today's date (YYYY-MM-DD) in a time zone. */
export function todayIn(tz: string, now: number): string {
  const w = wallOf(now, tz);
  return `${w.y}-${String(w.mo).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

export async function pollSource(call: MindCall, owner: string, t: Trigger, now: number, signal?: AbortSignal): Promise<PollItem[]> {
  switch (t.type) {
    case "mind_document": {
      const j = json(await call(owner, "documents", { action: "list", limit: 30 }, signal));
      if (!j || typeof j !== "object") throw new Error("MIND sent back something unreadable for the documents");
      return rows(j, "documents").filter((d) => d?.id).map((d) => ({ id: String(d.id), text: `New MIND document "${line(d.title, 120)}" (source ${line(d.source, 30) || "unknown"}, ${line(d.created_at, 30)})` }));
    }
    case "mind_task":
    case "mind_task_due": {
      const j = json(await call(owner, "tasks", { action: "list" }, signal));
      if (!j || typeof j !== "object") throw new Error("MIND sent back something unreadable for the tasks");
      const all = rows(j, "tasks").filter((x) => x?.task_id);
      if (t.type === "mind_task") return all.map((x) => ({ id: String(x.task_id), text: `New MIND task "${line(x.title, 120)}"${x.due_date ? ` (due ${line(x.due_date, 10)})` : ""}` }));
      const today = todayIn(t.tz ?? "America/New_York", now);
      return all
        .filter((x) => typeof x.due_date === "string" && x.due_date.slice(0, 10) <= today && !/^(done|completed|complete|cancelled|canceled|archived)$/i.test(String(x.status ?? "")))
        .map((x) => ({ id: `${x.task_id}@${String(x.due_date).slice(0, 10)}`, text: `MIND task "${line(x.title, 120)}" is due (${line(x.due_date, 10)})` }));
    }
    case "mind_contact": {
      const j = json(await call(owner, "crm", { action: "list" }, signal));
      if (!j || typeof j !== "object") throw new Error("MIND sent back something unreadable for the contacts");
      return rows(j, "contacts").filter((c) => c?.contact_id).map((c) => ({ id: String(c.contact_id), text: `New CRM contact ${line(c.name, 80)}${c.email ? ` <${line(c.email, 80)}>` : ""}${c.company ? ` at ${line(c.company, 60)}` : ""} (${line(c.type, 20) || "contact"})` }));
    }
    case "mail_new": {
      const j = json(await call(owner, "email", { action: "inbox", top: 25, unread_only: true }, signal));
      if (!j || typeof j !== "object") throw new Error("MIND sent back something unreadable for the mail");
      return rows(j, "messages").filter((m) => m?.id && m.is_read !== true).map((m) => ({
        id: String(m.id),
        text: `New email from ${[line(m.from_name, 60), m.from_email ? `<${line(m.from_email, 80)}>` : ""].filter(Boolean).join(" ") || "(no sender)"}: ${line(m.subject, 160) || "(no subject)"}${m.preview ? ` | ${line(m.preview, 200)}` : ""} (message id ${line(m.id, 60)})`,
      }));
    }
    default: return [];
  }
}

/** The activity filter on a trigger (weekdays / active hours) says whether an event may fire right now. */
export const triggerOpen = (t: Trigger, now: number): boolean => instantPasses(t.filter, t.tz ?? "America/New_York", now);
