// Coder safety gate: three things an agent under pressure does that a careful engineer does not.
//   1. Weakening a lint or format config so a check passes (the fix belongs in the code): an edit to an EXISTING protected config file
//      needs the user's explicit go, like an outward action. Creating one from scratch is fine.
//   2. Skipping git hooks (--no-verify, -n on commit/push/merge, core.hooksPath=, GIT_CONFIG_* redirects) or force-pushing: blocked.
//      --force-with-lease is allowed; the hooks run or the change waits.
//   3. A secret-looking token in a tool argument (a command line, a file write, a message): blocked. Secrets are read from the
//      environment or a MIND secure document at the moment of use, never typed into a command or a file by the model.
// The protected-config list and the hook-bypass idea follow affaan-m/ECC's config-protection and block-no-verify hooks (MIT; concepts,
// the list is data). Everything here fails closed on its own checks and open on malformed input (a bad arg shape is not a reason to block).
import { existsSync } from "node:fs";
import type { Gate, GateVerdict, ToolCall, TurnState } from "../types.ts";
import { SECRET } from "../learn/guard.ts";
import { callSignature } from "./util.ts";

/** Lint and format configs an agent is tempted to loosen instead of fixing the code (basenames). */
export const PROTECTED_CONFIGS: ReadonlySet<string> = new Set([
  ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml",
  "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts", "eslint.config.cts",
  ".prettierrc", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.json", ".prettierrc.yml", ".prettierrc.yaml",
  "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs",
  "biome.json", "biome.jsonc", ".ruff.toml", "ruff.toml", ".shellcheckrc",
  ".stylelintrc", ".stylelintrc.json", ".stylelintrc.yml",
  ".markdownlint.json", ".markdownlint.yaml", ".markdownlintrc",
  "tsconfig.json", "tsconfig.base.json", "pyrightconfig.json", "mypy.ini", ".flake8", "setup.cfg", "lint-ratchet-baseline.json",
]);

const EDIT_TOOLS = new Set(["write_file", "edit_file"]);
const SECRET_ARG_TOOLS = new Set(["bash", "process", "terminal", "write_file", "edit_file", "bot_talk", "send_email", "mind_remember", "web_fetch"]);
const GIT_PROTECTED = new Set(["commit", "push", "merge", "cherry-pick", "rebase", "am"]);

const basename = (p: string): string => p.replace(/\\/g, "/").split("/").pop() ?? "";

/** The git subcommands in a shell command and whether any carries a hook bypass or a plain force push. Pure text scan, deliberately simple. */
export function gitBypass(command: string): string | undefined {
  const text = String(command ?? "");
  if (/\bGIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)=/.test(text)) return "GIT_CONFIG_* overrides can redirect git hooks";
  for (const seg of text.split(/\s*(?:&&|\|\||;|\|)\s*/)) {
    const toks = seg.trim().split(/\s+/).filter(Boolean);
    const gi = toks.findIndex((t) => /^(?:.*\/)?git(?:\.exe)?$/i.test(t));
    if (gi < 0) continue;
    const rest = toks.slice(gi + 1);
    // `git -c core.hooksPath=... <cmd>` and `git -c include.path=...`
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "-c" && /^(?:core\.hookspath|include\.path|includeif\..*\.path)=/i.test(rest[i + 1] ?? "")) return "git -c core.hooksPath redirects the hooks";
      if (/^-c(?:core\.hookspath|include\.path)=/i.test(rest[i])) return "git -c core.hooksPath redirects the hooks";
    }
    const sub = rest.find((t) => !t.startsWith("-"));
    if (!sub) continue;
    if (GIT_PROTECTED.has(sub)) {
      const after = rest.slice(rest.indexOf(sub) + 1);
      for (const t of after) {
        if (t.length >= "--no-v".length && "--no-verify".startsWith(t)) return `git ${sub} ${t} skips the hooks`;
        // A short cluster: -n anywhere means --no-verify, unless a value-taking option (m F C c t) or an optional-value one (u S) came first and swallowed the rest.
        if (/^-[a-zA-Z]+$/.test(t) && t.includes("n") && !/[mFCctuS]/.test(t.slice(1, t.indexOf("n")))) return `git ${sub} ${t} skips the hooks (-n)`;
        if (t === "--no-gpg-sign") continue;
      }
      if (sub === "push" && after.some((t) => t === "--force" || t === "-f" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(t)) && !after.some((t) => t.startsWith("--force-with-lease"))) return "git push --force rewrites shared history; use --force-with-lease, and only with the user's go";
    }
  }
  return undefined;
}

/** The strings in a tool call's arguments that could carry a secret (commands, file contents, messages). */
function argText(args: Record<string, unknown>): string {
  const parts: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 3) return;
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
  };
  walk(args, 0);
  return parts.join("\n");
}

export function createCoderSafetyGate(o: { exists?: (path: string) => boolean; cwd?: string } = {}): Gate {
  const exists = o.exists ?? ((p: string) => { try { return existsSync(p); } catch { return false; } });
  const resolveIn = (p: string): string => (/^(?:[A-Za-z]:)?[\\/]/.test(p) || !o.cwd ? p : `${o.cwd.replace(/[\\/]$/, "")}/${p}`);
  return {
    name: "coder-safety",
    preTool(s: TurnState, call: ToolCall, tool): GateVerdict | undefined {
      const args = call.args ?? {};
      const name = tool.spec.name;
      // 3. a secret in an argument
      if (SECRET_ARG_TOOLS.has(name) && SECRET.test(argText(args))) {
        return { gate: "coder-safety", action: "block", reason: `the arguments carry a secret-looking token. Never put a key or token in a command, a file or a message: read it from the environment ($VAR) or a MIND secure document at the moment of use.` };
      }
      // 2. git hook bypass or force push
      if (name === "bash" || name === "process" || name === "terminal") {
        const cmd = typeof args.command === "string" ? args.command : typeof args.text === "string" ? args.text : "";
        const why = cmd ? gitBypass(cmd) : undefined;
        if (why) return { gate: "coder-safety", action: "block", reason: `${why}. Let the hooks run and fix what they report; a hook you cannot satisfy is a question for the user, not a flag.` };
      }
      // 1. loosening a protected config
      if (EDIT_TOOLS.has(name) && typeof args.path === "string") {
        const base = basename(args.path);
        if (PROTECTED_CONFIGS.has(base) && exists(resolveIn(args.path))) {
          const sig = callSignature(call.name, args);
          const mine = s.confirmations.filter((c) => c.forCallSignature === sig);
          const usable = mine.find((c) => !c.used && c.grantedAtUserMsg !== undefined && c.grantedAtUserMsg > c.proposedAtUserMsg);
          if (usable) { usable.used = true; return undefined; }
          if (!mine.some((c) => c.grantedAtUserMsg === undefined)) s.confirmations.push({ forCallSignature: sig, proposedAtUserMsg: s.userMessageIndex });
          return { gate: "coder-safety", action: "needs-confirmation", reason: `${base} is a lint or format config: weakening a check is not a fix. Fix the code it complains about; if the config really must change, tell the user why and they can say 'do it'.` };
        }
      }
      return undefined;
    },
  };
}
