import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOUD_ENV, otherHome } from "../src/env.ts";
import type { EnvTag } from "../src/env.ts";

const A = { id: "d_aaaaaaaaaaaaaaaa", kind: "machine" as const, name: "Legion" };
const B = { id: "d_bbbbbbbbbbbbbbbb", kind: "machine" as const, name: "MacBook Air" };

test("otherHome: unknown env counts as here; same device counts as here", () => {
  assert.equal(otherHome(undefined, A), undefined);
  assert.equal(otherHome(A, undefined), undefined);
  assert.equal(otherHome(A, A), undefined);
});
test("otherHome: another device or the cloud is away", () => {
  assert.equal(otherHome(B, A)?.name, "MacBook Air");
  assert.equal(otherHome(CLOUD_ENV, A)?.name, "MIND Cloud");
  assert.equal(otherHome(A, CLOUD_ENV)?.name, "Legion");
  assert.equal(otherHome(CLOUD_ENV, CLOUD_ENV), undefined);
});
test("otherHome: two registrations of one computer, merged by canon, are the same place", () => {
  const canon = (t: EnvTag): EnvTag => ({ ...t, id: "d_merged0000000000" });
  assert.equal(otherHome(A, B, canon), undefined);
});
