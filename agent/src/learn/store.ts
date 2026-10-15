// LearnStore: MIND-backed long-term memory for lessons, skills and the user model.
// Everything goes through the MindClient (query / remember). Records are append-only revisions (see records.ts).
// Counter changes (uses/helped/hurt) are kept as local deltas and written as a new revision on flush.
import type { MindClient } from "../types.ts";
import type { LearnConfig } from "./config.ts";
import { contentProblem } from "./guard.ts";
import { latestByKey, latestUserModel, parseRecords, serializeLesson, serializeSkill, serializeUserModel } from "./records.ts";
import { clip, jaccard, keyFor, lessonTitle, oneLine, skillTitle, slug, tokenSet, today, validLessonTitle } from "./text.ts";
import type { Item, Lesson, LessonKind, Skill, Status, UserModel, UserPref } from "./types.ts";

export interface WriteResult { action: "created" | "appended" | "rejected"; item?: Item; id?: string; why?: string }
interface Delta { uses: number; helped: number; hurt: number; successes: number; failures: number }
const ZERO = (): Delta => ({ uses: 0, helped: 0, hurt: 0, successes: 0, failures: 0 });

const SEVERITY: Record<Status, number> = { active: 0, demoted: 1, retired: 2 };
const worse = (a: Status, b: Status): Status => (SEVERITY[a] >= SEVERITY[b] ? a : b);

function savedId(res: string): string | undefined {
  const m = /saved (?:entry|document) ([A-Za-z0-9_-]+)\b/.exec(res);
  return m && m[1] !== "undefined" ? m[1] : undefined;
}

function itemText(i: Item): string {
  return i.type === "lesson" ? `${i.trigger} ${i.behavior} ${i.rule}` : `${i.name} ${i.description} ${i.preconditions.join(" ")} ${i.tools.join(" ")}`;
}

export class LearnStore {
  private pool = new Map<string, Item>();
  private deltas = new Map<string, Delta>();
  private sticky = new Map<string, Status>();
  private queryCache = new Map<string, Item[]>();
  private userModel: UserModel | undefined;
  private userModelLoaded = false;
  queries = 0;
  writes = 0;

  private client: MindClient;
  private cfg: LearnConfig;
  private o: { clientNames?: string[]; now?: () => Date };

  constructor(client: MindClient, cfg: LearnConfig, o: { clientNames?: string[]; now?: () => Date } = {}) {
    this.client = client;
    this.cfg = cfg;
    this.o = o;
  }

  private now(): Date { return this.o.now ? this.o.now() : new Date(); }

  // ---------- reads ----------
  /** Effective view of an item: stored counters plus unflushed local deltas, with the status those counters imply. */
  view(i: Item): Item {
    const d = this.deltas.get(i.key);
    let v: Item = i;
    if (d) {
      v = i.type === "lesson"
        ? { ...i, uses: i.uses + d.uses, helped: i.helped + d.helped, hurt: i.hurt + d.hurt }
        : { ...i, uses: i.uses + d.uses, helped: i.helped + d.helped, hurt: i.hurt + d.hurt, successes: i.successes + d.successes, failures: i.failures + d.failures };
    }
    const status = worse(this.statusFor(v), this.sticky.get(i.key) ?? "active");
    return status === v.status ? v : { ...v, status };
  }

  all(): Item[] { return [...this.pool.values()].map((i) => this.view(i)); }
  get(key: string): Item | undefined { const i = this.pool.get(key); return i ? this.view(i) : undefined; }

  private merge(items: Item[]): void {
    for (const it of items) {
      // A retrieved revision never overwrites a newer one this process already knows.
      const cur = this.pool.get(it.key);
      if (!cur || it.rev > cur.rev) this.pool.set(it.key, it);
    }
  }

  private async rawQuery(q: string): Promise<string> {
    this.queries++;
    return this.client.query(q, { mode: "hybrid", maxContextTokens: 3000 });
  }

  /** One mind_query for a user message, cached per session by normalized text. */
  async search(message: string): Promise<Item[]> {
    const norm = [...tokenSet(message)].sort().join(" ");
    const hit = this.queryCache.get(norm);
    if (hit) return hit;
    const text = await this.rawQuery(`Daebot learned lessons (daebot-lesson) and skills (daebot-skill) that apply to this request: ${clip(oneLine(message, 400), 300)}`);
    const p = parseRecords(text);
    const found = [...latestByKey(p.lessons), ...latestByKey(p.skills)];
    this.merge(found);
    this.queryCache.set(norm, found);
    return found;
  }

  currentUserModel(): UserModel | undefined { return this.userModel; }

