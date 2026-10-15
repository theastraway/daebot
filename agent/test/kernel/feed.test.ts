import { test } from "node:test";
import assert from "node:assert/strict";
import { feedGate } from "../../src/kernel/feed.ts";
import { createKernel } from "../../src/kernel/index.ts";
import { call, state, tool } from "./helpers.ts";

const pub = tool("feed_post", "public");

test("feed: blocks public tool without intent", () => {
  const v = feedGate.preTool!(state({ userMessage: "log what you did" }), call("feed_post"), pub);
  assert.equal(v?.action, "block");
});
test("feed: allows when user says post/share/tweet/feed", () => {
  for (const m of ["post this", "please share it", "Tweet that", "put it on the feed"]) {
    assert.equal(feedGate.preTool!(state({ userMessage: m }), call("feed_post"), pub), undefined, m);
  }
});
test("feed: word boundary (posting-adjacent words do not match)", () => {
  const v = feedGate.preTool!(state({ userMessage: "check the postgres sharedlib feedback" }), call("feed_post"), pub);
  assert.equal(v?.action, "block");
});
test("feed: non-public tool unaffected", () => {
  assert.equal(feedGate.preTool!(state(), call("mind_query"), tool("mind_query")), undefined);
});
test("feed: allowedTools hides public tools", () => {
  const k = createKernel({ shadow: false, enabled: true });
  const all = [pub, tool("mind_query")];
  assert.deepEqual(k.allowedTools(state(), all).map((t) => t.spec.name), ["mind_query"]);
  assert.equal(k.allowedTools(state({ userMessage: "tweet it" }), all).length, 2);
});
