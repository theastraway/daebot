// DEV ONLY. The REAL gateway + runtime + bot routes + bus, with a scripted provider and the fake MIND server (test/gateway/fake-mind.ts),
// so the web UI can be driven end to end without any network. Run: DAEBOT_BOTS_ENABLED=1 node test/dev/serve-bots.ts
//   scripted model: "ask <slug> <question>" -> calls bot_talk; a peer message gets a canned answer; anything else a short hello.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../../src/gateway/index.ts";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { loadConfig } from "../../src/config.ts";
import { startFakeMind } from "../gateway/fake-mind.ts";
import type { Message, Provider, StreamEvent } from "../../src/types.ts";

const key = "mind_devkey_" + Math.random().toString(36).slice(2, 14);
const fake = await startFakeMind({ [key]: "pat" });
fake.models = [
  { id: "qwen/qwen3.8-flash", name: "Qwen 3.8 Flash", tier: "budget", input_cost_per_million: 0.1, output_cost_per_million: 0.4 } as never,
  { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron 3 Super (free)", tier: "free" },
  { id: "mind/steady-1", name: "Steady 1", tier: "standard", input_cost_per_million: 0.3, output_cost_per_million: 1.2 } as never,
];
const lastUser = (m: Message[]) => [...m].reverse().find((x) => x.role === "user")?.content ?? "";
const provider: Provider = {
  name: "scripted",
  async *stream(req): AsyncGenerator<StreamEvent> {
    const last = req.messages.at(-1)!;
    const usage = { promptTokens: 10, completionTokens: 5, costUsd: 0 };
    const say = function* (t: string): Generator<StreamEvent> { yield { type: "text", delta: t }; yield { type: "done", usage, finishReason: "stop", model: req.model }; };
    if (last.role === "tool" && last.name === "bot_talk") { yield* say(`They answered: ${last.content.split("\n").filter((l) => l.startsWith("> ")).join(" ").replace(/> /g, "")}`); return; }
    const u = lastUser(req.messages);
    const ask = /^ask ([a-z0-9-]+) (.+)/i.exec(u);
    if (last.role === "user" && ask) {
      yield { type: "toolCall", call: { id: "call_" + Date.now(), name: "bot_talk", args: { to: ask[1].toLowerCase(), message: ask[2] } } };
      yield { type: "done", usage, finishReason: "tool_calls", model: req.model };
      return;
    }
    if (u.startsWith("[message from")) { yield* say("Three open items; the oldest is 9 days. I would start with that one."); return; }
    yield* say("Hello. I am a scripted stand-in model, so this reply is canned.");
  },
};
const dir = mkdtempSync(join(tmpdir(), "daebot-dev-"));
const cfg = { ...loadConfig({}), mindBaseUrl: fake.base, mindApiKey: key, openrouterKey: "x", models: { default: "qwen/qwen3.8-flash", cheap: "qwen/qwen3.8-flash", fallback: [] } };
const bots = { dir, bus: {} };
const runtime = createRuntime(cfg, { provider, store: createFileStore(dir), bots });
const gw = await startGateway({ runtime, cfg, port: Number(process.env.PORT ?? 7790), bots, tokenPath: join(dir, "token") });
console.log(`DEV bots server (real routes, fake MIND, scripted model; DAEBOT_BOTS_ENABLED=${process.env.DAEBOT_BOTS_ENABLED ?? "unset"})\n  ${gw.url}/?token=${gw.token}`);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void gw.close().then(() => fake.close()).then(() => process.exit(0)));