  async loadUserModel(): Promise<UserModel | undefined> {
    if (this.userModelLoaded) return this.userModel;
    this.userModelLoaded = true;
    try {
      const text = await this.rawQuery(`Daebot - User Model - ${this.cfg.user}: stable preferences, do and don't, formats and register for ${this.cfg.user}`);
      this.userModel = latestUserModel(parseRecords(text).userModels, this.cfg.user);
    } catch { /* no model yet is fine */ }
    return this.userModel;
  }

  // ---------- outcome counters ----------
  private delta(key: string): Delta {
    let d = this.deltas.get(key);
    if (!d) { d = ZERO(); this.deltas.set(key, d); }
    return d;
  }
  recordUse(key: string): void { this.delta(key).uses++; }
  recordOutcome(key: string, good: boolean): void {
    const d = this.delta(key);
    if (good) { d.helped++; d.successes++; } else { d.hurt++; d.failures++; }
    // Demotion is one-way: remember the worst status the counters ever implied, later successes do not undo it.
    const base = this.pool.get(key);
    if (base) this.sticky.set(key, worse(this.statusFor(this.view(base)), this.sticky.get(key) ?? "active"));
  }

  /** Status implied by an item's counters. Demotion and retirement are one-way: only a human re-activates. */
  statusFor(v: Item): Status {
    if (v.status === "retired") return "retired";
    const judged = v.helped + v.hurt;
    const ratio = judged ? v.hurt / judged : 0;
    if (v.hurt >= this.cfg.retireHurt && ratio >= this.cfg.retireRatio) return "retired";
    if (v.status === "demoted") return "demoted";
    if (judged >= this.cfg.minUsesToJudge && ratio >= this.cfg.demoteRatio) return "demoted";
    return v.status;
  }

  /** Persist counter changes and any status change as new revisions. Returns how many records were written. */
  async flush(maxWrites = 6): Promise<number> {
    let n = 0;
    for (const [key, d] of [...this.deltas]) {
      if (n >= maxWrites) break;
      const base = this.pool.get(key);
      if (!base) { this.deltas.delete(key); continue; }
      if (!d.uses && !d.helped && !d.hurt) { this.deltas.delete(key); continue; }
      const v = this.view(base);
      const next = { ...v, rev: base.rev + 1, updated: today(this.now()), supersedes: base.mindId } as Item;
      try {
        const id = await this.persist(next);
        next.mindId = id;
        this.pool.set(key, next);
        this.deltas.delete(key);
        n++;
      } catch { /* keep the delta, try on the next flush */ }
    }
    return n;
  }

  private async persist(i: Item): Promise<string | undefined> {
    this.writes++;
    const tags = i.type === "lesson" ? ["daebot-lesson", i.kind] : ["daebot-skill"];
    if (i.supersedes) tags.push(`supersedes:${i.supersedes}`);
    const res = i.type === "lesson"
      ? await this.client.remember({ type: "entry", title: i.title, content: serializeLesson(i), tags, source: "daebot-learning" })
      : await this.client.remember({ type: "document", title: i.title, content: serializeSkill(i), tags, source: "daebot-learning" });
    return savedId(res);
  }

  // ---------- writes ----------
  private similar(text: string, type: Item["type"], extra: Item[] = []): { item: Item; score: number } | undefined {
    const t = tokenSet(text);
    let best: { item: Item; score: number } | undefined;
    for (const it of [...this.pool.values(), ...extra]) {
      if (it.type !== type) continue;
      const s = jaccard(t, tokenSet(itemText(it)));
      if (!best || s > best.score) best = { item: it, score: s };
    }
    return best;
  }

  async upsertLesson(c: { kind: LessonKind; trigger: string; behavior: string; rule: string; evidence: string }): Promise<WriteResult> {
    const title = lessonTitle(c.kind, c.behavior);
    if (!validLessonTitle(title)) return { action: "rejected", why: "title does not fit the Lesson - <Failure|Win|Behavior> - <behavior> grammar" };
    const text = `${c.trigger} ${c.behavior} ${c.rule}`;
    // Dedupe against what we know, then against what MIND returns for the same words.
    let near = this.similar(text, "lesson");
    if (!near || near.score < this.cfg.dedupeJaccard) {
      try {
        const p = parseRecords(await this.rawQuery(`${title}. ${c.trigger}. ${c.rule}`));
        const found = latestByKey(p.lessons);
        this.merge(found);
        const n2 = this.similar(text, "lesson", found);
        if (n2 && (!near || n2.score > near.score)) near = n2;
      } catch { /* dedupe query failed: fall through with what we have (a duplicate is cheaper than a lost lesson) */ }
    }
    const t = this.now();
    if (near && near.score >= this.cfg.dedupeJaccard && near.item.type === "lesson") {
      const old = this.view(near.item) as Lesson;
      const evidence = [...old.evidence.filter((e) => e !== oneLine(c.evidence, 240)), oneLine(c.evidence, 240)].filter(Boolean).slice(-5);
      const next: Lesson = {
        ...old, rev: (this.pool.get(old.key)?.rev ?? old.rev) + 1, evidence, updated: today(t),
        supersedes: this.pool.get(old.key)?.mindId,
        // The new rule text only replaces the old one when it is clearly a refinement (more specific), never silently.
        rule: old.rule,
      };
      const id = await this.persist(next);
      next.mindId = id;
      this.pool.set(next.key, next);
      this.deltas.delete(next.key);
      return { action: "appended", item: next, id };
    }
    const lesson: Lesson = {
      type: "lesson", key: keyFor(`${c.behavior} ${c.rule}`), rev: 1, kind: c.kind, status: "active", title,
      trigger: oneLine(c.trigger, 200), behavior: oneLine(c.behavior, 80), rule: oneLine(c.rule, 300), evidence: [oneLine(c.evidence, 240)].filter(Boolean),
      uses: 0, helped: 0, hurt: 0, created: today(t), updated: today(t),
    };
    const id = await this.persist(lesson);
    lesson.mindId = id;
    this.pool.set(lesson.key, lesson);
    return { action: "created", item: lesson, id };
  }

