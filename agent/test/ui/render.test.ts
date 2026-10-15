import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "../../src/types.ts";
import { ASCII, TranscriptRenderer, TurnFolder, buildStatus, composeLive, formatCost, layoutInput, summarizeArgs } from "../../src/ui/render.ts";
import type { Row } from "../../src/ui/render.ts";
import { stripAnsi, visibleWidth } from "../../src/ui/ansi.ts";
import { LiveScreen } from "../../src/ui/screen.ts";
import { newEditor, setEditorText } from "../../src/ui/input.ts";

function fold(events: AgentEvent[]): { rows: Row[]; folder: TurnFolder } {
  const folder = new TurnFolder(() => 1000);
  const rows: Row[] = [];
  for (const e of events) rows.push(...folder.handle(e));
  return { rows, folder };
}
const R = (color = false) => new TranscriptRenderer({ width: 70, color });
const plainLines = (r: TranscriptRenderer, rows: Row[]) => rows.flatMap((x) => r.push(x)).map(stripAnsi);

test("text events become assistant deltas; done flushes and ends the block", () => {
  const { rows } = fold([{ type: "text", delta: "Hello " }, { type: "text", delta: "world\n" }, { type: "done", finalText: "Hello world" }]);
  assert.deepEqual(rows.map((r) => r.kind), ["assistantDelta", "assistantDelta", "assistantEnd"]);
  const lines = plainLines(R(), rows);
  assert.deepEqual(lines, ["◆ Hello world"]);
});

test("done with no streamed text renders finalText", () => {
  const { rows } = fold([{ type: "done", finalText: "Answer." }]);
  assert.deepEqual(plainLines(R(), rows), ["◆ Answer."]);
});

test("toolStart is live-only; toolEnd produces a row and clears running", () => {
  const folder = new TurnFolder(() => 5);
  assert.deepEqual(folder.handle({ type: "toolStart", receiptId: "c1", tool: "read", args: { path: "a.ts" } }), []);
  assert.equal(folder.running.size, 1);
  const rows = folder.handle({ type: "toolEnd", receiptId: "c1", tool: "read", ok: true, preview: "12 lines\nmore" });
  assert.equal(folder.running.size, 0);
  assert.equal(rows.length, 1);
  assert.deepEqual(folder.toolLog.map((t) => t.receiptId), ["c1"]);
  const line = plainLines(R(), rows).join("\n");
  assert.match(line, /read\(path: "a\.ts"\) ✓ 12 lines \(\+1 lines\)/);
});

test("tool failure shows a fail mark; expand shows the full preview", () => {
  const row: Row = { kind: "tool", receiptId: "c2", tool: "bash", args: { command: "false" }, ok: false, preview: "line1\nline2\nline3" };
  const collapsed = plainLines(R(), [row]);
  assert.equal(collapsed.length, 1);
  assert.match(collapsed[0], /✗/);
  const r = new TranscriptRenderer({ width: 70, color: false, expand: true });
  const expanded = r.push(row).map(stripAnsi);
  assert.deepEqual(expanded.slice(1).map((l) => l.trim()), ["line1", "line2", "line3"]);
});

test("gate rows show gate name, reason and ENFORCED vs SHADOW tags", () => {
  const verdict = { gate: "receipt", action: "block" as const, reason: "Claim has no receipt: query MIND first." };
  const enforced = plainLines(R(), fold([{ type: "gate", verdict, enforced: true }]).rows).join("\n");
  assert.match(enforced, /gate:receipt/);
  assert.match(enforced, /ENFORCED/);
  assert.match(enforced, /Claim has no receipt: query MIND first\./);
  assert.doesNotMatch(enforced, /SHADOW/);
  const shadow = plainLines(R(), fold([{ type: "gate", verdict, enforced: false }]).rows).join("\n");
  assert.match(shadow, /SHADOW/);
  assert.doesNotMatch(shadow, /ENFORCED/);
});

