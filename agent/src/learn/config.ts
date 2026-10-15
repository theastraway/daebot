// Learning is on when MINDCLAW_LEARNING=1, or by default in hosted mode (unless MINDCLAW_LEARNING=0).
export interface LearnConfig {
  enabled: boolean;
  user: string;                 // username the per-user model is filed under
  maxInjectChars: number;       // ~600 tokens at ~4 chars/token
  maxReflectionsPerSession: number;
  beforeTurnTimeoutMs: number;
  closeTimeoutMs: number;
  minUsesToJudge: number;       // demotion needs at least this many judged uses
  demoteRatio: number;          // hurt / (helped + hurt) at or above this demotes
  retireHurt: number;           // hurt count at or above this (with ratio >= retireRatio) retires
  retireRatio: number;
  dedupeJaccard: number;
  halfLifeDays: number;         // staleness decay in ranking
}

export const DEFAULTS: Omit<LearnConfig, "enabled" | "user"> = {
  maxInjectChars: 2400,
  maxReflectionsPerSession: 6,
  beforeTurnTimeoutMs: 4000,
  closeTimeoutMs: 8000,
  minUsesToJudge: 3,
  demoteRatio: 0.5,
  retireHurt: 5,
  retireRatio: 0.6,
  dedupeJaccard: 0.5,
  halfLifeDays: 120,
};

export function resolveLearnConfig(env: NodeJS.ProcessEnv = process.env, o: { hosted?: boolean } = {}): LearnConfig {
  const v = (env.MINDCLAW_LEARNING ?? "").trim().toLowerCase();
  const enabled = v === "" ? !!o.hosted : /^(1|true|yes|on)$/.test(v);
  const user = (env.MINDCLAW_LEARN_USER ?? "anthony").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "") || "anthony";
  return { enabled, user, ...DEFAULTS };
}
