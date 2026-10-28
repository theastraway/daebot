// Granular permission rules. Pure functions only (no I/O): what a tool call IS (facts), which saved rule covers it,
// and which scope choices the user is offered when they press "Always...". The scope choices are generated HERE from the
// real call, on the server; a client only ever picks one by id, so neither the model nor a forged request can invent a rule.
import { isAbsolute, resolve as resolvePath, dirname, posix } from "node:path";
import { callSignature } from "../kernel/util.ts";
import type { ToolClass } from "../types.ts";

export type Effect = "allow" | "deny";
export type MatcherKind = "any" | "exact" | "prefix" | "glob" | "domain" | "recipient" | "recipients" | "cwd" | "readonly";
export interface Matcher { kind: MatcherKind; value?: string }

export interface PermissionRule {
  id: string;
  effect: Effect;
  /** A tool name, "group:fs-read" (read_file, glob, grep) or "connector:<server>" (every tool of one connected MCP server). */
  tool: string;
  matcher: Matcher;
  /** Plain-words description of what the rule covers (shown in Settings and in the system prompt). */
  scope: string;
  createdAt: number;
  uses: number;
  lastUsedAt?: number;
}

/** What the server knows about one call. Derived from the tool name and arguments only. */
export interface CallFacts {
  tool: string;
  cls: ToolClass;
  cwd: string;
  command?: string;
  paths: string[];
  url?: string;
  host?: string;
  recipients: string[];
  connector?: string;
  signature: string;
}

export interface ScopeOption {
  id: string;
  label: string;
  tool: string;
  matcher: Matcher;
  /** Broad scopes (a whole folder, a whole tool) are marked so the UI can word them with care. */
  broad: boolean;
}

export const FS_READ_TOOLS = new Set(["read_file", "glob", "grep"]);
export const FS_PATH_TOOLS = new Set(["read_file", "write_file", "edit_file", "glob", "grep"]);
const PUBLIC_MAIL = new Set(["gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "msn.com"]);
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const RECIPIENT_KEYS = new Set(["to", "cc", "bcc", "recipient", "recipients", "email", "emails", "address", "addresses", "contact_email", "send_to"]);

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- facts

export const normPath = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "") || "/";

function pathOf(cwd: string, raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const abs = isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) ? raw : resolvePath(cwd, raw);
  return normPath(posix.normalize(abs.replace(/\\/g, "/")));
}

export function canonCommand(c: string): string {
  return c.replace(/\s+/g, " ").trim();
}

export function normUrl(u: string): string | undefined {
  try {
    const x = new URL(u.trim());
    x.hash = "";
    return x.toString();
  } catch { return undefined; }
}

export function extractRecipients(args: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, key: string | undefined, depth: number): void => {
    if (depth > 4 || v === null || v === undefined) return;
    if (typeof v === "string") {
      if (key !== undefined && RECIPIENT_KEYS.has(key.toLowerCase())) for (const m of v.match(EMAIL_RE) ?? []) out.add(m.toLowerCase());
      return;
    }
    if (Array.isArray(v)) { for (const x of v.slice(0, 50)) walk(x, key, depth + 1); return; }
    if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 80)) walk(x, k, depth + 1);
  };
  walk(args, undefined, 0);
  return [...out].sort();
}

export function factsOf(tool: string, cls: ToolClass, args: Record<string, unknown> | undefined, cwd: string): CallFacts {
  const a = args ?? {};
  const f: CallFacts = { tool, cls, cwd: normPath(cwd), paths: [], recipients: extractRecipients(a), signature: callSignature(tool, a) };
  if (tool === "bash" && typeof a.command === "string") f.command = canonCommand(a.command);
  if (FS_PATH_TOOLS.has(tool)) {
    const p = pathOf(cwd, a.path) ?? ((tool === "glob" || tool === "grep") ? normPath(cwd) : undefined);
    if (p) f.paths.push(p);
  }
  if (tool === "web_fetch" && typeof a.url === "string") {
    const u = normUrl(a.url);
    if (u) { f.url = u; f.host = new URL(u).hostname.toLowerCase(); }
  }
  const i = tool.indexOf("__");
  if (i > 0) f.connector = tool.slice(0, i);
  return f;
}

