import { test } from "node:test";
import assert from "node:assert/strict";
import { contractOf, done, failed } from "../../src/tools/contract.ts";
import { fail } from "../../src/tools/util.ts";

test("done: summary first line, next and artifacts, partial", () => {
  const r = done("wrote 3 files", { output: "a\nb", next: "run the tests", artifacts: ["/x/a.ts"], partial: true });
  assert.equal(r.ok, true);
  assert.equal(r.output.split("\n")[0], "wrote 3 files | next: run the tests");
  assert.deepEqual(contractOf(r), { status: "partial", summary: "wrote 3 files", next: "run the tests", artifacts: ["/x/a.ts"] });
});

test("failed: cause, retry, next, stop on one line; blocked status", () => {
  const r = failed("no such path", { retry: "pointless", next: "glob first", stop: "after one retry" });
  assert.equal(r.ok, false);
  assert.equal(r.output, "failed: no such path | retry: pointless | next: glob first | stop: after one retry");
  const c = contractOf(r);
  assert.equal(c.retry, "pointless");
  assert.equal(c.cause, "no such path");
  assert.equal(contractOf(failed("gate", { blocked: true })).status, "blocked");
});

test("contractOf infers a contract for results that never used the helpers; fail() with a hint carries one", () => {
  assert.deepEqual(contractOf({ ok: true, output: "hello\nworld" }), { status: "ok", summary: "hello" });
  assert.equal(contractOf({ ok: false, output: "blocked by danger gate: confirm first" }).status, "blocked");
  assert.equal(contractOf({ ok: false, output: "read_file: not found: /x" }).cause, "read_file: not found: /x");
  const h = fail("edit_file: old_string not found", { retry: "pointless", next: "read it again" });
  assert.equal(h.output, "edit_file: old_string not found | retry: pointless | next: read it again");
  assert.equal(contractOf(h).next, "read it again");
  assert.equal(fail("plain").output, "plain");
});
