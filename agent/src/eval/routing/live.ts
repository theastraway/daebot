// Live routing eval: the production model, the real prompt and tool specs, N samples per prompt, first tool call only.
//   MIND_API_KEY=mind_... node src/eval/routing/live.ts [--samples 3] [--model qwen/qwen3.8-flash] [--only R05] [--label before]
// (also reachable as: node src/eval/run.ts --routing ...). Model calls go through MIND with that key, like a hosted user's.
import { loadConfig } from "../../config.ts";
import { MindCredits, createMindProvider } from "../../provider/mind.ts";
import { createOpenRouterProvider } from "../../provider/openrouter.ts";
import { desktopTools, firstChoice, passes } from "./harness.ts";
import { ROUTING_SCENARIOS } from "./scenarios.ts";
import type { Config } from "../../types.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export async function main(): Promise<void> {
  const orKey = process.env.OPENROUTER_API_KEY ?? "";
  const key = process.env.MIND_API_KEY ?? "";
  if (!key && !orKey) { console.error("set OPENROUTER_API_KEY (direct) or MIND_API_KEY (billed through MIND like a hosted user)"); process.exitCode = 2; return; }
  const samples = Math.max(1, Number(arg("--samples") ?? 3));
  const cfg: Config = loadConfig({ ...process.env, MIND_API_KEY: key, OPENROUTER_API_KEY: orKey, HOME: "/nonexistent" });
  const model = arg("--model") ?? cfg.models.default;
  const only = arg("--only");
  const provider = orKey ? createOpenRouterProvider(cfg) : createMindProvider(cfg, { getKey: () => key, credits: new MindCredits({ mindBaseUrl: cfg.mindBaseUrl }) });
  const tools = desktopTools();
  let pass = 0, total = 0;
  const rows: string[] = [];
  for (const s of ROUTING_SCENARIOS.filter((x) => !only || x.id.includes(only))) {
    const picks: string[] = [];
    let ok = 0;
    for (let i = 0; i < samples; i++) {
      let c;
      try { c = await firstChoice(provider, model, s.prompt, tools, true); } catch (e) { picks.push(`ERR(${String((e as Error)?.message ?? e).slice(0, 60)})`); total++; continue; }
      total++;
      picks.push(c.tool ?? "(no tool)");
      if (passes(s, c)) { ok++; pass++; }
    }
    rows.push(`${ok === samples ? "PASS" : ok === 0 ? "FAIL" : "PART"}  ${s.id.padEnd(22)} ${ok}/${samples}  first tool: ${picks.join(", ")}`);
  }
  console.log(`routing eval ${arg("--label") ?? ""} model=${model} samples=${samples}`);
  for (const r of rows) console.log(r);
  console.log(`ROUTING ${pass}/${total} first-tool choices correct`);
}

if (process.argv[1] && process.argv[1].endsWith("live.ts")) await main();