// ---------------------------------------------------------------- matching

const toolMatches = (rule: PermissionRule, f: CallFacts): boolean =>
  rule.tool === f.tool ||
  (rule.tool === "group:fs-read" && FS_READ_TOOLS.has(f.tool)) ||
  (rule.tool.startsWith("connector:") && f.connector !== undefined && rule.tool.slice(10) === f.connector);

const SIMPLE_BAD = /[;&|<>`\n\r]|\$\(|\$\{|<\(/;

/** A command that is one plain program call: no chaining, pipes, redirects or substitution. Only these can match an allow prefix. */
export function isSimpleCommand(c: string): boolean {
  return !SIMPLE_BAD.test(c);
}

/** The simple commands inside a possibly chained command line (for deny rules, which must catch a banned command anywhere in the chain). */
export function commandSegments(c: string): string[] {
  const segs = c.split(/&&|\|\||[;&|\n\r]|\$\(|`|\(|\)/).map((s) => canonCommand(s)).filter(Boolean);
  return segs.length ? segs : [canonCommand(c)];
}

const startsWithWords = (cmd: string, prefix: string): boolean => cmd === prefix || cmd.startsWith(prefix + " ");

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { i++; if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*"; } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, process.platform === "win32" ? "i" : "");
}

export function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase(), d = domain.toLowerCase();
  return h === d || h.endsWith("." + d);
}

const recipientDomain = (r: string): string => r.slice(r.lastIndexOf("@") + 1);

/** Which matcher kinds an ALLOW rule may use for a call of this class. Irreversible/public calls only ever by exact call; outward ones only by target. */
export function allowKindsFor(cls: ToolClass, tool: string): MatcherKind[] {
  switch (cls) {
    case "read": return ["any", "exact", "prefix", "glob", "domain", "recipient", "recipients", "cwd", "readonly"];
    case "write": return ["any", "exact", "prefix", "glob", "domain", "recipient", "recipients", "cwd"];
    case "outward": return tool.includes("__") ? ["exact", "any", "recipient", "recipients", "domain"] : ["exact", "recipient", "recipients", "domain"];
    default: return ["exact"]; // irreversible, public
  }
}

export function exactValue(f: CallFacts): string {
  if (f.command !== undefined) return "cmd:" + f.command;
  if (f.paths.length === 1) return "path:" + f.paths[0];
  if (f.url) return "url:" + f.url;
  return "call:" + f.signature;
}

export function matches(rule: PermissionRule, f: CallFacts): boolean {
  if (!toolMatches(rule, f)) return false;
  const m = rule.matcher;
  switch (m.kind) {
    case "any": return true;
    case "readonly": return f.cls === "read";
    case "exact": return m.value !== undefined && exactValue(f) === m.value;
    case "prefix": {
      if (f.command === undefined || !m.value) return false;
      const p = canonCommand(m.value);
      if (rule.effect === "deny") return commandSegments(f.command).some((s) => startsWithWords(s, p)); // a ban holds anywhere in a chain
      return isSimpleCommand(f.command) && startsWithWords(f.command, p);
    }
    case "glob": {
      if (!m.value || f.paths.length === 0) return false;
      const re = globToRegExp(normPath(m.value));
      return f.paths.every((p) => re.test(p));
    }
    case "domain": {
      if (!m.value) return false;
      if (f.host) return hostMatches(f.host, m.value);
      return f.recipients.length > 0 && f.recipients.every((r) => hostMatches(recipientDomain(r), m.value!));
    }
    case "recipient": return !!m.value && f.recipients.length > 0 && f.recipients.every((r) => r === m.value!.toLowerCase());
    case "recipients": {
      if (!m.value) return false;
      const set = new Set(m.value.toLowerCase().split(",").map((x) => x.trim()).filter(Boolean));
      return f.recipients.length > 0 && f.recipients.every((r) => set.has(r));
    }
    case "cwd": return f.command !== undefined && !!m.value && normPath(m.value) === f.cwd;
    default: return false;
  }
}

