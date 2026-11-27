// The MIND protocol, as code: how an agent starts from a blank knowledge graph, organizes it, keeps it current and reasons across all of
// it. Every Daebot bot has its own MIND (a graph workspace inside the user's account, reached with the MAIN key plus X-MIND-Bot: <slug>,
// see SPEC section 10); the main Daebot has the account's MIND. Both follow the same protocol. MIND_PROTOCOL_PROMPT is the prose; the
// mind_kg tool is the mechanics: status (how built-out the graph is), bootstrap (the charter, the first map and the open questions of a
// blank graph), map (the index of everything, refiled), audit (what breaks the conventions) and reason (a multi-angle read across the whole
// dataset for one question). It always works on the session's HOME MIND: a bot's own, or the main one in a main session.
import type { MindClient, Tool, ToolResult } from "../types.ts";
import { done, failed } from "../tools/contract.ts";
import { MIND_RECALL_HEADER, withOriginTag } from "./origin.ts";
import { screenUntrustedText, withScreenNotice } from "../tools/text-screen.ts";

/** The kinds of knowledge a MIND holds. Every item carries exactly one kind:<kind> tag. */
export const KG_KINDS = ["fact", "decision", "lesson", "procedure", "person", "org", "project", "source", "metric", "event", "question", "index"] as const;
export type KgKind = (typeof KG_KINDS)[number];
export const CHARTER_PREFIX = "MIND Charter - ";
export const MAP_PREFIX = "MIND Map - ";
export const KG_TAG = "daebot-kg";

/** The protocol every agent works by (bots always; the main Daebot when MIND is in focus). Short enough for every bot prompt. */
export const MIND_PROTOCOL_PROMPT = [
  "## MIND protocol (how you build and use your knowledge graph)",
  "Your MIND is your long-term memory and the only thing the next session, helper or bot can reason over. Treat it as a dataset you curate, not a notebook.",
  "1. Orient: at the start of real work, read the charter and the map (mind_kg status). On a blank or near-empty MIND, bootstrap first (mind_kg bootstrap with the purpose, scope, topics, sources and open questions): the charter says what this MIND holds and how it is organized; the map is the index.",
  "2. Capture what is worth reasoning over later: decisions with their why, facts with their source, lessons (what failed and the rule that prevents it), procedures that worked, people, orgs, projects, metrics with dates, and open questions. Not chit-chat, not secrets, not what a tool can fetch fresh in a second.",
  `3. Shape every write the same way (mind_remember): one subject per item; title "<Subject>: <the fact in a few words>" for entries and "<Kind> - <Subject> - YYYY-MM-DD" for documents; tags: exactly one kind:<${KG_KINDS.join("|")}>, one or two topic:<slug> from the charter, entity:<name> for every person, org, product or project it is about; name entities in full in the text, with dates and numbers exact; say where it came from (origin, and the URL or file for web and documents). Entries for atomic facts; documents for long material (a spec, a report, a transcript summary).`,
  "4. Update, never duplicate: search (mind_remember search, mind_query) before you write. If it exists and changed, write the new version with supersedes and a reason; if two items conflict, keep both, name the conflict and ask. A new topic gets added to the charter's taxonomy when you first use it.",
  "5. Reason across the whole dataset: for a question that needs more than one fact, use mind_kg reason (several angles at once: the subject, its entities, its history, the evidence against), then answer from what came back with MIND receipts; a negative claim needs two differently worded queries. Use the map to find which topics and entities to ask about.",
  "6. Maintain: after a burst of writes or once a week, refile the map (mind_kg map) and fix what mind_kg audit finds (untagged items, duplicates, unanswered questions). A MIND the next agent cannot navigate is a MIND that does not exist.",
].join("\n");

const one = (s: unknown, n: number): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/** The convention tags for one item: one kind, topics, entities (normalised, deduplicated). */
export function kgTags(o: { kind: KgKind; topics?: string[]; entities?: string[]; extra?: string[] }): string[] {
  const out = [`kind:${o.kind}`, ...(o.topics ?? []).map((t) => `topic:${slug(t)}`).filter((t) => t !== "topic:"), ...(o.entities ?? []).map((e) => `entity:${one(e, 60)}`).filter((t) => t !== "entity:"), ...(o.extra ?? [])];
  return [...new Set(out)];
}

export interface KgItem { id?: string; title: string; tags: string[]; type: "entry" | "document"; at?: string }

