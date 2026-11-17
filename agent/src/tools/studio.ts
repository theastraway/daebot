// The studio tools: how a bot (or Dae) puts facts on the Studio floor. studio_counter publishes up to three named counters on the
// caller's own island ("applications 389"); studio_pipeline defines a department's staged pipeline (style → design → system → build →
// review) and moves its stages. Both write only the owner's studio file (class write, no receipt, nothing outward). The caller is the
// session's own bot (or "main"): a bot cannot set another bot's counters; a pipeline belongs to a department and anyone on the team may
// move it, and the log says who did.
import type { Tool, ToolResult } from "../types.ts";
import { StudioError, StudioStore, MAX_COUNTERS, STAGE_STATUSES, pipelineSummary } from "../studio/store.ts";
import { done, failed } from "./contract.ts";
import type { StudioBuilder } from "../studio/builder.ts";
import { LayoutEditError, PALETTE, STAT_KEYS } from "../studio/layout.ts";
import type { LayoutEdit, StudioLayout } from "../studio/layout.ts";

export interface StudioToolsOptions {
  store: StudioStore;
  /** The Studio Builder of this account: studio_build and studio_edit are offered only with it. */
  builder?: StudioBuilder;
  /** The bot id of a session ("main" for the user's own Daebot). */
  botOf: (sessionId: string) => string;
  /** A bot's name for the log, by id. */
  nameOf?: (botId: string) => string | undefined;
}

