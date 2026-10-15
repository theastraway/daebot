// Types for the learning module. Erasable TypeScript only. Nothing here touches src/types.ts.
import type { CallRecord, Violation } from "../types.ts";

export type LessonKind = "failure" | "win" | "behavior";
export type Status = "active" | "demoted" | "retired";

// Outcome counters shared by lessons and skills.
export interface Counters { uses: number; helped: number; hurt: number }

export interface Lesson extends Counters {
  type: "lesson";
  key: string;            // 6 hex chars, stable across revisions. Cited as L-<key>.
  rev: number;
  kind: LessonKind;
  status: Status;
  title: string;          // `Lesson - Failure - <behavior>`
  trigger: string;
  behavior: string;
  rule: string;
  evidence: string[];     // newest last, capped
  created: string;        // YYYY-MM-DD
  updated: string;
  mindId?: string;        // id returned by MIND when THIS process wrote the revision
  supersedes?: string;
}

export interface Skill extends Counters {
  type: "skill";
  key: string;            // cited as S-<key>
  rev: number;
  status: Status;
  name: string;           // slug
  title: string;          // `Skill - <name>`
  description: string;
  preconditions: string[];
  steps: string[];
  tools: string[];
  successes: number;
  failures: number;
  created: string;
  updated: string;
  mindId?: string;
  supersedes?: string;
}

export interface UserPref { area: string; statement: string; since: string }
export interface UserModel { user: string; rev: number; prefs: UserPref[]; updated: string; mindId?: string }

export type Item = Lesson | Skill;

export type TriggerKind = "kernel_block" | "tool_failure" | "user_correction" | "multi_step_success";
export interface Trigger { kind: TriggerKind; detail: string }

// What the loop hands the learning layer after a turn.
export interface TurnSummary {
  sessionId: string;
  userMessage: string;
  finalText: string;
  userHistory: string[];        // earlier user messages of this session, oldest first
  calls: CallRecord[];          // executed calls of this turn
  violations: Violation[];      // kernel violations recorded during this turn
  failed: boolean;              // the turn errored out
}

export interface LearnHooks {
  /** Returns the "What you learned before" system note for this user message (or undefined). Never throws, bounded in time. */
  beforeTurn(userMessage: string): Promise<string | undefined>;
  /** Fire and forget. Never throws, never blocks. */
  afterTurn(summary: TurnSummary): void;
  /** Resolve once all in-flight reflections and writes are done. */
  idle(): Promise<void>;
  /** Called on session close: settles outcomes and persists counters. Bounded in time. */
  close(): Promise<void>;
}

export interface ReflectionResult {
  lesson?: { kind: LessonKind; trigger: string; behavior: string; rule: string; evidence: string };
  skill?: { name: string; description: string; preconditions: string[]; steps: string[]; tools: string[] };
  userPrefs?: { area: string; statement: string }[];
}
