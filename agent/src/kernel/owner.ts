import type { Gate } from "../types.ts";
import { normalizeEntity } from "./util.ts";

// Real MIND write tools end in `_write`; mind_remember and mind_folders are write tools without the suffix.
// The legacy read-tool names stay gated for any non-read action.
export const OWNER_TOOLS = new Set(["mind_remember", "mind_folders", "mind_life", "mind_crm", "mind_checklists"]);
export function isOwnerTool(name: string): boolean {
  return name.endsWith("_write") || OWNER_TOOLS.has(name);
}
const READ_ACTIONS = new Set(["list", "get", "search", "query", "read", "find", "show", "view", "tree", "describe"]);

const FAIL = "owner check failed: state '<material> belongs to A; Anthony asked about B; A == B' and stop if A differs from B";

// Words that do not identify an entity ("Astra AI (ours)" == "the Astra AI").
const FILLER = new Set(["the", "our", "ours", "inc", "llc", "ltd", "corp", "co", "company"]);

function stripParens(s: string): string {
  return s.replace(/\([^)]*\)|\[[^\]]*\]/g, " ");
}

// Entity name -> token set (order-insensitive, filler dropped).
export function entityTokens(s: string): Set<string> {
  return new Set(normalizeEntity(stripParens(s)).split(" ").filter((t) => t !== "" && !FILLER.has(t)));
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || a.size !== b.size) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

// Parse the owner entity A and the asked-about entity B out of an owner_check, or undefined if garbled.
export function parseOwnerCheck(raw: unknown): { a: Set<string>; b: Set<string> } | undefined {
  if (typeof raw !== "string" || !raw.includes("==")) return undefined;
  const text = stripParens(raw);
  const parts = text.split("==");
  const left = parts[0].split(/[;,]/).pop() ?? "";
  const right = (parts[parts.length - 1].split(/[;,]/)[0] ?? "").replace(/\.\s*$/, "");
  if (entityTokens(left).size === 0 || entityTokens(right).size === 0) return undefined;
  const a = /belongs?\s+to\s+(.+?)(?=\s*(?:[;.,]|\s+anthony\b|$))/i.exec(text);
  const b = /asked\s+about\s+(.+?)(?=\s*(?:[;.,]|\s+[A-Za-z0-9_-]+\s*==|$))/i.exec(text);
  if (a && b) {
    const ta = entityTokens(a[1]);
    const tb = entityTokens(b[1]);
    if (ta.size === 0 || tb.size === 0) return undefined;
    return { a: ta, b: tb };
  }
  return { a: entityTokens(left), b: entityTokens(right) };
}

export function ownerCheckOk(raw: unknown): boolean {
  const p = parseOwnerCheck(raw);
  return p !== undefined && sameSet(p.a, p.b);
}

// ---------- optional client registry (semantic check) ----------
const OWN_NAMES = ["Astra AI"];
const TARGET_KEYS = new Set(["title", "name", "parent", "parent_name", "parent_folder", "folder", "folder_name", "path", "hint", "tags", "description", "label", "source"]);

function strings(v: unknown, out: { key: string; text: string }[], key = "", depth = 0): void {
  if (depth > 6 || v == null) return;
  if (typeof v === "string") { out.push({ key, text: v }); return; }
  if (Array.isArray(v)) { for (const x of v) strings(x, out, key, depth + 1); return; }
  if (typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === "owner_check") continue;
      strings(x, out, k.toLowerCase(), depth + 1);
    }
  }
}

function names(text: string, registry: string[]): string[] {
  const hay = " " + normalizeEntity(text) + " ";
  return registry.filter((n) => {
    const t = [...entityTokens(n)].join(" ");
    return t !== "" && hay.includes(" " + t + " ");
  });
}

export function createOwnerGate(opts: { clientNames?: string[] } = {}): Gate {
  const clients = (opts.clientNames ?? []).map((n) => n.trim()).filter(Boolean);
  return {
    name: "owner",
    preTool(_s, call) {
      if (!isOwnerTool(call.name)) return undefined;
      const action = typeof call.args.action === "string" ? call.args.action.toLowerCase() : "";
      if (READ_ACTIONS.has(action)) return undefined;
      const parsed = parseOwnerCheck(call.args.owner_check);
      if (!parsed || !sameSet(parsed.a, parsed.b)) return { gate: "owner", action: "block", reason: FAIL };
      if (clients.length === 0) return undefined;

      const all: { key: string; text: string }[] = [];
      strings(call.args, all);
      const target = all.filter((x) => TARGET_KEYS.has(x.key)).map((x) => x.text).join("\n");
      const everything = all.map((x) => x.text).join("\n");
      const ownerIsOurs = names([...parsed.a].join(" "), OWN_NAMES).length > 0;
      const ownerClients = names([...parsed.a].join(" "), clients);

      if (ownerIsOurs) {
        const hit = names(everything, clients);
        if (hit.length) {
          return { gate: "owner", action: "block", reason: `owner check says Astra AI (ours) but this write names client '${hit[0]}': client material is never filed as ours; fix owner_check or the content` };
        }
      } else if (ownerClients.length) {
        const otherClient = names(target, clients).filter((c) => !ownerClients.includes(c));
        const ours = names(target, OWN_NAMES);
        if (ours.length || otherClient.length) {
          const what = ours.length ? ours[0] : otherClient[0];
          return { gate: "owner", action: "block", reason: `owner check says client '${ownerClients[0]}' but the target names '${what}': never file one owner's material under another's name` };
        }
      }
      return undefined;
    },
  };
}

export const ownerGate: Gate = createOwnerGate();
