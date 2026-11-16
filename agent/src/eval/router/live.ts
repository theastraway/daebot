// Live router eval: the labelled scenarios replayed through the real provider on three arms (fixed light, fixed frontier, router),
// measuring cost per completed turn (a turn completes when it ends with a final answer and no unverified footer). This is the gate for
// turning the router from shadow to enforce. Needs a key; nothing runs without one.
//   OPENROUTER_API_KEY=... node src/eval/router/live.ts [--only typo] [--samples 1]
import { loadConfig } from "../../config.ts";
import { createOpenRouterProvider } from "../../provider/openrouter.ts";
import { DEFAULT_POLICY } from "../../provider/policy.ts";
import { routeTurn } from "../../provider/router.ts";
import { UNVERIFIED_FOOTER } from "../../loop.ts";
import type { Config, Message, Provider, StreamEvent } from "../../types.ts";
import { ROUTER_SCENARIOS } from "./scenarios.ts";

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }

export interface ArmResult { arm: string; turns: number; completed: number; costUsd: number; costPerCompleted: number }

async function oneTurn(provider: Provider, model: string, prompt: string, effort?: "low" | "medium" | "high"): Promise<{ text: string; costUsd: number }> {
  const messages: Message[] = [{ role: "system", content: "You are Daebot. Answer the user briefly. Claims of done or numbers need a receipt line (MIND✓ #cN ...) or they are guesses: say so." }, { role: "user", content: prompt }];
  let text = "", costUsd = 0;
  for await (const ev of provider.stream({ model, messages, tools: [], ...(effort ? { effort } : {}) }) as AsyncIterable<StreamEvent>) {
    if (ev.type === "text") text += ev.delta;
    if (ev.type === "done") costUsd = ev.usage.costUsd;
  }
  return { text, costUsd };
}

export async function main(): Promise<void> {
  const key = process.env.OPENROUTER_API_KEY ?? "";
  if (!key) { console.error("set OPENROUTER_API_KEY to run the live router eval"); process.exitCode = 2; return; }
  const cfg: Config = loadConfig({ ...process.env, OPENROUTER_API_KEY: key, HOME: "/nonexistent" });
  const provider = createOpenRouterProvider(cfg);
  const only = arg("--only");
  const samples = Math.max(1, Number(arg("--samples") ?? 1));
  const scenarios = ROUTER_SCENARIOS.filter((s) => !only || s.id.includes(only));
  const arms: Record<string, (s: (typeof scenarios)[number]) => { model: string; effort?: "low" | "medium" | "high" }> = {
    "fixed:light": () => ({ model: DEFAULT_POLICY.light.model }),
    "fixed:frontier": () => ({ model: DEFAULT_POLICY.frontier.model, effort: DEFAULT_POLICY.frontier.effort }),
    router: (s) => { const d = routeTurn({ message: s.message, canBuild: s.canBuild ?? true, mode: "enforce", policy: DEFAULT_POLICY })!; return { model: d.model, effort: d.effort }; },
  };
  const results: ArmResult[] = [];
  for (const [arm, pick] of Object.entries(arms)) {
    const r: ArmResult = { arm, turns: 0, completed: 0, costUsd: 0, costPerCompleted: 0 };
    for (const s of scenarios) for (let i = 0; i < samples; i++) {
      const p = pick(s);
      try {
        const t = await oneTurn(provider, p.model, s.message, p.effort);
        r.turns++; r.costUsd += t.costUsd;
        if (t.text.trim() && !t.text.includes(UNVERIFIED_FOOTER)) r.completed++;
      } catch (e) { r.turns++; console.error(`${arm} ${s.id}: ${String((e as Error)?.message ?? e).slice(0, 80)}`); }
    }
    r.costPerCompleted = r.completed ? r.costUsd / r.completed : Infinity;
    results.push(r);
  }
  console.log("live router eval (cost per completed turn, USD)");
  for (const r of results) console.log(`  ${r.arm.padEnd(16)} ${r.completed}/${r.turns} completed, $${r.costUsd.toFixed(4)} total, $${Number.isFinite(r.costPerCompleted) ? r.costPerCompleted.toFixed(4) : "n/a"} per completed`);
}

if (process.argv[1] && /router\/live\.ts$/.test(process.argv[1])) await main();