  async upsertSkill(c: { name: string; description: string; preconditions: string[]; steps: string[]; tools: string[] }): Promise<WriteResult> {
    const title = skillTitle(c.name);
    if (!title) return { action: "rejected", why: "skill needs a name" };
    const name = slug(c.name);
    const t = this.now();
    const sameName = [...this.pool.values()].find((i): i is Skill => i.type === "skill" && i.name === name)
      ?? this.similar(`${name} ${c.description} ${c.tools.join(" ")}`, "skill")?.item as Skill | undefined;
    const near = sameName && (sameName.name === name || jaccard(tokenSet(`${name} ${c.description}`), tokenSet(`${sameName.name} ${sameName.description}`)) >= this.cfg.dedupeJaccard) ? sameName : undefined;
    if (near) {
      const old = this.view(near) as Skill;
      const next: Skill = { ...old, rev: (this.pool.get(old.key)?.rev ?? old.rev) + 1, successes: old.successes + 1, updated: today(t), supersedes: this.pool.get(old.key)?.mindId };
      const id = await this.persist(next);
      next.mindId = id;
      this.pool.set(next.key, next);
      this.deltas.delete(next.key);
      return { action: "appended", item: next, id };
    }
    const skill: Skill = {
      type: "skill", key: keyFor(`${name} ${c.steps.join(" ")}`), rev: 1, status: "active", name, title,
      description: oneLine(c.description, 200), preconditions: c.preconditions.map((p) => oneLine(p, 160)), steps: c.steps.map((s) => oneLine(s, 200)),
      tools: c.tools, successes: 1, failures: 0, uses: 0, helped: 0, hurt: 0, created: today(t), updated: today(t),
    };
    const id = await this.persist(skill);
    skill.mindId = id;
    this.pool.set(skill.key, skill);
    return { action: "created", item: skill, id };
  }

  /** Merge new preferences into the one user-model document for this user. Same area replaces the older statement. */
  async updateUserModel(newPrefs: { area: string; statement: string }[]): Promise<{ written: boolean; model?: UserModel; why?: string }> {
    const clean = newPrefs
      .map((p) => ({ area: oneLine(p.area, 40).toLowerCase(), statement: oneLine(p.statement, 220) }))
      .filter((p) => p.area && p.statement && !contentProblem(`${p.area} ${p.statement}`, { clientNames: this.o.clientNames }));
    if (!clean.length) return { written: false, why: "no acceptable preferences" };
    const cur = await this.loadUserModel();
    const prefs: UserPref[] = [...(cur?.prefs ?? [])];
    let changed = false;
    for (const p of clean) {
      const i = prefs.findIndex((x) => x.area === p.area || jaccard(tokenSet(x.statement), tokenSet(p.statement)) >= 0.6);
      if (i >= 0) {
        if (prefs[i].statement !== p.statement) { prefs[i] = { area: p.area, statement: p.statement, since: today(this.now()) }; changed = true; }
      } else { prefs.push({ area: p.area, statement: p.statement, since: today(this.now()) }); changed = true; }
    }
    if (!changed) return { written: false, why: "already known" };
    const model: UserModel = { user: this.cfg.user, rev: (cur?.rev ?? 0) + 1, prefs: prefs.slice(-25), updated: today(this.now()) };
    this.writes++;
    const res = await this.client.remember({
      type: "document", title: `Daebot - User Model - ${this.cfg.user}`, content: serializeUserModel(model), tags: ["daebot-user-model"], source: "daebot-learning",
    });
    model.mindId = savedId(res);
    this.userModel = model;
    this.userModelLoaded = true;
    return { written: true, model };
  }
}
