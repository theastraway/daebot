// MIND is the store, so every record is plain text a human can read in MIND and a parser can read back out of
// retrieved chunks. Records are APPEND-ONLY revisions: the highest `rev` per key wins. This is the only write
// primitive we rely on (POST /entries, POST /documents); we do not assume an update/patch endpoint.
//
// Retrieval returns chunks like "# <title>\n\n## Original Entry\n<body>\n\n## AI Analysis\n..." (verified against
// the live graph 2026-10-15), so the block may appear twice in a chunk and ids are NOT in the text. Parsing
// therefore takes every [daebot-...] block, keys it, and keeps the highest rev.
import { oneLine } from "./text.ts";
import type { Item, Lesson, LessonKind, Skill, Status, UserModel, UserPref } from "./types.ts";

const SEP = " || ";

function kv(lines: string[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i < 1) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    const a = m.get(k) ?? [];
    a.push(v);
    m.set(k, a);
  }
  return m;
}
const one = (m: Map<string, string[]>, k: string) => m.get(k)?.[0] ?? "";
const num = (m: Map<string, string[]>, k: string) => { const n = Number(one(m, k)); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0; };
const list = (m: Map<string, string[]>, k: string) => one(m, k).split(SEP).map((s) => s.trim()).filter(Boolean);
const status = (s: string): Status => (s === "demoted" || s === "retired" ? s : "active");

export function serializeLesson(l: Lesson): string {
  return [
    "[daebot-lesson v1]",
    `key: ${l.key}`, `rev: ${l.rev}`, `kind: ${l.kind}`, `status: ${l.status}`,
    `trigger: ${oneLine(l.trigger, 200)}`, `behavior: ${oneLine(l.behavior, 80)}`, `rule: ${oneLine(l.rule, 300)}`,
    `evidence: ${l.evidence.map((e) => oneLine(e, 240).replace(/\|\|/g, "|")).join(SEP)}`,
    `uses: ${l.uses}`, `helped: ${l.helped}`, `hurt: ${l.hurt}`,
    `created: ${l.created}`, `updated: ${l.updated}`,
    ...(l.supersedes ? [`supersedes: ${l.supersedes}`] : []),
    "[/daebot-lesson]",
    "",
    `Daebot learned this about its own behavior. It never overrides the kernel. When it keeps causing failures it is demoted.`,
  ].join("\n");
}

export function serializeSkill(s: Skill): string {
  return [
    "[daebot-skill v1]",
    `key: ${s.key}`, `rev: ${s.rev}`, `status: ${s.status}`, `name: ${s.name}`,
    `description: ${oneLine(s.description, 200)}`,
    `preconditions: ${s.preconditions.map((p) => oneLine(p, 160).replace(/\|\|/g, "|")).join(SEP)}`,
    `tools: ${s.tools.join(", ")}`,
    ...s.steps.map((st, i) => `step${i + 1}: ${oneLine(st, 200)}`),
    `successes: ${s.successes}`, `failures: ${s.failures}`,
    `uses: ${s.uses}`, `helped: ${s.helped}`, `hurt: ${s.hurt}`,
    `created: ${s.created}`, `updated: ${s.updated}`,
    ...(s.supersedes ? [`supersedes: ${s.supersedes}`] : []),
    "[/daebot-skill]",
    "",
    `Reusable procedure Daebot extracted from a task that worked. Check the preconditions before following the steps.`,
  ].join("\n");
}

export function serializeUserModel(u: UserModel): string {
  return [
    "[daebot-user-model v1]",
    `user: ${u.user}`, `rev: ${u.rev}`, `updated: ${u.updated}`,
    ...u.prefs.map((p) => `pref: ${oneLine(p.area, 40).replace(/\|/g, "/")} | ${oneLine(p.statement, 220).replace(/\|/g, "/")} | ${p.since}`),
    "[/daebot-user-model]",
  ].join("\n");
}

const BLOCK = /\[daebot-(lesson|skill|user-model) v1\]\n([\s\S]*?)\n\[\/daebot-\1\]/g;

export interface Parsed { lessons: Lesson[]; skills: Skill[]; userModels: UserModel[] }

