import { test } from "node:test";
import assert from "node:assert/strict";
import { SseParser, agentEventsFromStream, parseAgentEvent } from "../../src/ui/sse.ts";

test("parses complete messages and ignores comments", () => {
  const p = new SseParser();
  const out = p.push(': open\n\ndata: {"type":"text","delta":"hi"}\n\n');
  assert.deepEqual(out, [{ event: undefined, data: '{"type":"text","delta":"hi"}', id: undefined }]);
});

test("chunks split mid-line, mid-field and across the blank line", () => {
  const p = new SseParser();
  const frame = 'data: {"type":"text","delta":"héllo"}\n\n';
  const got: string[] = [];
  for (const ch of frame) for (const m of p.push(ch)) got.push(m.data);
  assert.deepEqual(got, ['{"type":"text","delta":"héllo"}']);
});

test("CRLF line endings, including a CR/LF pair split across chunks", () => {
  const p = new SseParser();
  assert.deepEqual(p.push("data: a\r"), []);
  assert.deepEqual(p.push("\n\r\n").map((m) => m.data), ["a"]);
});

test("multi-line data joins with newline; event and id fields are captured", () => {
  const p = new SseParser();
  const [m] = p.push("event: custom\nid: 7\ndata: line1\ndata: line2\n\n");
  assert.deepEqual(m, { event: "custom", id: "7", data: "line1\nline2" });
});

test("a trailing message without a terminating blank line is delivered by end()", () => {
  const p = new SseParser();
  assert.deepEqual(p.push("data: tail"), []);
  assert.deepEqual(p.end().map((m) => m.data), ["tail"]);
});

test("parseAgentEvent validates type and ignores junk", () => {
  assert.deepEqual(parseAgentEvent('{"type":"done","finalText":"x"}'), { type: "done", finalText: "x" });
  assert.equal(parseAgentEvent("not json"), undefined);
  assert.equal(parseAgentEvent('{"type":"bogus"}'), undefined);
  assert.equal(parseAgentEvent("[1]"), undefined);
});

test("agentEventsFromStream decodes a byte stream split at arbitrary (even mid-UTF-8) boundaries", async () => {
  const text = ': open\n\n' + 'data: {"type":"text","delta":"snow ☃ man"}\n\n' + 'data: {"type":"done","finalText":"snow ☃ man"}\n\n';
  const bytes = new TextEncoder().encode(text);
  async function* chunks() { for (let i = 0; i < bytes.length; i += 7) yield bytes.slice(i, i + 7); }
  const evs = [];
  for await (const e of agentEventsFromStream(chunks())) evs.push(e);
  assert.deepEqual(evs.map((e) => e.type), ["text", "done"]);
  assert.equal((evs[0] as { delta: string }).delta, "snow ☃ man");
});
