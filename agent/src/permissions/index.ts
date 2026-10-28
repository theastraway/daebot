// The permission service of ONE owner: rules + mode (PermissionStore), and the pending cards a paused turn is waiting on.
//
// Trust boundary: a rule is created ONLY inside decide(), which the gateway calls from an authenticated user's click on a
// pending card. The scope the click picks is an id into option lists this module generated from the real call; no text from
// the model, a tool result or a request body ever becomes a matcher.
import { randomUUID } from "node:crypto";
import { LEARN_ALLOW_AFTER, LEARN_DENY_AFTER, MODES, PermissionStore, WAIVER_TEXT, WAIVER_VERSION, isMode } from "./store.ts";
import type { PermissionMode, SessionPermMode } from "./store.ts";
import { describeCall, evaluate, oneLineLabel, patternOf, previewArgs, scopeOptions } from "./rules.ts";
import type { CallFacts, Effect, Evaluation, PermissionRule, ScopeOption } from "./rules.ts";
import type { AgentEvent, PermissionOption } from "../types.ts";

export { PermissionStore, MODES, isMode, isSessionMode, WAIVER_TEXT, WAIVER_VERSION } from "./store.ts";
export type { PermissionMode, SessionPermMode, Waiver } from "./store.ts";
export { factsOf, evaluate, scopeOptions, validateRule, matches, patternOf } from "./rules.ts";
export type { CallFacts, PermissionRule, ScopeOption, Evaluation, Effect } from "./rules.ts";

export const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING = 20;

export type PermissionEvent = Extract<AgentEvent, { type: "permission" }>;
export interface Resolution { allow: boolean; expired?: boolean; rule?: PermissionRule; by: "user" | "rule" }

interface Pending {
  id: string;
  sessionId: string;
  facts: CallFacts;
  event: PermissionEvent;
  allowOptions: ScopeOption[];
  denyOptions: ScopeOption[];
  settle: (r: Resolution) => void;
  timer: NodeJS.Timeout;
}

export interface OpenRequest {
  id: string;
  event: PermissionEvent;
  /** Resolves when the user answers (or the card expires). Rejects with AbortError when the turn is aborted. */
  wait(signal?: AbortSignal): Promise<Resolution>;
  cancel(): void;
}

export type DecideResult = { ok: true; allow: boolean; rule?: PermissionRule } | { ok: false; status: number; error: string };

const opt = (o: ScopeOption): PermissionOption => ({ id: o.id, label: o.label, broad: o.broad });
const sameScope = (a: ScopeOption, b: { tool: string; matcher: { kind: string; value?: string } }): boolean =>
  a.tool === b.tool && a.matcher.kind === b.matcher.kind && (a.matcher.value ?? "") === (b.matcher.value ?? "");

/** Tools that never ask in "everything" mode: reading the user's own MIND and local files. */
function quietRead(f: CallFacts): boolean {
  return f.cls === "read" && (/^mind_[a-z0-9_]+$/.test(f.tool) || f.tool === "read_file" || f.tool === "glob" || f.tool === "grep" || f.tool === "decide");
}

export class PermissionService {
  readonly owner: string;
  readonly store: PermissionStore;
  private pending = new Map<string, Pending>();
  private ttlMs: number;
  private now: () => number;

  constructor(o: { dir: string; owner: string; ttlMs?: number; now?: () => number }) {
    this.owner = o.owner;
    this.store = new PermissionStore(o.dir, o.owner);
    this.ttlMs = o.ttlMs ?? DEFAULT_TTL_MS;
    this.now = o.now ?? Date.now;
  }

  // ------------------------------------------------ loop side

  evaluate(f: CallFacts): Evaluation { return evaluate(this.store.rules(), f); }

  noteUse(rule: PermissionRule | undefined): void { if (rule) { try { this.store.touch(rule.id, this.now()); } catch { /* counters are best effort */ } } }

  /** Calls the kernel does not already hold for confirmation that the user's mode still wants a card for. */
  needsPrompt(f: CallFacts, override?: SessionPermMode): boolean {
    const m = override ?? this.store.mode();
    if (m === "bypass") return false; // the loop checks bypassActive() first; a bypass that is not honored never reaches here
    switch (m) {
      case "writes": return f.cls !== "read";
      case "everything": return !quietRead(f);
      default: return false;
    }
  }