function rowsOf(text: string, keys: string[]): Record<string, unknown>[] {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return []; }
  if (Array.isArray(j)) return j.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
  const o = (j ?? {}) as Record<string, unknown>;
  for (const k of keys) { const v = o[k]; if (Array.isArray(v)) return v.filter((x) => x && typeof x === "object") as Record<string, unknown>[]; }
  const data = o.data as Record<string, unknown> | undefined;
  if (data && typeof data === "object") for (const k of keys) { const v = data[k]; if (Array.isArray(v)) return v.filter((x) => x && typeof x === "object") as Record<string, unknown>[]; }
  return [];
}
const itemOf = (r: Record<string, unknown>, type: "entry" | "document"): KgItem => ({
  ...(r.id !== undefined || r._id !== undefined ? { id: String(r.id ?? r._id) } : {}),
  title: one(r.title ?? r.name ?? (typeof r.content === "string" ? r.content.slice(0, 80) : ""), 160) || "(untitled)",
  tags: Array.isArray(r.tags) ? r.tags.map((t) => one(t, 80)).filter(Boolean) : [],
  type,
  ...(typeof (r.updated_at ?? r.created_at) === "string" ? { at: String(r.updated_at ?? r.created_at) } : {}),
});

/** Reads up to `pages` pages of documents and one list of entries from a MIND. Bounded: never the whole account. */
export async function scanMind(c: MindClient, o: { pages?: number; pageSize?: number; entryLimit?: number; signal?: AbortSignal } = {}): Promise<{ items: KgItem[]; capped: boolean; errors: string[] }> {
  const size = o.pageSize ?? 50, pages = o.pages ?? 4;
  const items: KgItem[] = [];
  const errors: string[] = [];
  let capped = false;
  for (let p = 1; p <= pages; p++) {
    let text: string;
    try { text = await c.call("remember", { action: "list", type: "document", page: p, limit: size }, o.signal); } catch (e) { errors.push(`documents: ${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 120)}`); break; }
    const rows = rowsOf(text, ["documents", "items", "results"]);
    items.push(...rows.map((r) => itemOf(r, "document")));
    if (rows.length < size) break;
    if (p === pages) capped = true;
  }
  const limit = o.entryLimit ?? 200;
  try {
    const text = await c.call("remember", { action: "list", type: "entry", limit }, o.signal);
    const rows = rowsOf(text, ["entries", "items", "results"]);
    items.push(...rows.map((r) => itemOf(r, "entry")));
    if (rows.length >= limit) capped = true;
  } catch (e) { errors.push(`entries: ${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 120)}`); }
  return { items, capped, errors };
}

export interface KgStats {
  total: number; documents: number; entries: number;
  kinds: Record<string, number>; topics: [string, number][]; entities: [string, number][];
  untagged: KgItem[]; noKind: KgItem[]; duplicates: [string, number][]; superseded: number;
  charter?: KgItem; map?: KgItem; questions: KgItem[];
  stage: "blank" | "seeded" | "growing" | "organized";
}

const tagVal = (tags: string[], prefix: string): string[] => tags.filter((t) => t.toLowerCase().startsWith(prefix)).map((t) => t.slice(prefix.length));

/** Counts and health of a MIND from its listed items. Pure. */
export function kgStats(items: readonly KgItem[]): KgStats {
  const kinds: Record<string, number> = {};
  const topics = new Map<string, number>(), entities = new Map<string, number>(), titles = new Map<string, number>();
  const untagged: KgItem[] = [], noKind: KgItem[] = [], questions: KgItem[] = [];
  let superseded = 0;
  let charter: KgItem | undefined, map: KgItem | undefined;
  for (const it of items) {
    if (it.title.startsWith(CHARTER_PREFIX) && !charter) charter = it;
    if (it.title.startsWith(MAP_PREFIX) && (!map || String(it.at ?? "") > String(map.at ?? ""))) map = it;
    const content = it.tags.filter((t) => !t.startsWith("origin:"));
    if (!content.length) untagged.push(it);
    const k = tagVal(it.tags, "kind:");
    if (k.length) kinds[k[0]] = (kinds[k[0]] ?? 0) + 1; else noKind.push(it);
    if (k[0] === "question") questions.push(it);
    for (const t of tagVal(it.tags, "topic:")) topics.set(t, (topics.get(t) ?? 0) + 1);
    for (const e of tagVal(it.tags, "entity:")) entities.set(e, (entities.get(e) ?? 0) + 1);
    if (it.tags.some((t) => t === "superseded" || t.startsWith("superseded"))) superseded++;
    const key = it.title.toLowerCase();
    titles.set(key, (titles.get(key) ?? 0) + 1);
  }
  const sorted = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const duplicates = sorted(titles).filter(([, n]) => n > 1).map(([t, n]) => [items.find((i) => i.title.toLowerCase() === t)!.title, n] as [string, number]);
  const real = items.filter((i) => i !== charter && !i.title.startsWith(MAP_PREFIX)).length;
  const kindShare = items.length ? (items.length - noKind.length) / items.length : 0;
  const stage: KgStats["stage"] = real === 0 && !charter ? "blank" : real < 10 ? "seeded" : charter && map && kindShare >= 0.8 ? "organized" : "growing";
  return {
    total: items.length, documents: items.filter((i) => i.type === "document").length, entries: items.filter((i) => i.type === "entry").length,
    kinds, topics: sorted(topics), entities: sorted(entities), untagged, noKind, duplicates, superseded, charter, map, questions, stage,
  };
}