export function createStudioTools(o: StudioToolsOptions): Tool[] {
  const who = (sid: string) => { const id = o.botOf(sid); return { id, name: o.nameOf?.(id) ?? (id === "main" ? "Dae" : id) }; };
  const counter: Tool = {
    spec: {
      name: "studio_counter",
      description: `Publish a counter on your island in the Studio (the user's bots-as-workers view): a short name and a number, e.g. name "applications", value 389. At most ${MAX_COUNTERS} per bot; reusing a name updates it; value null removes it. Use it for the one or two numbers that say what your department is doing, not for chatter.`,
      parameters: { type: "object", properties: { name: { type: "string", description: "The counter's name, a few words" }, value: { type: ["number", "null"], description: "The number; null removes the counter" }, note: { type: "string", description: "Optional: where the number comes from, one line" } }, required: ["name", "value"] },
    },
    class: "write",
    async run(args, ctx): Promise<ToolResult> {
      const w = who(ctx.sessionId);
      try {
        const list = o.store.setCounter(w.id, args.name, args.value, args.note);
        return done(`${w.name}'s counters: ${list.map((c) => `${c.name} ${c.value}`).join(", ") || "none"}`);
      } catch (e) { return failed(e instanceof StudioError ? e.message : "could not set the counter", { ...(e instanceof StudioError && e.code === "too_many" ? { stop: "the island is full: reuse or remove a counter" } : {}) }); }
    },
  };
  const pipeline: Tool = {
    spec: {
      name: "studio_pipeline",
      description: `A department's staged pipeline on the Studio floor. action "define": department + stages (a list of {name, skill?, bot?}; e.g. style → design → system → build → review, each stage naming the skill that runs it and the bot that owns it). action "advance": department + stage (name or number) + status (${STAGE_STATUSES.join(", ")}) + note. action "status": department. action "remove": department. The island shows "stage k of n" and the exec log says who moved what.`,
      parameters: { type: "object", properties: { action: { type: "string", enum: ["define", "advance", "status", "remove"] }, department: { type: "string" }, stages: { type: "array", items: { type: "object", properties: { name: { type: "string" }, skill: { type: "string" }, bot: { type: "string" } }, required: ["name"] } }, stage: { type: "string" }, status: { type: "string", enum: [...STAGE_STATUSES] }, note: { type: "string" } }, required: ["action", "department"] },
    },
    class: "write",
    async run(args, ctx): Promise<ToolResult> {
      const w = who(ctx.sessionId);
      const action = String(args.action ?? "");
      try {
        if (action === "define") { const p = o.store.define(args.department, args.stages, w.name); return done(`pipeline for ${p.department}: ${p.stages.map((s, i) => `${i + 1} ${s.name}${s.skill ? ` (${s.skill})` : ""}${s.bot ? ` → ${s.bot}` : ""}`).join(", ")}`); }
        if (action === "advance") { const p = o.store.advance(args.department, args.stage, args.status, w.name, args.note); const s = pipelineSummary(p); return done(`${p.department}: stage ${s.stage} of ${s.of}${s.current ? ` (${s.current}, ${s.status})` : " (all done)"}; ${s.done} done`); }
        if (action === "status") { const p = o.store.pipeline(String(args.department ?? "")); if (!p) return failed(`no pipeline for "${String(args.department ?? "")}"`, { next: "define one with action define" }); const s = pipelineSummary(p); return done(`${p.department}: stage ${s.stage} of ${s.of}, ${s.done} done`, { output: p.stages.map((x, i) => `${i + 1}. ${x.name}: ${x.status}${x.skill ? ` (${x.skill})` : ""}${x.bot ? ` → ${x.bot}` : ""}${x.note ? ` – ${x.note}` : ""}`).join("\n") }); }
        if (action === "remove") return o.store.remove(args.department) ? done(`removed the pipeline of ${String(args.department)}`) : failed("no such pipeline");
        return failed("action must be define, advance, status or remove");
      } catch (e) { return failed(e instanceof StudioError ? e.message : "the pipeline could not be changed"); }
    },
  };
  const tools: Tool[] = [counter, pipeline];
  const b = o.builder;
  if (b) {
    const plan = (l: StudioLayout): string => l.islands.slice().sort((x, y) => x.slot - y.slot).map((i) => `${i.name} (${i.color}, slot ${i.slot}${i.slot > 0 && i.slot < 8 ? ", next to the Brain" : ""}; card: ${i.stats.join(" + ")})`).join("; ");
    tools.push({
      spec: {
        name: "studio_build",
        description: "Rebuild the user's Studio office (the isometric floor of their bots) from their real bots: islands per department, desks, colours, the two stats per island card. The user's own edits (renamed or moved islands, hand-placed desks, added departments) are kept. Use it when the user asks to rebuild, redo or refresh the office. New bots and department changes are placed automatically; this is not needed for them.",
        parameters: { type: "object", properties: {}, required: [] },
      },
      class: "write",
      async run(): Promise<ToolResult> {
        try { const l = await b.rebuild(); return done(`office rebuilt (${l.builtBy}): ${plan(l)}${b.lastError ? `. The model plan was skipped (${b.lastError}); the rules layout stands.` : ""}`); }
        catch (e) { return failed(`could not rebuild the office: ${String((e as Error)?.message ?? e).slice(0, 160)}`); }
      },
    });
    tools.push({
      spec: {
        name: "studio_edit",
        description: `Change the user's Studio office layout in their words. op "rename" (island, name): "rename the sales island to Revenue". op "move" (island, to: "brain" | "outer" | slot 1-23): "move Ops next to the Brain". op "add" (name, color?, nearBrain?): "add a Compliance department". op "remove" (island): an island nobody's department names. op "color" (island, color: ${PALETTE.join(", ")}). op "stats" (island, stats: two of ${STAT_KEYS.join(", ")} or "counter:<name>"): what the island card counts. op "move_bot" (bot name or id, island): put a bot's desk on another island. op "rooms" (rooms: list of overview, office, meeting, lounge, workspaces, team, pipelines). Islands are matched by name. Every edit is kept through later rebuilds.`,
        parameters: { type: "object", properties: { op: { type: "string", enum: ["rename", "move", "add", "remove", "color", "stats", "move_bot", "rooms"] }, island: { type: "string" }, name: { type: "string" }, to: { type: ["string", "number"] }, color: { type: "string", enum: [...PALETTE] }, nearBrain: { type: "boolean" }, stats: { type: "array", items: { type: "string" } }, bot: { type: "string" }, rooms: { type: "array", items: { type: "string" } } }, required: ["op"] },
      },
      class: "write",
      async run(args): Promise<ToolResult> {
        const op = String(args.op ?? "");
        const to = typeof args.to === "number" ? args.to : /^\d+$/.test(String(args.to ?? "")) ? Number(args.to) : String(args.to ?? "brain").toLowerCase().includes("outer") ? "outer" : "brain";
        const e = { op, island: args.island, name: args.name, to, color: args.color, nearBrain: args.nearBrain === true, stats: args.stats, bot: args.bot, rooms: args.rooms } as unknown as LayoutEdit;
        try { const l = await b.edit(e); return done(`office updated: ${plan(l)}`); }
        catch (err) { return failed(err instanceof LayoutEditError ? err.message : `could not change the office: ${String((err as Error)?.message ?? err).slice(0, 160)}`); }
      },
    });
  }
  return tools;
}
