// session_recall: the raw turns of this chat after compaction has replaced them with a summary.
// Read-only. Scoped to this session unless scope is "all", which stays inside the same owner.
import type { HistoryEvent, RecallMsg, SessionState, Tool } from "../types.ts";
import type { BlobStore } from "../recall/blobs.ts";
import { corpusOf, parseSpan } from "../recall/archive.ts";
import { redactSecrets } from "../learn/guard.ts";
import { screenUntrustedText, withScreenNotice } from "./text-screen.ts";
import { fail, ok } from "./util.ts";

export interface RecallSource {
  id: string;
  owner: string;
  updatedAt: number;
  state: SessionState;
  history: HistoryEvent[];
}

export interface SessionRecallDeps {
  owner: string;
  blobs: BlobStore;
  load(id: string): RecallSource | undefined;
  list(): { id: string; owner: string; updatedAt: number }[];
}

const MAX_PATTERN = 200;
const MAX_SESSIONS = 40;
const MAX_SCAN_CHARS = 1_500_000;
const MAX_MATCHES = 500;
const TIME_BUDGET_MS = 250;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DEFAULT_PAGE = 8000;
const DEFAULT_RECENT = 5;
const MAX_RECENT = 20;

type Row = RecallMsg & { sessionId: string };

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function optInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Math.floor(Number(v));
  return undefined;
}

function truthy(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

/** A group that itself contains a quantifier, then another quantifier, is a ReDoS shape. Reject it instead of running it. */
function tooExpensive(pattern: string): boolean {
  return /\([^)]*(?:[+*]|\{\d+,?\d*\})[^)]*\)\s*(?:[+*{])/.test(pattern);
}

function where(turn: number): string {
  return turn > 0 ? `turn ${turn}` : "summary";
}

function present(row: RecallMsg): { text: string; withheld: number } {
  const redacted = redactSecrets(row.text);
  const untrusted = row.role === "tool" || /web/i.test(row.name ?? "");
  if (!untrusted) return { text: redacted, withheld: 0 };
  const screened = screenUntrustedText(redacted);
  return { text: withScreenNotice(screened), withheld: screened.withheld };
}

function snippetAt(text: string, index: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + 120);
  let s = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) s = `…${s}`;
  if (end < text.length) s = `${s}…`;
  return s.slice(0, 220);
}

interface Finder { find(text: string): { index: number } | undefined }

function compileQuery(query: string, regex: boolean): { ok: true; finder: Finder } | { ok: false; error: string } {
  const q = query.trim();
  if (!q) return { ok: false, error: "invalid regex: empty pattern" };
  if (q.length > MAX_PATTERN) return { ok: false, error: "invalid regex: pattern longer than 200 characters" };
  if (!regex) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return {
      ok: true,
      finder: {
        find(text) {
          const lower = text.toLowerCase();
          let first = -1;
          for (const w of words) {
            const at = lower.indexOf(w);
            if (at < 0) return undefined;
            if (first < 0 || at < first) first = at;
          }
          return { index: Math.max(0, first) };
        },
      },
    };
  }
  if (tooExpensive(q)) return { ok: false, error: "invalid regex: pattern is too expensive" };
  let re: RegExp;
  try { re = new RegExp(q, "i"); } catch (e) {
    return { ok: false, error: `invalid regex: ${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 180)}` };
  }
  return {
    ok: true,
    finder: {
      find(text) {
        const chunk = 4000;
        const overlap = 200;
        const step = chunk - overlap;
        const n = text.length;
        if (n === 0) {
          const m = re.exec("");
          return m ? { index: 0 } : undefined;
        }
        for (let i = 0; i < n; i += step) {
          const slice = text.slice(i, Math.min(n, i + chunk));
          const m = re.exec(slice);
          if (m) return { index: i + m.index };
          if (i + chunk >= n) break;
        }
        return undefined;
      },
    },
  };
}