/** Higher = narrower. Used to credit the most specific rule and to order choices. */
export function specificity(rule: Pick<PermissionRule, "tool" | "matcher">): number {
  const base: Record<MatcherKind, number> = { exact: 100, recipient: 90, recipients: 85, prefix: 70, glob: 60, domain: 50, cwd: 40, any: 20, readonly: 10 };
  const len = Math.min(40, (rule.matcher.value ?? "").length) / 100; // a longer prefix/glob is narrower
  return base[rule.matcher.kind] + len + (rule.tool.startsWith("connector:") || rule.tool.startsWith("group:") ? -5 : 0);
}

export interface Evaluation { effect: Effect | "none"; rule?: PermissionRule }

/** Deny wins over allow. An allow rule only counts if its kind is permitted for this call's class (a hand-edited file cannot widen it). */
export function evaluate(rules: PermissionRule[], f: CallFacts): Evaluation {
  let deny: PermissionRule | undefined;
  let allow: PermissionRule | undefined;
  const okKinds = allowKindsFor(f.cls, f.tool);
  for (const r of rules) {
    if (!matches(r, f)) continue;
    if (r.effect === "deny") { if (!deny || specificity(r) > specificity(deny)) deny = r; }
    // An allow only counts when it names this very tool, or is a read-only group/connector scope; "connector:x + any" can never reach an outward tool.
    else if (okKinds.includes(r.matcher.kind) && (r.tool === f.tool || r.matcher.kind === "readonly") && (!allow || specificity(r) > specificity(allow))) allow = r;
  }
  if (deny) return { effect: "deny", rule: deny };
  if (allow) return { effect: "allow", rule: allow };
  return { effect: "none" };
}

// ---------------------------------------------------------------- scope options

function commandPrefix(cmd: string): string | undefined {
  const toks = cmd.split(" ");
  if (!toks[0] || !/^[A-Za-z0-9._\\/:-]+$/.test(toks[0])) return undefined;
  if (toks.length > 1 && /^[a-z][a-z0-9:_-]*$/i.test(toks[1]) && !toks[1].startsWith("-")) return `${toks[0]} ${toks[1]}`;
  return toks[0];
}