/** The next steps for a MIND at its stage. Pure. */
export function nextSteps(s: KgStats): string[] {
  const out: string[] = [];
  if (!s.charter) out.push("No charter: run mind_kg bootstrap with the purpose, scope, topics, sources and open questions.");
  if (s.stage === "blank") return out.length ? out : ["Blank: bootstrap, then capture the first decisions, facts and sources as you work."];
  if (!s.map) out.push("No map: run mind_kg map so the next session can navigate this MIND.");
  if (s.noKind.length) out.push(`${s.noKind.length} item(s) without a kind tag: re-file the important ones with kind:, topic: and entity: tags (mind_kg audit lists them).`);
  if (s.duplicates.length) out.push(`${s.duplicates.length} duplicated title(s): keep one, supersede the rest with a reason.`);
  if (s.questions.length) out.push(`${s.questions.length} open question(s): answer them as you learn, then supersede the question with the answer.`);
  if (!out.length) out.push("Healthy: keep the conventions, refile the map after a burst of writes.");
  return out;
}

/** The charter document of a MIND: what it holds, for whom, how it is organized. Pure. */
export function charterText(o: { name: string; purpose: string; scope?: string; topics: string[]; sources?: string[]; owner?: string; day: string }): string {
  return [
    `# ${CHARTER_PREFIX}${o.name}`,
    "",
    `Purpose: ${o.purpose}`,
    `Scope: ${o.scope || "What this agent learns doing its job: the decisions, facts, sources, lessons and procedures it needs to do the job better next time. Not chit-chat, not secrets."}`,
    ...(o.owner ? [`Owner: ${o.owner}. The owner's instructions win over this charter.`] : []),
    "",
    "## Taxonomy",
    `Kinds (exactly one kind:<kind> tag per item): ${KG_KINDS.join(", ")}.`,
    `Topics (topic:<slug>, one or two per item): ${o.topics.length ? o.topics.map(slug).join(", ") : "(add them as they appear)"}.`,
    "Entities: entity:<full name> for every person, org, product or project an item is about.",
    "",
    "## Conventions",
    '- Entries hold one subject each, titled "<Subject>: <the fact in a few words>". Documents hold long material, titled "<Kind> - <Subject> - YYYY-MM-DD".',
    "- Every item says where it came from (origin tag; the URL or file for web and documents) and carries exact dates and numbers.",
    "- Search before writing. A changed fact is a new item that supersedes the old one, with a reason. Conflicts are kept, named and asked about.",
    `- The map (${MAP_PREFIX}…) is the index: refile it after a burst of writes or weekly.`,
    "",
    "## Sources",
    ...(o.sources?.length ? o.sources.map((s) => `- ${s}`) : ["- (none named yet)"]),
    "",
    `Bootstrapped by Daebot on ${o.day}.`,
  ].join("\n");
}

