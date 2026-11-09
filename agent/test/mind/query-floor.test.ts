import { test } from "node:test";
import assert from "node:assert/strict";
import { createMindTools, MIND_QUERY_MIN_TOKENS } from "../../src/mind/tools.ts";
import type { MindClient } from "../../src/types.ts";

function capture() {
  const seen: (number | undefined)[] = [];
  const c = { query: async (_q: string, o?: { maxContextTokens?: number }) => { seen.push(o?.maxContextTokens); return "ok"; } } as unknown as MindClient;
  const tool = createMindTools(c).find((t) => t.spec.name === "mind_query")!;
  return { seen, tool };
}

test("mind_query: the model cannot shrink the context budget below the default", async () => {
  const { seen, tool } = capture();
  const ctx = { cwd: "/", sessionId: "s" } as any;
  await tool.run({ query: "what is MIND?", max_context_tokens: 2500 }, ctx);
  await tool.run({ query: "what is MIND?" }, ctx);
  await tool.run({ query: "what is MIND?", max_context_tokens: 12000 }, ctx);
  assert.equal(MIND_QUERY_MIN_TOKENS, 4000);
  assert.deepEqual(seen, [4000, 4000, 12000]);
});
