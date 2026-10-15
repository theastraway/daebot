import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FakeProvider, baseCfg, collect } from "./helpers.ts";

const minded = existsSync(fileURLToPath(new URL("../../src/mind/index.ts", import.meta.url)));

test("runtime: boot failure still yields a session with a one-line warn notice", { skip: !minded && "src/mind not landed yet" }, async () => {
  const { createRuntime, composeSystemPrompt } = await import("../../src/runtime.ts");
  const failing = (async () => { throw new Error("offline"); }) as any;
  const rt = createRuntime(baseCfg({ mindApiKey: "k" }), { provider: new FakeProvider([{ text: "hello" }]), fetchImpl: failing });
  const s = await rt.openSession({ surface: "headless", title: "t" });
  const ev = await collect(s.send("hi"));
  const notice = ev.find((e) => e.type === "notice" && /boot failed/i.test((e as any).text)) as any;
  assert.ok(notice, "boot notice present");
  assert.ok(!notice.text.includes("\n"));
  assert.equal((ev.at(-1) as any).finalText.length > 0, true);
  assert.equal(rt.listSessions().length, 1);
  assert.equal(rt.listSessions()[0].surface, "headless");
  assert.ok(composeSystemPrompt({ bootContext: "X", surface: "s", cwd: "/" }).includes("MIND✓ #cN"));
  await s.close();
  assert.equal(rt.listSessions().length, 0);
});