test("gate rows use a distinct colour from tool rows when colour is on", () => {
  const gate = R(true).push({ kind: "gate", gate: "feed", action: "block", reason: "r", enforced: true }).join("\n");
  const tool = R(true).push({ kind: "tool", receiptId: "c1", tool: "x", args: {}, ok: true, preview: "" }).join("\n");
  assert.match(gate, /\x1b\[35m/);   // magenta
  assert.doesNotMatch(tool, /\x1b\[35m/);
});

test("confirm event renders a boxed card that tells the user to reply with an action phrase", () => {
  const { rows, folder } = fold([{ type: "confirm", id: "k1", tool: "send_email", args: { to: "a@b.co" }, reason: "Outward action needs your go-ahead." }]);
  assert.equal(folder.pendingConfirm?.id, "k1");
  const lines = plainLines(R(), rows);
  const text = lines.join("\n");
  assert.match(text, /╭─ Confirm/);
  assert.match(text, /send_email\(to: "a@b\.co"\)/);
  assert.match(text, /"send it"/);
  assert.match(text, /╰─+╯/);
  const boxed = lines.filter((l) => l.includes("│"));
  assert.ok(boxed.length >= 4);
  const widths = new Set(lines.filter((l) => /^ {2}[╭│╰]/.test(l)).map(visibleWidth));
  assert.equal(widths.size, 1, "box rows are all the same width");
});

test("notice events render at the top with level icons", () => {
  const info = plainLines(R(), fold([{ type: "notice", level: "info", text: "1 pending MIND reply" }]).rows).join("\n");
  assert.match(info, /ℹ 1 pending MIND reply/);
  const warn = plainLines(R(), fold([{ type: "notice", level: "warn", text: "slow provider" }]).rows).join("\n");
  assert.match(warn, /⚠ slow provider/);
});

test("usage events update cost and token totals, no rows", () => {
  const { rows, folder } = fold([{ type: "usage", usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.01 }, totalCostUsd: 0.0123 }, { type: "usage", usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 }, totalCostUsd: 0.02 }]);
  assert.equal(rows.length, 0);
  assert.equal(folder.totalCostUsd, 0.02);
  assert.equal(folder.promptTokens, 11);
  assert.equal(folder.completionTokens, 6);
});

test("a tool row arriving mid-stream flushes the partial assistant line first", () => {
  const r = R();
  const out: string[] = [];
  out.push(...r.push({ kind: "assistantDelta", delta: "thinking about it" }));
  assert.deepEqual(r.pending().map(stripAnsi), ["◆ thinking about it"]);
  out.push(...r.push({ kind: "tool", receiptId: "c1", tool: "read", args: {}, ok: true, preview: "" }));
  assert.equal(stripAnsi(out[0]), "◆ thinking about it");
  assert.match(stripAnsi(out[1]), /read\(\)/);
  assert.deepEqual(r.pending(), []);
});

test("consecutive assistant lines are indented under the marker and blank lines carry no trailing spaces", () => {
  const lines = plainLines(R(), [{ kind: "assistantDelta", delta: "one\n\ntwo\n" }, { kind: "assistantEnd" }]);
  assert.deepEqual(lines, ["◆ one", "", "  two"]);
});

test("ascii renderer uses no non-ascii glyphs", () => {
  const r = new TranscriptRenderer({ width: 70, color: false, ascii: true });
  const lines = [
    ...r.push({ kind: "user", text: "hi" }), ...r.push({ kind: "tool", receiptId: "c1", tool: "t", args: { a: 1 }, ok: true, preview: "p" }),
    ...r.push({ kind: "gate", gate: "g", action: "block", reason: "why", enforced: false }),
    ...r.push({ kind: "confirm", id: "i", tool: "t", args: {}, reason: "why" }),
    ...r.push({ kind: "notice", level: "warn", text: "n" }), ...r.push({ kind: "error", text: "e" }),
  ];
  assert.doesNotMatch(lines.join("\n"), /[^\x00-\x7f]/);
  assert.ok(ASCII.ok.length > 0);
});

test("summarizeArgs and formatCost", () => {
  assert.equal(summarizeArgs({}), "");
  assert.equal(summarizeArgs({ path: "/a/b", n: 3 }), 'path: "/a/b", n: 3');
  assert.ok(summarizeArgs({ q: "x".repeat(200) }, 40).length <= 44);
  assert.equal(formatCost(0), "$0.00");
  assert.equal(formatCost(0.01234), "$0.0123");
  assert.equal(formatCost(12.3456), "$12.35");
});

