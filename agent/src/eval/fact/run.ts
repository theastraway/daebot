// The fact gate eval: the six trap scenarios on three arms (off, placebo, fact), scripted model, real loop and kernel.
// A scenario passes on an arm when the edit landed with the facts gathered first. The gate earns its place only when `fact`
// beats `placebo` (a refusal with no questions): otherwise the gain comes from stopping the agent, not from what it is asked.
// This offline run measures whether the questions are asked and followed; the quality effect needs live sessions (ECC ran 72).
//   node src/eval/fact/run.ts
import { createAgentSession } from "../../loop.ts";
import { createKernel } from "../../kernel/index.ts";
import { createFactGate } from "../../kernel/fact.ts";
import { ScriptedProvider } from "../provider.ts";
import { createFakeTools } from "../tools.ts";
import { makeEnv, dropEnv } from "../runner.ts";
import type { ExecLog } from "../tools.ts";
import type { Config, Gate, SessionSync } from "../../types.ts";
import { FACT_FILES, FACT_SCENARIOS, editedInformed } from "./scenarios.ts";

export type FactArm = "off" | "placebo" | "fact";
export const FACT_ARMS: FactArm[] = ["off", "placebo", "fact"];

const nullSync: SessionSync = { async open() {}, async append() {}, async pendingReplies() { return []; }, async close() {} };
const cfg: Config = { mindBaseUrl: "https://example.invalid", mindApiKey: "k", openrouterKey: "k", models: { default: "m", cheap: "m", fallback: [] }, shadow: false, kernel: true };

export interface FactArmResult { arm: FactArm; passed: number; total: number; refusals: number; perScenario: Record<string, boolean> }
export interface FactEval { arms: FactArmResult[]; verdict: "ship" | "do-not-ship" | "inconclusive" }

export async function runFactEval(opts: { extraGates?: (arm: FactArm) => Gate[] } = {}): Promise<FactEval> {
  const arms: FactArmResult[] = [];
  for (const arm of FACT_ARMS) {
    const res: FactArmResult = { arm, passed: 0, total: 0, refusals: 0, perScenario: {} };
    for (const sc of FACT_SCENARIOS) {
      const env = makeEnv();
      const log: ExecLog = { records: [], turn: 0 };
      const provider = new ScriptedProvider();
      const exists = (p: string) => FACT_FILES.some((f) => p.endsWith(f));
      const gates: Gate[] = arm === "off" ? [] : [createFactGate({ mode: "enforce", exists, placebo: arm === "placebo" })];
      const kernel = createKernel({ shadow: false, enabled: true, isolation: { enabled: false }, extraGates: [...gates, ...(opts.extraGates?.(arm) ?? [])] });
      const session = createAgentSession({ id: `fact-${sc.id}-${arm}`, surface: "headless", provider, kernel, tools: createFakeTools(log, sc.outputs), sync: nullSync, cfg, cwd: env.scratch, systemPrompt: "eval", bootContext: "MIND boot context" });
      try {
        for (const t of sc.turns(env)) {
          provider.setTurn(t.steps);
          for await (const ev of session.send(t.user)) { if (ev.type === "gate" && (ev.verdict.gate === "fact" || ev.verdict.gate === "fact-placebo")) res.refusals++; }
        }
      } finally { dropEnv(env); }
      const name = sc.id.replace(/^F0\d-/, "");
      const file = FACT_FILES.find((f) => sc.title.includes(f.split("/").pop()!.replace(/\.[^.]+$/, "")) ) ?? "";
      const ok = sc.recovered ? sc.recovered({ exec: log.records } as any) : editedInformed({ exec: log.records }, file.split("/").pop() ?? "");
      res.perScenario[name] = ok;
      res.total++;
      if (ok) res.passed++;
    }
    arms.push(res);
  }
  const by = Object.fromEntries(arms.map((a) => [a.arm, a.passed / Math.max(1, a.total)])) as Record<FactArm, number>;
  const verdict: FactEval["verdict"] = by.fact > by.placebo && by.fact > by.off ? "ship" : by.fact <= by.off ? "do-not-ship" : "inconclusive";
  return { arms, verdict };
}

export function renderFactEval(r: FactEval): string {
  const lines = ["fact gate eval (scripted model; passes = edit landed after the facts were gathered)"];
  for (const a of r.arms) lines.push(`  ${a.arm.padEnd(8)} ${a.passed}/${a.total} passed, ${a.refusals} refusals  ${Object.entries(a.perScenario).map(([k, v]) => `${v ? "ok" : "MISS"}:${k}`).join(" ")}`);
  lines.push(`verdict: ${r.verdict} (ship only when fact beats placebo and off; published either way)`);
  return lines.join("\n");
}

if (process.argv[1] && /fact\/run\.ts$/.test(process.argv[1])) {
  const r = await runFactEval();
  process.stdout.write(renderFactEval(r) + "\n");
}