/** The map (index) of a MIND: counts, the taxonomy in use, key documents, open questions, what to fix. Pure; never item contents. */
export function mapText(name: string, s: KgStats, items: readonly KgItem[], o: { day: string; capped?: boolean }): string {
  const docs = items.filter((i) => i.type === "document" && !i.title.startsWith(MAP_PREFIX)).slice(0, 25);
  return [
    `# ${MAP_PREFIX}${name}`,
    "",
    `${s.total} items (${s.documents} documents, ${s.entries} entries)${o.capped ? ", first pages only" : ""}. Stage: ${s.stage}. Refiled ${o.day}.`,
    "",
    "## By kind",
    ...(Object.keys(s.kinds).length ? Object.entries(s.kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${k}: ${n}`) : ["- (no kind tags yet)"]),
    "",
    "## Topics",
    ...(s.topics.length ? s.topics.slice(0, 30).map(([t, n]) => `- ${t} (${n})`) : ["- (none yet)"]),
    "",
    "## Entities",
    ...(s.entities.length ? s.entities.slice(0, 40).map(([e, n]) => `- ${e} (${n})`) : ["- (none yet)"]),
    "",
    "## Key documents",
    ...(docs.length ? docs.map((d) => `- ${d.title}`) : ["- (none yet)"]),
    "",
    "## Open questions",
    ...(s.questions.length ? s.questions.slice(0, 15).map((q) => `- ${q.title}`) : ["- (none)"]),
    "",
    "## To fix",
    ...nextSteps(s).map((x) => `- ${x}`),
  ].join("\n");
}

/** The angles of a dataset-wide read for one question: the question itself, its entities and topics from the map, its history, and the evidence against. Pure. */
export function reasonAngles(question: string, s: KgStats, max = 4): { label: string; query: string }[] {
  const q = one(question, 600);
  const words = new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  const hit = (name: string) => name.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length > 3 && words.has(w));
  const ents = s.entities.map(([e]) => e).filter(hit).slice(0, 3);
  const tops = s.topics.map(([t]) => t).filter((t) => hit(t.replace(/-/g, " "))).slice(0, 2);
  const out = [{ label: "the question", query: q }];
  if (ents.length || tops.length) out.push({ label: "its entities and topics", query: `Everything known about ${[...ents, ...tops.map((t) => `the ${t.replace(/-/g, " ")} topic`)].join(", ")}: facts, decisions, metrics and relationships relevant to: ${q}` });
  out.push({ label: "history and decisions", query: `What was decided, tried, learned or changed over time about this, with dates and reasons: ${q}` });
  out.push({ label: "evidence against", query: `What contradicts, complicates or argues against the obvious answer to: ${q}. Include failures, risks and superseded facts.` });
  return out.slice(0, max);
}

export interface KgToolOptions {
  /** The session's home MIND (a bot's own, or the main one). */
  mind: () => MindClient | undefined;
  /** Name of this MIND for titles ("Scout" for a bot, the user's name or "Daebot" for main), and the purpose to bootstrap with by default. */
  identity: () => { name: string; purpose?: string; owner?: string };
  now?: () => number;
  queryMs?: number;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([p, new Promise<undefined>((r) => { t = setTimeout(() => r(undefined), ms); })]); } catch { return undefined; } finally { if (t) clearTimeout(t); }
}
const strList = (v: unknown, n: number, len = 80): string[] => (Array.isArray(v) ? v.map((x) => one(x, len)).filter(Boolean).slice(0, n) : []);

export const KG_ACTIONS = ["status", "bootstrap", "map", "audit", "reason"] as const;

export function createKgTool(o: KgToolOptions): Tool {
  const now = o.now ?? Date.now;
  return {
    class: "read",
    receipt: "mind",
    classFor: (a) => (a.action === "bootstrap" || (a.action === "map" && a.save !== false) ? "write" : "read"),
    spec: {
      name: "mind_kg",
      description:
        "Build and use your MIND as a knowledge graph (the MIND protocol). It works on your home MIND (a bot's own MIND, or the account's in the main chat). " +
        "status: how built-out it is (blank, seeded, growing, organized), the charter and map, counts by kind, topic and entity, and the next steps. " +
        "bootstrap: start a blank MIND: files the charter (purpose, scope, taxonomy, conventions, sources), the first map and the open questions; does nothing if a charter exists. " +
        "map: refile the index of everything (counts, topics, entities, key documents, open questions, what to fix); save:false only shows it. audit: items that break the conventions. " +
        "reason: answer a question across the whole dataset: several MIND queries from different angles (the question, its entities and topics, history and decisions, evidence against) at once.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: [...KG_ACTIONS], description: "default status" },
          purpose: { type: "string", description: "bootstrap: what this MIND is for (default: the agent's purpose)" },
          scope: { type: "string", description: "bootstrap: what it holds and what it does not" },
          topics: { type: "array", items: { type: "string" }, description: "bootstrap: the starting topics (slugs), 3-12" },
          sources: { type: "array", items: { type: "string" }, description: "bootstrap: where its knowledge comes from (connectors, sites, documents, people)" },
          questions: { type: "array", items: { type: "string" }, description: "bootstrap: open questions it should answer over time (up to 5)" },
          save: { type: "boolean", description: "map: file it in MIND (default true)" },
          question: { type: "string", description: "reason: the question to answer across the whole dataset" },
        },
        additionalProperties: false,
      },
    },
    async run(args, ctx): Promise<ToolResult> {
      const action = (one(args.action, 20) || "status") as (typeof KG_ACTIONS)[number];
      if (!KG_ACTIONS.includes(action)) return failed(`unknown action "${action}"`, { retry: "pointless", next: `use one of: ${KG_ACTIONS.join(", ")}` });
      const c = o.mind();
      if (!c) return failed("MIND is not connected in this session", { retry: "pointless" });
      const who = o.identity();
      const day = new Date(now()).toISOString().slice(0, 10);
      const scan = await scanMind(c, { signal: ctx.signal });
      if (scan.errors.length && !scan.items.length && action !== "reason") return failed(`could not read MIND (${scan.errors.join("; ")})`, { retry: "safe", stop: "after one retry, tell the user MIND is unreachable" });
      const s = kgStats(scan.items);
      const meta = { stage: s.stage, items: s.total, ...(scan.capped ? { capped: true } : {}) };
      const write = async (title: string, content: string, kind: KgKind, extra: string[] = []): Promise<string> =>
        c.remember({ type: "document", title, content, tags: withOriginTag([KG_TAG, ...kgTags({ kind, extra })], "tool"), source: "daebot-mind-kg", origin: "tool" }, ctx.signal);

      if (action === "status") {
        const lines = [
          `MIND of ${who.name}: ${s.total} items (${s.documents} documents, ${s.entries} entries)${scan.capped ? ", first pages only" : ""}. Stage: ${s.stage}.`,
          `Charter: ${s.charter ? s.charter.title : "none"} · Map: ${s.map ? s.map.title : "none"}`,
          `Kinds: ${Object.entries(s.kinds).map(([k, n]) => `${k} ${n}`).join(", ") || "none tagged"}`,
          `Top topics: ${s.topics.slice(0, 10).map(([t, n]) => `${t} ${n}`).join(", ") || "none"}`,
          `Top entities: ${s.entities.slice(0, 10).map(([e, n]) => `${e} ${n}`).join(", ") || "none"}`,
          "Next:", ...nextSteps(s).map((x) => `- ${x}`),
          ...(scan.errors.length ? [`Could not read: ${scan.errors.join("; ")}`] : []),
        ];
        return done(`${who.name}'s MIND is ${s.stage} (${s.total} items)`, { output: lines.join("\n"), meta });
      }
      if (action === "audit") {
        const lines = [
          `Untagged (${s.untagged.length}):`, ...(s.untagged.slice(0, 15).map((i) => `- ${i.title}${i.id ? ` [${i.id}]` : ""}`)),
          `No kind tag (${s.noKind.length}):`, ...(s.noKind.slice(0, 15).map((i) => `- ${i.title}${i.id ? ` [${i.id}]` : ""}`)),
          `Duplicated titles (${s.duplicates.length}):`, ...s.duplicates.slice(0, 15).map(([t, n]) => `- ${t} (${n})`),
          `Open questions (${s.questions.length}):`, ...s.questions.slice(0, 15).map((q) => `- ${q.title}`),
          "Fix: re-file important items with mind_remember (supersedes + reason) using kind:, topic: and entity: tags; keep one of each duplicate.",
        ];
        const issues = s.noKind.length + s.duplicates.length;
        return done(issues ? `${issues} convention issue(s) in ${who.name}'s MIND` : `${who.name}'s MIND keeps the conventions`, { output: lines.join("\n"), meta });
      }
      if (action === "bootstrap") {
        if (s.charter) return done(`${who.name}'s MIND already has a charter; nothing written`, { output: [`Charter: ${s.charter.title}`, `Stage: ${s.stage}`, ...nextSteps(s).map((x) => `- ${x}`)].join("\n"), meta });
        const purpose = one(args.purpose, 600) || who.purpose || "";
        if (purpose.length < 10) return failed("bootstrap needs the purpose of this MIND (a sentence: what the agent does and for whom)", { retry: "pointless" });
        const topics = strList(args.topics, 12, 40);
        const sources = strList(args.sources, 12, 160);
        const questions = strList(args.questions, 5, 240);
        const written: string[] = [];
        try {
          await write(`${CHARTER_PREFIX}${who.name}`, charterText({ name: who.name, purpose, scope: one(args.scope, 600), topics, sources, owner: who.owner, day }), "index", ["mind-charter"]);
          written.push("charter");
          for (const q of questions) {
            await c.remember({ type: "entry", title: `Open question: ${q.slice(0, 120)}`, content: `${q}\n\nOpen since ${day}. When answered, write the answer with supersedes pointing at this question.`, tags: withOriginTag([KG_TAG, ...kgTags({ kind: "question", topics: topics.slice(0, 1) })], "tool"), source: "daebot-mind-kg", origin: "tool" }, ctx.signal);
            written.push("question");
          }
          const seeded: KgItem[] = [{ title: `${CHARTER_PREFIX}${who.name}`, tags: ["kind:index"], type: "document" }, ...questions.map((q) => ({ title: `Open question: ${q.slice(0, 120)}`, tags: ["kind:question", ...topics.slice(0, 1).map((t) => `topic:${slug(t)}`)], type: "entry" as const }))];
          const st2 = kgStats(seeded);
          await write(`${MAP_PREFIX}${who.name} - ${day}`, mapText(who.name, st2, seeded, { day }), "index", ["mind-map"]);
          written.push("map");
        } catch (e) {
          return failed(`MIND stopped the bootstrap after ${written.length} write(s): ${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 160)}`, { retry: "safe", next: "run mind_kg bootstrap again; a charter that landed makes it a no-op, so finish with mind_kg map" });
        }
        return done(`bootstrapped ${who.name}'s MIND: charter, ${questions.length} open question(s), map`, {
          output: [`Filed: ${CHARTER_PREFIX}${who.name}; ${MAP_PREFIX}${who.name} - ${day}; ${questions.length} open question(s).`, `Topics: ${topics.map(slug).join(", ") || "(none yet)"}`, "Next: capture as you work (decisions, facts with sources, lessons, procedures), with kind:, topic: and entity: tags."].join("\n"),
          meta: { ...meta, written: written.length },
        });
      }
      if (action === "map") {
        const text = mapText(who.name, s, scan.items, { day, capped: scan.capped });
        if (args.save === false) return done(`map of ${who.name}'s MIND (${s.total} items, not filed)`, { output: text, meta });
        try {
          await write(`${MAP_PREFIX}${who.name} - ${day}`, text, "index", ["mind-map", ...(s.map ? [`supersedes:${s.map.id ?? s.map.title}`.slice(0, 120)] : [])]);
        } catch (e) { return failed(`MIND did not take the map: ${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 160)}`, { retry: "safe", output: text }); }
        return done(`refiled the map of ${who.name}'s MIND (${s.total} items)`, { output: text, meta });
      }
      // reason: several angles at once, each screened and labelled.
      const question = one(args.question, 600);
      if (question.length < 8) return failed("reason needs the question", { retry: "pointless" });
      const angles = reasonAngles(question, s);
      const answers = await Promise.all(angles.map((a) => withTimeout(c.query(a.query, { maxContextTokens: 1500, signal: ctx.signal }), o.queryMs ?? 20_000)));
      let withheld = 0, got = 0;
      const blocks = angles.map((a, i) => {
        const t = String(answers[i] ?? "").trim();
        if (!t) return `### ${a.label}\n(nothing came back)`;
        got++;
        const sc = screenUntrustedText(t.length > 3500 ? `${t.slice(0, 3500)}\n… (cut)` : t);
        withheld += sc.withheld;
        return `### ${a.label}\n${withScreenNotice(sc)}`;
      });
      if (!got) return failed("MIND returned nothing for any angle", { retry: "safe", next: "rephrase, or say MIND holds nothing on this after a second, differently worded query" });
      return done(`read ${who.name}'s MIND from ${got} of ${angles.length} angle(s)`, {
        output: [MIND_RECALL_HEADER, `Question: ${question}`, `Map used: ${s.entities.length} entities, ${s.topics.length} topics known.`, "", ...blocks, "", "Answer from these with MIND receipts; say which angle each claim came from, and name any conflict between angles."].join("\n\n"),
        meta: { ...meta, angles: angles.length, answered: got, ...(withheld ? { withheld } : {}) },
      });
    },
  };
}
