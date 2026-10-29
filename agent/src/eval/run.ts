// node src/eval/run.ts [--only <id-substring>] [--seed N] [--no-write] [--raw <id>]
// Runs every scenario in kernel off / shadow / enforced and prints the compliance table.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, runScenario } from "./runner.ts";
import { passes, renderJson, renderMarkdown, renderSamples, renderText, sampleCaught, summaries } from "./report.ts";
import type { EvalData } from "./report.ts";
import { ALL_SCENARIOS } from "./scenarios/index.ts";
import { MODES } from "./types.ts";
import type { Classified, RunResult } from "./types.ts";

export async function evaluate(only?: string, seed = Date.now() % 100000): Promise<EvalData> {
  const scenarios = ALL_SCENARIOS.filter((s) => !only || s.id.includes(only));
  const rows: Classified[] = [];
  const runs: Record<string, RunResult> = {};
  for (const sc of scenarios) {
    for (const mode of MODES) {
      const r = await runScenario(sc, mode);
      runs[`${sc.id}:${mode}`] = r;
      rows.push(classify(sc, mode, r));
    }
  }
  return { generatedAt: new Date().toISOString(), rows, runs, scenarios, seed };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  if (process.argv.includes("--routing")) { await (await import("./routing/live.ts")).main(); return; }
  if (process.argv.includes("--learning")) {
    const { renderLearning, runLearningSuite } = await import("./learning/suite.ts");
    const { runChecks } = await import("./learning/checks.ts");
    const rep = await runLearningSuite();
    console.log(renderLearning(rep));
    const checks = await runChecks();
    console.log("\nsafety and robustness checks:");
    for (const c of checks) console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.id}: ${c.what} (${c.detail})`);
    const bad = checks.filter((c) => !c.pass).length;
    console.log(bad ? `\nLEARNING checks: ${bad} FAILED` : `\nLEARNING checks: ${checks.length}/${checks.length} PASS`);
    process.exitCode = rep.auditOk && !bad ? 0 : 1;
    return;
  }
  const only = arg("--only");
  const seedArg = arg("--seed");
  const data = await evaluate(only, seedArg ? Number(seedArg) : undefined);

  const raw = arg("--raw");
  if (raw) {
    for (const mode of MODES) {
      const r = data.runs[`${raw}:${mode}`];
      if (!r) continue;
      console.log(`\n##### RAW ${raw} [${mode}]`);
      console.log("exec:", JSON.stringify(r.exec.map((e) => `${e.turn}:${e.tool}`)));
      for (const t of r.turns) {
        console.log(`user: ${t.user}`);
        for (const e of t.events) console.log("  ", JSON.stringify(e).slice(0, 400));
      }
      console.log("violations:", JSON.stringify(r.violations.map((v) => ({ gate: v.gate, action: v.action, enforced: v.enforced, reason: v.reason })), null, 1));
    }
    return;
  }

  console.log(renderText(data));
  console.log("\n=== SAMPLED CAUGHT VERDICTS (enforced, seed " + data.seed + ") ===");
  console.log(renderSamples(sampleCaught(data)));

  if (!process.argv.includes("--no-write")) {
    const out = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "eval-out");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "eval-report.json"), renderJson(data));
    writeFileSync(join(out, "eval-report.md"), renderMarkdown(data));
    console.log(`\nwrote ${join(out, "eval-report.json")} and eval-report.md`);
  }
  const p = passes(summaries(data.rows));
  process.exitCode = p.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
