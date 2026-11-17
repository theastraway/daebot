// The Studio Builder of ONE account: keeps that account's office layout (layout.ts) true to its real bots, by itself.
//   current()  every Studio read: migrates an old schema or renderer, places new bots, removes deleted ones, keeps the user's edits;
//              with no layout yet it builds one by the rules at once and asks the model for a better plan in the background.
//   rebuild()  "Rebuild office" and the studio_build tool: a fresh plan from the bots (model when offered), keeping the user's edits.
//   edit()     studio_edit: one change in the user's words (rename, move next to the Brain, add a department, move a bot...).
// The model call is the account's own (its MIND plan or its own key, its default model); its answer is only a proposal that
// applyModelPlan checks field by field. No model offered, or the call fails: the rules layout stands.
import type { StudioStore } from "./store.ts";
import { applyEdit, applyModelPlan, migrateLayout, parsePlan, plannerMessages, reconcileLayout, rulesLayout, GENERAL, MANAGER } from "./layout.ts";
import type { LayoutBot, LayoutEdit, StudioLayout } from "./layout.ts";

export type PlannerCall = (messages: { role: "system" | "user"; content: string }[]) => Promise<string>;

export interface StudioBuilderOptions {
  store: StudioStore;
  bots: () => Promise<LayoutBot[]>;
  planner?: PlannerCall;
  now?: () => number;
  log?: (msg: string) => void;
}

export class StudioBuilder {
  private o: StudioBuilderOptions;
  private inflight: Promise<StudioLayout> | undefined;
  /** Why the last model plan did not apply (shown in the Studio as a hint), cleared on success. */
  lastError = "";
  constructor(o: StudioBuilderOptions) { this.o = o; }
  private now(): number { return this.o.now ? this.o.now() : Date.now(); }

  /** The layout to draw now. Never waits on a model. */
  async current(): Promise<StudioLayout> {
    const bots = await this.o.bots();
    const raw = this.o.store.rawLayout();
    if (raw === undefined) {
      const l = rulesLayout(bots, this.now());
      this.o.store.setLayout(l);
      if (this.o.planner) void this.rebuild({ background: true }).catch(() => undefined);
      return l;
    }
    const r = migrateLayout(raw, bots, this.now());
    if (r.migrated) this.o.store.setLayout(r.layout);
    return r.layout;
  }

  /** A fresh plan. Keeps hand-made islands, locked fields and pinned desks; regroups the rest. */
  async rebuild(opts: { background?: boolean; useModel?: boolean } = {}): Promise<StudioLayout> {
    if (this.inflight) return this.inflight;
    const run = (async () => {
      const bots = await this.o.bots();
      const now = this.now();
      const prev = migrateLayout(this.o.store.rawLayout() ?? rulesLayout(bots, now), bots, now).layout;
      const keep: StudioLayout = { ...prev, desks: Object.fromEntries(Object.entries(prev.desks).filter(([k]) => prev.pinned.includes(k))), islands: prev.islands.filter((i) => i.slug === MANAGER || i.source === "user" || (i.locked && Object.keys(i.locked).length) || i.source === "department" || i.slug === GENERAL), builtAt: now };
      let l = reconcileLayout(keep, bots, now).layout;
      l.builtBy = "rules";
      if (this.o.planner && opts.useModel !== false) {
        try {
          const counters: Record<string, string[]> = {};
          const text = await this.o.planner(plannerMessages(bots, { counters }));
          const plan = parsePlan(text);
          if (!plan) throw new Error("the model's plan was not JSON");
          const r = applyModelPlan(l, plan, bots, now);
          l = r.layout;
          this.lastError = "";
        } catch (e) {
          this.lastError = String((e as Error)?.message ?? e).slice(0, 200);
          this.o.log?.(`studio builder: model plan skipped (${this.lastError})`);
        }
      }
      // A user edit that landed while the model thought wins over a background plan.
      const latest = this.o.store.rawLayout() as { updatedAt?: number; builtBy?: string } | undefined;
      if (opts.background && latest && latest.builtBy === "user" && latest.updatedAt !== prev.updatedAt) return migrateLayout(latest, bots, now).layout;
      l.builtAt = now; l.updatedAt = now;
      this.o.store.setLayout(l);
      return l;
    })();
    this.inflight = run;
    try { return await run; } finally { this.inflight = undefined; }
  }

  async edit(e: LayoutEdit): Promise<StudioLayout> {
    const bots = await this.o.bots();
    const now = this.now();
    const cur = await this.current();
    const l = applyEdit(cur, e, bots, now);
    l.builtBy = "user";
    this.o.store.setLayout(l);
    return l;
  }
}
