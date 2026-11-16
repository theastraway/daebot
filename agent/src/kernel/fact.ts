// The fact gate: before the FIRST edit of a file in a turn, the model must have gathered facts about it (read it, grepped for its
// importers or callers, looked at the tests beside it). A first write_file/edit_file to a file the turn has not looked at is refused
// with the questions that would have caught the usual traps; the retry, after the reads, goes through. This is ECC's GateGuard idea
// (deny, force the questions, allow the retry) as a kernel gate; its effect is measured in src/eval/fact against a placebo that denies
// the same call with no questions. Modes (DAEBOT_FACT_GATE): off (default), shadow, enforce. Desktop only in practice: hosted sessions
// have no file tools. Creating a new file is never gated; the questions are about changing what exists.
import type { Gate, GateVerdict, ToolCall, TurnState } from "../types.ts";

export type FactGateMode = "off" | "shadow" | "enforce";
export function factGateMode(env: Record<string, string | undefined> = process.env): FactGateMode {
  const v = (env.DAEBOT_FACT_GATE ?? "").trim().toLowerCase();
  if (v === "enforce" || v === "on" || v === "1") return "enforce";
  if (v === "shadow") return "shadow";
  return "off";
}

const EDIT_TOOLS = new Set(["write_file", "edit_file"]);
const READ_TOOLS = new Set(["read_file", "grep", "glob", "bash"]);

const base = (p: string): string => p.replace(/\\/g, "/").split("/").pop() ?? "";
const stem = (p: string): string => base(p).replace(/\.[^.]+$/, "");

/** The questions, by what the target looks like. Each one names a concrete fact to go and get, never "are you sure". */
export function factQuestions(path: string): string[] {
  const b = base(path).toLowerCase();
  const data = /\.(csv|tsv|json|ya?ml|xml|toml|ini|env|properties)$/.test(b);
  const config = /^(\.env|.*\.config\.|.*rc$|.*\.(toml|ini|yaml|yml)$|package\.json$|tsconfig)/.test(b);
  const test = /\.(test|spec)\./.test(b) || /__tests__|\/tests?\//.test(path.replace(/\\/g, "/"));
  if (config) return [
    "Who reads this config and which keys do they rely on (grep the key names)?",
    "Does any value here belong in a secret store (an API key, a token, a password)? If so it is referenced, never written in.",
  ];
  if (data) return [
    "What is the exact shape of this data: separators, quoting, date and number formats, and does the whole file follow it or only the first rows?",
    "Who reads this file (grep its name across the repo) and what fields or columns do they rely on?",
  ];
  if (test) return [
    "What does the test under test actually do today (read the implementation), and is the test pinning a value you are about to change?",
  ];
  return [
    `Who imports this module (grep for "${stem(path)}" across the repo) and which exported names or return shapes do they rely on?`,
    "Which functions in the same file call what you are changing (local callers), and will they still get the shape they expect?",
    `Is there an existing helper that already does this (grep for the verb and the noun of the task before adding a duplicate)?`,
    `Which tests cover this file (glob for ${stem(path)}.test.* or spec.*), and does one of them pin the behaviour you are changing?`,
  ];
}

/** Did this turn gather facts about the path: read it, grepped for its stem, globbed near it, or ran a command that names it? */
export function factsGathered(calls: readonly { tool: string; call: { args: Record<string, unknown> } }[], path: string): boolean {
  const b = base(path).toLowerCase();
  const st = stem(path).toLowerCase();
  if (!b) return false;
  for (const c of calls) {
    if (!READ_TOOLS.has(c.tool)) continue;
    const a = c.call.args ?? {};
    const text = [a.path, a.pattern, a.command, a.cwd, a.dir].filter((x): x is string => typeof x === "string").join(" ").toLowerCase();
    if (text.includes(b) || (st.length >= 3 && text.includes(st))) return true;
  }
  return false;
}

export function createFactGate(o: { mode: FactGateMode; exists: (path: string) => boolean; placebo?: boolean }): Gate {
  const asked = new Set<string>(); // "<turn>|<path>": asked once per file per turn; the retry after the reads is the point
  return {
    name: o.placebo ? "fact-placebo" : "fact",
    preTool(s: TurnState, call: ToolCall, tool): GateVerdict | undefined {
      if (o.mode === "off" || !EDIT_TOOLS.has(tool.spec.name)) return undefined;
      const path = typeof call.args?.path === "string" ? call.args.path : "";
      if (!path || !o.exists(path)) return undefined;
      const key = `${s.turnIndex}|${path}`;
      if (asked.has(key)) return undefined;
      if (factsGathered(s.calls, path)) return undefined;
      asked.add(key);
      const reason = o.placebo
        ? `first edit of ${base(path)} this turn: stop and think it over once more, then retry if you are sure.`
        : `first edit of ${base(path)} this turn without looking at it. Get these facts first (read_file, grep, glob), then retry: ${factQuestions(path).map((q, i) => `(${i + 1}) ${q}`).join(" ")}`;
      const v: GateVerdict = { gate: o.placebo ? "fact-placebo" : "fact", action: "block", reason };
      // Shadow is the kernel's job (it downgrades blocks to logged allows); the gate itself only ever answers block.
      return v;
    },
  };
}
