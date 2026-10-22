// Feeds the admin ledger (mistakes.ts) into Daebot's MIND knowledge graph, through the same MindClient write path the learner uses.
//   * one document per mistake TYPE, "Daebot Mistake - <type>": definition, prevention rule, count, last seen, last 10 occurrences.
//     MIND has no in-place edit for documents, so "update" = write the new version, then delete the old one (id kept in the ledger).
//   * one entry per occurrence, "Lesson - Failure - <type>".
//   * one entry per task open or close, "Daebot Task - Opened|Closed - <title>".
//   * one document per day, "Daebot KPIs - YYYY-MM-DD" (scheduled at 23:30 ET, on demand, and in the backfill).
// Everything is PRIVATE (document / entry), never a feed post. It writes with the server's owner MIND key (Anthony's own MIND), never a client tenant.
// Writes fail open: a MIND outage must never stop the ledger from recording.
import type { MindClient } from "../types.ts";
import type { AdminLedger, Occurrence, Task } from "./mistakes.ts";
import { etDay } from "./mistakes.ts";

type Writer = Pick<MindClient, "remember" | "call">;
const SOURCE = "daebot-ledger";

/** MIND titles: no slash, parentheses or dashes inside the text (the card derives its title from it). */
export function cleanTitlePart(s: string, max = 80): string {
  return s.replace(/[\/\\()\[\]{}–—]/g, " ").replace(/\s+-\s+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim() || "unnamed";
}
const one = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().slice(0, n);
const idOf = (res: string): string | undefined => { const m = /saved (?:entry|document) ([A-Za-z0-9_-]+)\b/.exec(res); return m && m[1] !== "undefined" ? m[1] : undefined; };
const dayOf = (iso: string | null): string => (iso ? etDay(Date.parse(iso)) : "never");

export function typeDocBody(t: NonNullable<ReturnType<AdminLedger["typeSummary"]>>): string {
  const rows = t.recent.map((o, i) => `${i + 1}. ${etDay(Date.parse(o.when))} | ${o.product} | ${one(o.what, 300)}${o.quote ? ` | Anthony: "${one(o.quote, 200)}"` : ""}${o.fix ? ` | Fix: ${one(o.fix, 200)}` : ""}`);
  return [
    `Daebot Mistake type: ${t.name}`, "",
    `Definition: ${t.definition || "not written yet"}`,
    `Prevention rule: ${t.prevention || "not written yet"}`,
    `Count: ${t.count}`,
    `Last seen: ${dayOf(t.last_seen)}`, "",
    `Last ${t.recent.length} occurrences, newest first:`,
    ...(rows.length ? rows : ["none recorded"]), "",
    "Source: Daebot admin Mistake Log (daebot.live/admin/mistakes). This document is replaced each time the count changes.",
  ].join("\n");
}
export function occurrenceBody(o: Occurrence, typeName: string): string {
  return [
    `Mistake type: ${typeName}`, `Date: ${etDay(Date.parse(o.when))}`, `Agent: ${o.agent}`, `Product: ${o.product}`, "",
    `What happened: ${o.what}`, `Anthony's words: ${o.quote || "none recorded"}`, `Impact: ${o.impact || "none recorded"}`, `Fix: ${o.fix || "none recorded"}`,
    ...(o.links.length ? ["", `Links: ${o.links.join(" ")}`] : []),
  ].join("\n");
}
export function taskBody(t: Task, verb: string): string {
  return [
    `Task ${verb.toLowerCase()}: ${t.title}`, `Product: ${t.product}`, `Requester: ${t.requester}`, `Status: ${t.status}`,
    `Requested: ${etDay(Date.parse(t.requested_at))}`, `Completed: ${t.completed_at ? etDay(Date.parse(t.completed_at)) : "not yet"}`,
    `Prompts to satisfaction: ${t.prompts_to_satisfaction}`, `Re-asks: ${t.repeats}`, `Anger flag: ${t.anger_flag ? "yes" : "no"}`,
    `Verified on: ${t.verified_on || "not recorded"}`,
  ].join("\n");
}
export function kpiBody(k: ReturnType<AdminLedger["kpiSnapshot"]>): string {
  const pct = k.success_rate === null ? "n/a" : `${Math.round(k.success_rate * 1000) / 10}%`;
  return [
    `Daebot KPIs for ${k.day}`, "",
    `Tasks verified today: ${k.verified_today}`, `Tasks verified this week: ${k.verified_week}`, `Tasks verified all time: ${k.verified_all}`,
    `Tasks total: ${k.total_tasks} (closed ${k.closed}, open ${k.open_total}, open over 24h ${k.open_over_24h})`,
    `Success rate (verified of closed): ${pct}`,
    `Prompts to satisfaction: median ${k.median_prompts}, average ${k.avg_prompts}`,
    `Satisfied in one prompt: ${k.one_prompt}, two: ${k.two_prompts}, three or more: ${k.three_plus}`,
    `Re-asks (sum of repeats): ${k.reasks}`, `Anger count (tasks flagged angry): ${k.angry}`,
    `Mistakes logged: ${k.mistakes_total} across ${k.mistake_types} types`,
    `Tasks with estimated values: ${k.estimated}`,
  ].join("\n");
}

export class MindFeed {
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private client: Writer;
  private ledger: () => AdminLedger;
  private warn: (m: string) => void;
  private waitMs: number;
  constructor(client: Writer, ledger: () => AdminLedger, warn: (m: string) => void = (m) => process.stderr.write(m + "\n"), waitMs = 15_000) {
    this.client = client; this.ledger = ledger; this.warn = warn; this.waitMs = waitMs;
  }

  /** Serialized (so two requests can never both create the same document) and bounded by waitMs for the caller; the work itself finishes in the background. */
  private run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    const job = this.chain.then(fn).catch((e) => { this.warn(`mind-feed ${label}: ${String((e as Error)?.message ?? e).slice(0, 160)}`); return undefined; });
    this.chain = job;
    return Promise.race([job as Promise<T | undefined>, new Promise<undefined>((r) => setTimeout(() => r(undefined), this.waitMs).unref())]);
  }

  private async del(type: "document" | "entry", id: string): Promise<void> {
    try { await this.client.call("remember", { action: "delete", type, item_id: id }); } catch (e) { this.warn(`mind-feed delete ${type} ${id}: ${String((e as Error)?.message ?? e).slice(0, 100)}`); }
  }

  /** Replace a type's document with its current state (or remove it when the type is gone). Returns the MIND id. */
  async syncType(typeId: string): Promise<string | undefined> {
    return this.run("type", async () => {
      const L = this.ledger();
      const old = L.mindId("types", typeId);
      const t = L.typeSummary(typeId);
      if (!t) { if (old) { await this.del("document", old); L.setMindId("types", typeId, undefined); } return undefined; }
      const res = await this.client.remember({ type: "document", title: `Daebot Mistake - ${cleanTitlePart(t.name)}`, content: typeDocBody(t), tags: ["daebot-mistake", "daebot-mistake-type"], source: SOURCE });
      const id = idOf(res);
      if (!id) throw new Error("no id returned for type document");
      L.setMindId("types", typeId, id);
      if (old && old !== id) await this.del("document", old);
      return id;
    });
  }
  async occurrence(o: Occurrence, typeName: string): Promise<void> {
    await this.run("occurrence", async () => {
      const res = await this.client.remember({ type: "entry", title: `Lesson - Failure - ${cleanTitlePart(typeName, 60)}`, content: occurrenceBody(o, typeName), tags: ["daebot-mistake-occurrence", "failure"], source: SOURCE });
      const id = idOf(res);
      if (id) this.ledger().setOccurrenceMindId(o.id, id);
    });
  }
  /** A mistake was logged: the occurrence entry and the refreshed type document, in the same request. */
  async onMistake(r: { type_id: string; type: string; occurrence?: Occurrence }): Promise<void> {
    if (r.occurrence) await this.occurrence(r.occurrence, r.type);
    await this.syncType(r.type_id);
  }
  async onOccurrenceDeleted(d: { removed: Occurrence; type_id: string }): Promise<void> {
    if (d.removed.mind_id) await this.run("delete occurrence", () => this.del("entry", d.removed.mind_id!));
    await this.syncType(d.type_id);
  }
  async onTask(verb: "Opened" | "Closed", t: Task): Promise<void> {
    await this.run("task", async () => {
      await this.client.remember({ type: "entry", title: `Daebot Task - ${verb} - ${cleanTitlePart(t.title, 90)}`, content: taskBody(t, verb), tags: ["daebot-task", verb.toLowerCase()], source: SOURCE });
    });
  }
  async snapshot(final = false): Promise<{ day: string; id?: string }> {
    const day = etDay(Date.now());
    const id = await this.run("kpis", async () => {
      const L = this.ledger();
      const k = L.kpiSnapshot();
      const old = L.mindId("snaps", k.day);
      const res = await this.client.remember({ type: "document", title: `Daebot KPIs - ${k.day}`, content: kpiBody(k), tags: ["daebot-kpis"], source: SOURCE });
      const nid = idOf(res);
      if (!nid) throw new Error("no id returned for KPI snapshot");
      L.setMindId("snaps", k.day, nid);
      if (final) L.setMindId("snaps", `${k.day}:final`, nid);
      if (old && old !== nid) await this.del("document", old);
      return nid;
    });
    return { day, id };
  }
  /** Every type as one document (occurrences are summarized inside, never 1,644 inserts) plus today's KPI snapshot. */
  async backfill(): Promise<{ types: number; failed: number; snapshot?: string }> {
    const ids = this.ledger().typeIds();
    let ok = 0, failed = 0;
    for (const id of ids) { (await this.syncTypeWait(id)) ? ok++ : failed++; }
    const s = await this.snapshotWait();
    return { types: ok, failed, snapshot: s.id };
  }
  // backfill may take longer than the per-request wait, so these wait for the job itself
  private async syncTypeWait(id: string) { const w = this.waitMs; this.waitMs = 120_000; try { return await this.syncType(id); } finally { this.waitMs = w; } }
  private async snapshotWait() { const w = this.waitMs; this.waitMs = 120_000; try { return await this.snapshot(); } finally { this.waitMs = w; } }

  /** Daily KPI snapshot: after 23:30 Eastern, once per day (the ledger remembers the final snapshot, so a restart does not repeat it; earlier same-day snapshots are replaced). */
  start(): void {
    const tick = () => {
      const now = new Date();
      const hm = now.toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
      if (hm < "23:30") return;
      if (this.ledger().mindId("snaps", `${etDay(now.getTime())}:final`)) return;
      void this.snapshot(true);
    };
    this.timer = setInterval(tick, 10 * 60_000);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }
}