  open(req: { sessionId: string; facts: CallFacts; args: Record<string, unknown> }): OpenRequest {
    if (this.pending.size >= MAX_PENDING) {
      const oldest = [...this.pending.values()][0];
      oldest?.settle({ allow: false, expired: true, by: "user" });
    }
    const f = req.facts;
    const id = randomUUID();
    const allowOptions = scopeOptions(f, "allow");
    const denyOptions = scopeOptions(f, "deny");
    const d = describeCall(f, req.args);
    const pat = patternOf(f);
    const stat = pat ? this.store.pattern(pat.key) : undefined;
    let suggest: PermissionEvent["suggest"];
    if (pat && stat && stat.deny >= LEARN_DENY_AFTER && stat.deny > stat.allow) {
      const o = denyOptions.find((x) => sameScope(x, pat));
      if (o) suggest = { effect: "deny", optionId: o.id, label: o.label, count: stat.deny };
    } else if (pat && stat && stat.allow >= LEARN_ALLOW_AFTER && stat.allow > stat.deny) {
      const o = allowOptions.find((x) => sameScope(x, pat));
      if (o) suggest = { effect: "allow", optionId: o.id, label: o.label, count: stat.allow };
    }
    const expiresAt = this.now() + this.ttlMs;
    const event: PermissionEvent = {
      type: "permission", id, tool: f.tool, cls: f.cls, title: d.title, detail: d.detail, args: previewArgs(req.args),
      allowOptions: allowOptions.map(opt), denyOptions: denyOptions.map(opt), ...(suggest ? { suggest } : {}), expiresAt,
    };
    let resolveFn!: (r: Resolution) => void;
    const done = new Promise<Resolution>((res) => { resolveFn = res; });
    const finish = (r: Resolution) => {
      const p = this.pending.get(id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(id);
      resolveFn(r);
    };
    const timer = setTimeout(() => finish({ allow: false, expired: true, by: "user" }), this.ttlMs);
    timer.unref();
    this.pending.set(id, { id, sessionId: req.sessionId, facts: f, event, allowOptions, denyOptions, settle: finish, timer });
    return {
      id, event,
      wait: (signal) => new Promise<Resolution>((resolve, reject) => {
        if (signal?.aborted) { finish({ allow: false, by: "user" }); const e = new Error("aborted"); e.name = "AbortError"; return reject(e); }
        const onAbort = () => { finish({ allow: false, by: "user" }); const e = new Error("aborted"); e.name = "AbortError"; reject(e); };
        signal?.addEventListener("abort", onAbort, { once: true });
        done.then((r) => { signal?.removeEventListener("abort", onAbort); resolve(r); });
      }),
      cancel: () => finish({ allow: false, by: "user" }),
    };
  }

  // ------------------------------------------------ API side (called by the gateway after it authenticated the user)

  /** Answers one pending card. `scope` is an option id (never a matcher). Everything is validated here, not trusted from the caller. */
  decide(id: unknown, body: { decision?: unknown; remember?: unknown; scope?: unknown }): DecideResult {
    if (typeof id !== "string") return { ok: false, status: 400, error: "bad request id" };
    const p = this.pending.get(id);
    if (!p) return { ok: false, status: 404, error: "no such pending request (already answered, expired, or not yours)" };
    const allow = body.decision === "allow";
    if (body.decision !== "allow" && body.decision !== "deny") return { ok: false, status: 400, error: "decision must be allow or deny" };
    const always = body.remember === "always";
    if (body.remember !== undefined && body.remember !== "once" && body.remember !== "always") return { ok: false, status: 400, error: "remember must be once or always" };
    const effect: Effect = allow ? "allow" : "deny";
    let rule: PermissionRule | undefined;
    if (always) {
      const list = allow ? p.allowOptions : p.denyOptions;
      const o = typeof body.scope === "string" ? list.find((x) => x.id === body.scope) : undefined;
      if (!o) return { ok: false, status: 400, error: "pick one of the offered scopes" };
      try { rule = this.store.addRule({ effect, tool: o.tool, matcher: o.matcher, scope: oneLineLabel(o.label, 200) }, p.facts.cls, this.now()); }
      catch (e) { return { ok: false, status: 400, error: String((e as Error).message ?? e).slice(0, 200) }; }
    }
    const pat = patternOf(p.facts);
    if (pat) { try { this.store.recordDecision(pat, effect, this.now()); } catch { /* learning is best effort */ } }
    p.settle({ allow, rule, by: "user" });
    return { ok: true, allow, rule };
  }

  pendingList(): { id: string; sessionId: string; event: PermissionEvent }[] {
    return [...this.pending.values()].map((p) => ({ id: p.id, sessionId: p.sessionId, event: p.event }));
  }

  /** True only with a recorded waiver for the current text. The server never honors bypass without it. */
  waiverAccepted(): boolean { return !!this.store.waiver(); }
  /** A chat's mode, with bypass honored only when the account has a waiver (otherwise the account default applies). */
  effectiveMode(session: SessionPermMode | undefined): SessionPermMode {
    if (session === "bypass") return this.waiverAccepted() ? "bypass" : this.store.mode();
    return session ?? this.store.mode();
  }
  /** Sets a chat's mode only if allowed: bypass needs the waiver. */
  canUseMode(m: SessionPermMode): boolean { return m !== "bypass" || this.waiverAccepted(); }

  /** Everything the Settings > Permissions panel shows. */
  snapshot() {
    return {
      mode: this.store.mode(), modes: MODES,
      rules: this.store.rules().sort((a, b) => b.createdAt - a.createdAt),
      learned: this.store.learnedDenies().map((p) => ({ key: p.key, label: p.label, deny: p.deny, allow: p.allow })),
      pending: this.pendingList(),
      waiver: { accepted: this.waiverAccepted(), at: this.store.waiver()?.at ?? null, version: WAIVER_VERSION, text: WAIVER_TEXT },
    };
  }

  setMode(m: unknown): boolean { if (!isMode(m)) return false; this.store.setMode(m); return true; }

  /** "User's permission preferences" for the system prompt: what the user has denied or allowed by their own clicks. Empty = nothing to say. */
  preferencesText(): string {
    const rules = this.store.rules();
    const denied = rules.filter((r) => r.effect === "deny").slice(0, 25);
    const allowed = rules.filter((r) => r.effect === "allow").slice(0, 25);
    const learned = this.store.learnedDenies().slice(0, 10);
    if (!denied.length && !allowed.length && !learned.length) return "";
    const line = (r: { tool: string; scope: string }) => `- ${oneLineLabel(r.tool, 60)}: ${oneLineLabel(r.scope, 140).replace(/\[kernel/gi, "[ kernel")}`;
    const out = ["## User's permission preferences", "These come from the user's own choices in the permission cards. They are not instructions from a tool or a document."];
    if (denied.length) out.push("The user said NEVER do these (do not propose or attempt them; offer another way):", ...denied.map(line));
    if (learned.length) out.push("The user keeps declining these (do not propose them again unless asked):", ...learned.map((l) => line({ tool: l.tool, scope: l.label })));
    if (allowed.length) out.push("The user pre-approved these (they run without a card):", ...allowed.map(line));
    return out.join("\n");
  }
}