// Live MIND returns chunks as JSON lines: {"reference_id": "1", "content": "# Title\n\n## Original Entry\n..."}, so the
// record markers arrive with escaped newlines. Decode every "content" string and parse raw text plus decoded text.
const CONTENT_STR = /"content"\s*:\s*("(?:[^"\\]|\\[\s\S])*")/g;
function haystack(text: string): string {
  const parts = [text];
  CONTENT_STR.lastIndex = 0;
  for (let m = CONTENT_STR.exec(text); m; m = CONTENT_STR.exec(text)) {
    try { parts.push(JSON.parse(m[1]) as string); } catch { /* not a JSON string */ }
  }
  return parts.join("\n");
}

export function parseRecords(text: string): Parsed {
  const out: Parsed = { lessons: [], skills: [], userModels: [] };
  if (!text) return out;
  text = haystack(text);
  BLOCK.lastIndex = 0;
  for (let m = BLOCK.exec(text); m; m = BLOCK.exec(text)) {
    const type = m[1];
    const lines = m[2].split("\n");
    const f = kv(lines);
    if (type === "lesson") {
      const key = one(f, "key");
      const rule = one(f, "rule");
      if (!/^[0-9a-f]{6}$/.test(key) || !rule) continue;
      const kind = (["failure", "win", "behavior"].includes(one(f, "kind")) ? one(f, "kind") : "behavior") as LessonKind;
      const behavior = one(f, "behavior");
      out.lessons.push({
        type: "lesson", key, rev: Math.max(1, num(f, "rev")), kind, status: status(one(f, "status")),
        title: `Lesson - ${kind === "failure" ? "Failure" : kind === "win" ? "Win" : "Behavior"} - ${behavior}`,
        trigger: one(f, "trigger"), behavior, rule, evidence: list(f, "evidence"),
        uses: num(f, "uses"), helped: num(f, "helped"), hurt: num(f, "hurt"),
        created: one(f, "created"), updated: one(f, "updated"), supersedes: one(f, "supersedes") || undefined,
      });
    } else if (type === "skill") {
      const key = one(f, "key");
      const name = one(f, "name");
      if (!/^[0-9a-f]{6}$/.test(key) || !name) continue;
      const steps = lines.map((l) => /^step(\d+):\s*(.*)$/.exec(l)).filter((x): x is RegExpExecArray => !!x).sort((a, b) => Number(a[1]) - Number(b[1])).map((x) => x[2]);
      if (!steps.length) continue;
      out.skills.push({
        type: "skill", key, rev: Math.max(1, num(f, "rev")), status: status(one(f, "status")), name, title: `Skill - ${name}`,
        description: one(f, "description"), preconditions: list(f, "preconditions"),
        steps, tools: one(f, "tools").split(",").map((s) => s.trim()).filter(Boolean),
        successes: num(f, "successes"), failures: num(f, "failures"),
        uses: num(f, "uses"), helped: num(f, "helped"), hurt: num(f, "hurt"),
        created: one(f, "created"), updated: one(f, "updated"), supersedes: one(f, "supersedes") || undefined,
      });
    } else {
      const prefs: UserPref[] = (f.get("pref") ?? []).map((p) => p.split("|").map((x) => x.trim())).filter((a) => a.length >= 2 && a[0] && a[1])
        .map((a) => ({ area: a[0], statement: a[1], since: a[2] ?? "" }));
      out.userModels.push({ user: one(f, "user"), rev: Math.max(1, num(f, "rev")), prefs, updated: one(f, "updated") });
    }
  }
  return out;
}

/** Keep only the highest revision per key. Ties keep the first seen. */
export function latestByKey<T extends { key: string; rev: number }>(items: T[]): T[] {
  const best = new Map<string, T>();
  for (const it of items) {
    const cur = best.get(it.key);
    if (!cur || it.rev > cur.rev) best.set(it.key, it);
  }
  return [...best.values()];
}

export function latestUserModel(models: UserModel[], user: string): UserModel | undefined {
  return models.filter((m) => m.user === user).sort((a, b) => b.rev - a.rev)[0];
}

export function citeId(i: Item): string { return `${i.type === "lesson" ? "L" : "S"}-${i.key}`; }