/** The choices behind "Always allow..." / "Always deny...", most specific first. Allow lists never offer a scope the class forbids. */
export function scopeOptions(f: CallFacts, effect: Effect): ScopeOption[] {
  const out: Omit<ScopeOption, "id">[] = [];
  const add = (label: string, tool: string, matcher: Matcher, broad = false) => out.push({ label, tool, matcher, broad });

  if (f.command !== undefined) {
    add(`Only this exact command: ${clip(f.command, 80)}`, f.tool, { kind: "exact", value: exactValue(f) });
    const p = commandPrefix(f.command);
    if (p && (effect === "deny" || isSimpleCommand(f.command))) add(`Any command starting with \`${p}\` (${p}*)`, f.tool, { kind: "prefix", value: p }, true);
    add(`Any command in this folder (${clip(f.cwd, 60)})`, f.tool, { kind: "cwd", value: f.cwd }, true);
  } else if (FS_PATH_TOOLS.has(f.tool) && f.paths.length === 1) {
    const p = f.paths[0];
    const isDirCall = f.tool === "glob" || f.tool === "grep";
    const dir = isDirCall ? p : dirname(p).replace(/\\/g, "/");
    add(isDirCall ? `Only this folder: ${clip(p, 70)}` : `Only this file: ${clip(p, 70)}`, f.tool, { kind: "exact", value: exactValue(f) });
    add(`Anything in this folder and below: ${clip(dir, 60)}/**`, f.tool, { kind: "glob", value: `${dir === "/" ? "" : dir}/**` }, true);
    if (f.cls === "read") add("Read-only: reading, listing and searching any file", "group:fs-read", { kind: "readonly" }, true);
  } else if (f.url) {
    add(`Only this page: ${clip(f.url, 80)}`, f.tool, { kind: "exact", value: exactValue(f) });
    if (f.host) add(`Any page on ${f.host} (and its subdomains)`, f.tool, { kind: "domain", value: f.host }, true);
  } else if (f.connector) {
    add("Only this exact call (same arguments)", f.tool, { kind: "exact", value: exactValue(f) });
    if (f.recipients.length === 1) add(`Only when it targets ${f.recipients[0]}`, f.tool, { kind: "recipient", value: f.recipients[0] });
    add(`This tool, any arguments (${f.tool.slice(f.tool.indexOf("__") + 2)} in ${f.connector})`, f.tool, { kind: "any" }, true);
    if (f.cls === "read") add(`Every read-only tool of ${f.connector}`, `connector:${f.connector}`, { kind: "readonly" }, true);
  } else {
    add("Only this exact call (same arguments)", f.tool, { kind: "exact", value: exactValue(f) });
    if (f.recipients.length === 1) add(`Only when it targets ${f.recipients[0]}`, f.tool, { kind: "recipient", value: f.recipients[0] });
    else if (f.recipients.length > 1) add(`Only these recipients: ${clip(f.recipients.join(", "), 80)}`, f.tool, { kind: "recipients", value: f.recipients.join(",") });
    const doms = [...new Set(f.recipients.map(recipientDomain))];
    if (doms.length === 1 && !PUBLIC_MAIL.has(doms[0])) add(`Anyone at ${doms[0]}`, f.tool, { kind: "domain", value: doms[0] }, true);
    add(`This tool, any arguments (${f.tool})`, f.tool, { kind: "any" }, true);
  }

  const okKinds = allowKindsFor(f.cls, f.tool);
  const seen = new Set<string>();
  const res: ScopeOption[] = [];
  for (const o of out) {
    if (effect === "allow" && !okKinds.includes(o.matcher.kind)) continue;
    if (effect === "allow" && o.tool !== f.tool && o.matcher.kind === "readonly" && f.cls !== "read") continue;
    const key = `${o.tool}|${o.matcher.kind}|${o.matcher.value ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    res.push({ ...o, id: `s${res.length}` });
  }
  return res;
}

/** The "kind of request" a decision teaches: the middle choice (a command prefix, a domain, a folder, a recipient), else the only one. */
export function patternOf(f: CallFacts): { key: string; label: string; tool: string; matcher: Matcher } | undefined {
  const opts = scopeOptions(f, "deny");
  const o = opts.length > 1 ? opts[1] : opts[0];
  if (!o) return undefined;
  return { key: `${o.tool}|${o.matcher.kind}|${o.matcher.value ?? ""}`, label: o.label, tool: o.tool, matcher: o.matcher };
}

// ---------------------------------------------------------------- validation (used by the store before anything is saved)

const KINDS: MatcherKind[] = ["any", "exact", "prefix", "glob", "domain", "recipient", "recipients", "cwd", "readonly"];
export const isKind = (k: unknown): k is MatcherKind => typeof k === "string" && (KINDS as string[]).includes(k);
const NEEDS_VALUE: MatcherKind[] = ["exact", "prefix", "glob", "domain", "recipient", "recipients", "cwd"];

/** Throws on a rule that is malformed or that would auto-allow a class it must not (any broad allow for irreversible / public / outward-to-anyone). */
export function validateRule(r: { effect: unknown; tool: unknown; matcher: unknown }, cls?: ToolClass): { effect: Effect; tool: string; matcher: Matcher } {
  if (r.effect !== "allow" && r.effect !== "deny") throw new Error("effect must be allow or deny");
  if (typeof r.tool !== "string" || !/^(group:fs-read|connector:[A-Za-z0-9_-]{1,64}|[A-Za-z0-9_:.-]{1,128})$/.test(r.tool)) throw new Error("bad tool");
  const m = r.matcher as Matcher;
  if (!m || !isKind(m.kind)) throw new Error("bad matcher");
  if (NEEDS_VALUE.includes(m.kind) && (typeof m.value !== "string" || m.value.trim() === "" || m.value.length > 600)) throw new Error("matcher needs a value");
  if (!NEEDS_VALUE.includes(m.kind) && m.value !== undefined) throw new Error("matcher takes no value");
  if (m.kind === "glob" && m.value!.replace(/[*?/]/g, "") === "") throw new Error("glob too broad");
  if (m.kind === "prefix" && canonCommand(m.value!) === "") throw new Error("prefix is empty");
  if (r.effect === "allow") {
    if (m.kind === "readonly" && !(r.tool === "group:fs-read" || r.tool.startsWith("connector:"))) throw new Error("read-only scope needs a read-only tool group");
    if ((r.tool === "group:fs-read" || r.tool.startsWith("connector:")) && m.kind !== "readonly") throw new Error("a tool group can only be allowed read-only");
    if (cls && !allowKindsFor(cls, r.tool).includes(m.kind)) throw new Error(`a ${cls} action can only be allowed by a narrower scope than "${m.kind}"`);
    if (m.kind === "recipient" || m.kind === "recipients") { if (!/@/.test(m.value!)) throw new Error("recipient must be an address"); }
    if (m.kind === "domain" && (PUBLIC_MAIL.has(m.value!.toLowerCase()) || !m.value!.includes("."))) throw new Error("domain too broad");
  }
  return { effect: r.effect, tool: r.tool, matcher: m.value === undefined ? { kind: m.kind } : { kind: m.kind, value: m.value.trim() } };
}

// ---------------------------------------------------------------- plain words for the card

const argStr = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v) ?? "");

/** Clips long string values so a card never carries a whole file body. */
export function previewArgs(args: Record<string, unknown>): Record<string, unknown> {
  const walk = (v: unknown, d: number): unknown => {
    if (typeof v === "string") return v.length > 400 ? `${v.slice(0, 400)}… (${v.length} characters)` : v;
    if (d > 4 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => walk(x, d + 1));
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 40).map(([k, x]) => [k, walk(x, d + 1)]));
  };
  return walk(args, 0) as Record<string, unknown>;
}

export function describeCall(f: CallFacts, args: Record<string, unknown>): { title: string; detail: { label: string; value: string }[] } {
  const rows: { label: string; value: string }[] = [{ label: "Tool", value: f.tool }];
  let title: string;
  if (f.command !== undefined) { title = "Run a command on this computer"; rows.push({ label: "Command", value: clip(f.command, 600) }, { label: "Folder", value: f.cwd }); }
  else if (f.tool === "write_file") { title = "Write a file"; rows.push({ label: "File", value: f.paths[0] ?? "" }); }
  else if (f.tool === "edit_file") { title = "Change a file"; rows.push({ label: "File", value: f.paths[0] ?? "" }); }
  else if (FS_PATH_TOOLS.has(f.tool)) { title = f.tool === "read_file" ? "Read a file" : "Look through a folder"; rows.push({ label: f.tool === "read_file" ? "File" : "Folder", value: f.paths[0] ?? "" }); }
  else if (f.url) { title = "Open a web page"; rows.push({ label: "URL", value: clip(f.url, 300) }); }
  else if (f.connector) {
    title = `Use ${f.tool.slice(f.tool.indexOf("__") + 2)} in ${f.connector}`;
    rows.push({ label: "Connector", value: f.connector });
    if (f.recipients.length) rows.push({ label: "Recipient", value: f.recipients.join(", ") });
  } else if (f.recipients.length) { title = `Contact ${clip(f.recipients.join(", "), 80)}`; rows.push({ label: "Recipient", value: f.recipients.join(", ") }); }
  else title = `Use ${f.tool}`;
  const effect = f.cls === "outward" ? "This reaches someone outside Daebot." : f.cls === "irreversible" ? "This cannot be undone." : f.cls === "public" ? "This posts publicly." : f.cls === "write" ? "This changes something." : "";
  if (effect) rows.push({ label: "Effect", value: effect });
  const act = typeof args.action === "string" ? args.action : "";
  if (act) rows.push({ label: "Action", value: clip(argStr(act), 80) });
  return { title, detail: rows };
}

export const oneLineLabel = (s: string, n = 140): string => clip(oneLine(s), n);