test("layoutInput wraps long lines, shows prompts, and puts the cursor correctly", () => {
  const ed = setEditorText(newEditor(), "x".repeat(25));
  const lay = layoutInput(ed, 12, "> ", "  "); // 10 usable columns
  assert.equal(lay.rows.length, 3);
  assert.equal(lay.rows[0], "> " + "x".repeat(10));
  assert.deepEqual([lay.cursorRow, lay.cursorCol], [2, 2 + 5]);
  const full = layoutInput(setEditorText(newEditor(), "y".repeat(10)), 12, "> ", "  ");
  assert.deepEqual([full.rows.length, full.cursorRow, full.cursorCol], [2, 1, 2]); // cursor wraps to a fresh row
  const multi = layoutInput({ lines: ["ab", "cd"], row: 1, col: 1 }, 20, "> ", "  ");
  assert.deepEqual(multi.rows, ["> ab", "  cd"]);
  assert.deepEqual([multi.cursorRow, multi.cursorCol], [1, 3]);
});

test("status line carries model, session, cost, kernel mode and connection", () => {
  const s = stripAnsi(buildStatus({ model: "xai/grok", sessionId: "abcdef1234567890", costUsd: 0.0421, kernel: "shadow", connected: true }, 100, false));
  assert.match(s, /xai\/grok/);
  assert.match(s, /session abcdef12/);
  assert.match(s, /\$0\.0421/);
  assert.match(s, /kernel shadow/);
  assert.match(s, /connected/);
  assert.equal(visibleWidth(s), 100);
  const off = stripAnsi(buildStatus({ costUsd: 0, kernel: "off", connected: false, running: { elapsedMs: 3500, frame: 0 }, queued: 2 }, 100, false));
  assert.match(off, /kernel off/);
  assert.match(off, /offline/);
  assert.match(off, /working 3s/);
  assert.match(off, /2 queued/);
});

test("composeLive stays within width/rows and reports the cursor", () => {
  const live = composeLive({
    width: 40, color: false, pending: ["a", "b", "c", "d", "e", "f"], running: [{ tool: "read", args: { path: "x" }, elapsedMs: 2000 }], frame: 1,
    editor: setEditorText(newEditor(), "hello"), status: { costUsd: 0, connected: true }, maxRows: 8,
  });
  assert.ok(live.lines.length <= 8);
  for (const l of live.lines) assert.ok(visibleWidth(l) <= 39, l);
  assert.match(stripAnsi(live.lines[live.cursorRow]), /^› hello/);
  assert.equal(live.cursorCol, 2 + 5);
  assert.match(stripAnsi(live.lines[live.lines.length - 1]), /connected/);
});

test("LiveScreen frame: first frame paints, next frame moves up to the region top and erases", () => {
  const screen = new LiveScreen();
  const live1 = { lines: ["one", "two", "three"], cursorRow: 1, cursorCol: 4 };
  const f1 = screen.frame(["hist"], live1, 80);
  assert.ok(f1.includes("hist\n"));
  assert.ok(f1.includes("one\ntwo\nthree"));
  assert.ok(f1.includes("\x1b[1A\r\x1b[5G")); // up from last line to cursor line, then column 5
  const f2 = screen.frame([], { lines: ["x"], cursorRow: 0, cursorCol: 0 }, 80);
  assert.ok(f2.includes("\x1b[1A\r\x1b[J"), "moves up by the old cursor row then erases to end of screen");
  const f3 = screen.frame([], null, 80);
  assert.ok(f3.includes("\r\x1b[J"));
  assert.ok(f3.startsWith("\x1b[?2026h"), "uses synchronized output to avoid flicker");
});

test("LiveScreen accounts for lines re-wrapped by a narrower terminal", () => {
  const screen = new LiveScreen();
  screen.frame([], { lines: ["a".repeat(60), "b".repeat(10)], cursorRow: 1, cursorCol: 2 }, 80);
  const f = screen.frame([], { lines: ["z"], cursorRow: 0, cursorCol: 0 }, 30); // first line now takes 2 rows
  assert.ok(f.includes("\x1b[2A"), JSON.stringify(f));
});
