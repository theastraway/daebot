// Builds the REAL system prompt and the REAL tool specs a desktop Daebot session offers, sends one user message to a provider,
// and returns the first tool the model chose. Nothing is executed. Used by the live routing eval and by the offline unit test.
import { composeSystemPrompt } from "../../runtime.ts";
import { createBuiltinTools } from "../../tools/index.ts";
import { createMindTools } from "../../mind/tools.ts";
import { createAppTools } from "../../mind/apps-tools.ts";
import type { MindClient } from "../../types.ts";
import type { Provider, StreamEvent, Tool, ToolSpec } from "../../types.ts";
import type { RoutingScenario } from "./scenarios.ts";

export function desktopTools(): Tool[] {
  const client = {} as MindClient; // only the specs are read; no tool is ever run
  return [
    ...createBuiltinTools({ computer: true }),
    ...createMindTools({ home: "main", roster: () => [], clientFor: () => client }, { user: "Anthony" }),
    ...createAppTools({ clientFor: () => client }),
  ];
}

export function promptFor(tools: Tool[]): string {
  return composeSystemPrompt({
    tier: "admin", bootContext: "", surface: "desktop", cwd: "/Users/anthony", model: "qwen/qwen3.8-flash",
    toolNames: tools.map((t) => t.spec.name),
  } as Parameters<typeof composeSystemPrompt>[0]);
}

export interface FirstChoice { tool?: string; args?: Record<string, unknown>; text: string }

export async function firstChoice(provider: Provider, model: string, prompt: string, tools: Tool[], pin = false): Promise<FirstChoice> {
  const specs: ToolSpec[] = tools.map((t) => t.spec);
  let text = "";
  let tool: string | undefined;
  let args: Record<string, unknown> | undefined;
  for await (const ev of provider.stream({ model, pinModel: pin, tools: specs, messages: [{ role: "system", content: promptFor(tools) }, { role: "user", content: prompt }] }) as AsyncIterable<StreamEvent>) {
    if (ev.type === "text") text += ev.delta;
    if (ev.type === "toolCall" && !tool) { tool = ev.call.name; args = ev.call.args; }
  }
  return { tool, args, text };
}

export function passes(s: RoutingScenario, c: FirstChoice): boolean {
  return !!c.tool && s.allow.includes(c.tool);
}
