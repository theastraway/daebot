// Types for the compliance eval harness. A scenario replays a named historical agent failure
// against the REAL loop and the REAL kernel, with a scripted ("bad") model and fake tools.
import type { ToolResult, Violation } from "../types.ts";

export type Mode = "off" | "shadow" | "enforced";
export const MODES: Mode[] = ["off", "shadow", "enforced"];

export interface StepCall { name: string; args: Record<string, unknown> }

// One scripted model response (one provider.stream() call).
// onBlocked: if THIS step's output is refused by the kernel (tool result starting "blocked by" /
// "not executed", or a "[kernel:" system nudge on a withheld draft), the remaining script is dropped and
// these steps play instead (the model "recovers"). Without onBlocked the model is stubborn and
// continues with the main script (when exhausted it repeats its last text).
// Text and string args may contain {{id:<tool>}} = receipt id (e.g. c3) of the latest executed call of that tool this turn.
export interface Step { text?: string; calls?: StepCall[]; onBlocked?: Step[] }

export interface Turn { user: string; steps: Step[] }

// Temp-dir fixture the isolation gate is pointed at. Nothing here is a real path of the user.
export interface Env {
  root: string;
  githubRoot: string;      // stands in for ~/Documents/GitHub
  worktreesRoot: string;   // stands in for ~/.worktrees
  repoMain: string;        // <githubRoot>/proj  (has a .git DIRECTORY = main checkout)
  worktree: string;        // <worktreesRoot>/proj-topic (has a .git FILE = worktree)
  scratch: string;         // plain dir, not a repo
}

export interface ExecRecord { tool: string; args: Record<string, unknown>; turn: number; order: number; ok: boolean }

export type ToolOutput = string | ToolResult | ((args: Record<string, unknown>, nth: number) => string | ToolResult);

export interface GateEvent { turn: number; gate: string; action: string; reason: string; enforced: boolean }

export interface TurnResult { user: string; finalText: string; events: import("../types.ts").AgentEvent[] }

export interface RunResult {
  scenarioId: string;
  mode: Mode;
  turns: TurnResult[];
  exec: ExecRecord[];
  gateEvents: GateEvent[];
  violations: Violation[];
  finalTexts: string[];
  env: Env;
  providerRequests: number;
  error?: string;
}

export type Kind = "bad" | "legit" | "probe";

export interface Scenario {
  id: string;
  kind: Kind;
  title: string;
  cites: string;                 // the historical failure replayed (or, for legit, what normal behavior is covered)
  expected: string;              // the correct outcome in words
  clientNames?: string[];        // optional client registry handed to the kernel's semantic owner check
  bootContext?: string;          // default "MIND boot context". "" = session not booted.
  outputs?: Partial<Record<string, ToolOutput>>;
  turns: (env: Env) => Turn[];
  // bad / probe: gate expected to fire
  expectGate?: string;
  // bad / probe: did the historical bad outcome happen in this run?
  bad?: (r: RunResult) => boolean;
  // bad: did the corrected path happen (only meaningful when steps declare onBlocked)
  recovered?: (r: RunResult) => boolean;
  // legit: tools expected to have executed (subsequence) and optional extra assertion
  expectExec?: string[];
  // legit: interventions that ARE the correct behavior (e.g. the first half of a confirm flow); not counted as false positives
  allow?: Array<{ gate: string; action: string }>;
  legitOk?: (r: RunResult) => boolean;
}

export type Outcome = "CAUGHT" | "MISSED" | "FALSE-POSITIVE" | "OK" | "BROKEN";

export interface Classified {
  scenarioId: string;
  kind: Kind;
  mode: Mode;
  outcome: Outcome;
  note: string;
  badHappened?: boolean;
  gateFired?: boolean;
  recovered?: boolean;
  violationCount: number;
}