function page(body: string, offset: number, max: number, withheld: number) {
  const total = body.length;
  const start = Math.max(0, Math.min(offset, total));
  const end = Math.min(total, start + max);
  const next = end < total ? end : undefined;
  const head = [`chars ${start}-${end} of ${total}`];
  if (next !== undefined) head.push(`next: ${next}`);
  const text = `${head.join("\n")}\n\n${body.slice(start, end)}`;
  return ok(text, { total, shown: end - start, withheld, ...(next !== undefined ? { next } : {}) });
}

function block(row: Row, body: string): string {
  return `[${where(row.turn)} · id ${row.id} · ${row.role} · session ${row.sessionId}]\n${body}`;
}

const NONE = "0 matches, showing 0 from offset 0.\nno transcript saved for this session yet";

export function createSessionRecallTool(deps: SessionRecallDeps): Tool {
  const owner = deps.owner || "owner";
  const same = (o: string | undefined) => (o ?? "owner") === owner;

  function gather(sessionId: string, scopeAll: boolean): { rows: Row[]; bounded: boolean; missing: boolean } {
    const cur = deps.load(sessionId);
    const ids: string[] = [];
    if (!scopeAll) {
      if (!cur || !same(cur.owner)) return { rows: [], bounded: false, missing: true };
      ids.push(cur.id);
    } else {
      if (cur && same(cur.owner)) ids.push(cur.id);
      const metas = deps.list().filter((m) => same(m.owner)).sort((a, b) => b.updatedAt - a.updatedAt);
      for (const m of metas) {
        if (ids.includes(m.id)) continue;
        ids.push(m.id);
        if (ids.length >= MAX_SESSIONS) break;
      }
    }
    const rows: Row[] = [];
    let scanned = 0;
    let bounded = scopeAll && ids.length >= MAX_SESSIONS && deps.list().filter((m) => same(m.owner)).length > MAX_SESSIONS;
    if (ids.length === 0) return { rows, bounded, missing: true };
    const started = Date.now();
    for (const id of ids) {
      const src = id === sessionId && cur && cur.id === id ? cur : deps.load(id);
      if (!src || !same(src.owner)) continue;
      for (const row of corpusOf(src.state, src.history)) {
        if (rows.length >= MAX_MATCHES * 4 || scanned > MAX_SCAN_CHARS || Date.now() - started > TIME_BUDGET_MS) {
          bounded = true;
          return { rows, bounded, missing: false };
        }
        scanned += row.text.length;
        rows.push({ ...row, sessionId: src.id });
      }
    }
    return { rows, bounded, missing: false };
  }

  return {
    spec: {
      name: "session_recall",
      description: "Read this chat's raw turns after compaction. A summary is a cue, not the original. action grep: words, or a regex when regex is true (max 200 chars), over this session; scope \"all\" also searches this user's other chats here. Returns turn, message id, role and a snippet, paged with limit/offset and a total. action expand: turn range (from, to), message id, compaction span (\"1..4\" or \"[turns 1..4]\"), or tool-output ref. Pages by chars (offset, max 8000) and returns next. action recent: the last n raw turns (default 5).",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["grep", "expand", "recent"], description: "grep, expand, or recent" },
          query: { type: "string", description: "grep: words, or a regex when regex is true (max 200 characters)" },
          regex: { type: "boolean", description: "grep: treat query as a regular expression" },
          scope: { type: "string", enum: ["session", "all"], description: "session (default) or all of this user's chats in this store" },
          limit: { type: "integer", description: "grep page size (default 20, max 50)" },
          offset: { type: "integer", description: "grep: match offset. expand: character offset" },
          from: { type: "integer", description: "expand: first user turn (inclusive)" },
          to: { type: "integer", description: "expand: last user turn (inclusive)" },
          id: { type: "string", description: "expand: one message id from grep" },
          span: { type: "string", description: "expand: a compaction span, 1..4 or [turns 1..4]" },
          ref: { type: "string", description: "expand: a tool-output ref id (64 hex chars)" },
          max: { type: "integer", description: "expand/recent: max characters in this page (default 8000)" },
          n: { type: "integer", description: "recent: how many user turns (default 5, max 20)" },
        },
        required: ["action"],
      },
    },
    class: "read",
    receipt: "surface",
    async run(args, ctx) {
      const action = String(args.action ?? "").trim().toLowerCase();
      const sessionId = ctx.sessionId;
      if (action !== "grep" && action !== "expand" && action !== "recent") return fail("action must be grep, expand, or recent");

      if (action === "expand" && (typeof args.ref === "string" && args.ref.trim())) {
        const idMatch = /[0-9a-f]{64}/i.exec(args.ref.trim());
        if (!idMatch) return fail("invalid ref");
        const blob = deps.blobs.get(idMatch[0].toLowerCase());
        if (blob === undefined) return fail("no such ref");
        const screened = screenUntrustedText(redactSecrets(blob));
        const body = withScreenNotice(screened);
        return page(body, clampInt(args.offset, 0, 0, 50_000_000), clampInt(args.max, DEFAULT_PAGE, 1, DEFAULT_PAGE), screened.withheld);
      }

      const scopeAll = String(args.scope ?? "session").trim().toLowerCase() === "all";
      const { rows, bounded, missing } = gather(sessionId, scopeAll);
      if (missing) return ok(NONE, { total: 0, shown: 0, withheld: 0 });

      if (action === "grep") {
        const compiled = compileQuery(String(args.query ?? ""), truthy(args.regex));
        if (!compiled.ok) return fail(compiled.error);
        const matches: { row: Row; snippet: string; withheld: number }[] = [];
        const started = Date.now();
        let stopped = bounded;
        for (const row of rows) {
          if (matches.length >= MAX_MATCHES || Date.now() - started > TIME_BUDGET_MS) { stopped = true; break; }
          const shown = present(row);
          const hit = compiled.finder.find(shown.text);
          if (!hit) continue;
          matches.push({ row, snippet: snippetAt(shown.text, hit.index), withheld: shown.withheld });
        }
        const offset = clampInt(args.offset, 0, 0, 1_000_000);
        const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
        const pageRows = matches.slice(offset, offset + limit);
        const lines = [`${matches.length} matches, showing ${pageRows.length} from offset ${offset}.`];
        let withheld = 0;
        for (const m of pageRows) {
          withheld += m.withheld;
          lines.push(`${where(m.row.turn)} · id ${m.row.id} · ${m.row.role} · session ${m.row.sessionId}`);
          lines.push(m.snippet);
        }
        const next = offset + pageRows.length < matches.length ? offset + pageRows.length : undefined;
        if (next !== undefined) lines.push(`next offset: ${next}`);
        if (stopped) lines.push("search was bounded");
        return ok(lines.join("\n"), { total: matches.length, shown: pageRows.length, withheld, ...(next !== undefined ? { next } : {}) });
      }

      let selected: Row[] = [];
      if (action === "recent") {
        const n = clampInt(args.n, DEFAULT_RECENT, 1, MAX_RECENT);
        const turns = [...new Set(rows.filter((r) => r.turn > 0).map((r) => r.turn))];
        const keep = new Set(turns.slice(-n));
        selected = keep.size ? rows.filter((r) => keep.has(r.turn)) : rows.slice(-n);
      } else {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        if (id) {
          selected = rows.filter((r) => r.id === id);
          if (selected.length === 0) return fail("no such message id");
        } else {
          let from = optInt(args.from);
          let to = optInt(args.to);
          if (typeof args.span === "string" && args.span.trim()) {
            const span = parseSpan(args.span);
            if (!span) return fail("invalid span");
            from = span.from;
            to = span.to;
          }
          if (from === undefined && to === undefined) return fail("expand needs from/to, id, span, or ref");
          const a = from ?? to ?? 1;
          const b = to ?? from ?? a;
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          selected = rows.filter((r) => r.turn >= lo && r.turn <= hi);
        }
      }

      let withheld = 0;
      const parts: string[] = [];
      for (const row of selected) {
        const shown = present(row);
        withheld += shown.withheld;
        parts.push(block(row, shown.text));
      }
      const body = parts.join("\n\n");
      const paged = page(body, clampInt(args.offset, 0, 0, 50_000_000), clampInt(args.max, DEFAULT_PAGE, 1, DEFAULT_PAGE), withheld);
      if (bounded && paged.ok) paged.output += "\n\nsearch was bounded";
      return paged;
    },
  };
}
