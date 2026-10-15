import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../../src/gateway/index.ts";
import type { AgentSession, Runtime } from "../../src/types.ts";
import { auth, http, tmpStatic } from "./helpers.ts";

function recordingRuntime() {
  const opened: { surface: string; title?: string; identity?: string; resumeId?: string }[] = [];
  const rt: Runtime = {
    async openSession(o) {
      opened.push(o);
      const s: AgentSession = {
        id: `s${opened.length}`, surface: o.surface,
        violations: () => [], close: async () => {},
        send: async function* () { yield { type: "done", finalText: "" }; },
      };
      return s;
    },
    listSessions: () => [],
  };
  return { rt, opened };
}

test("gateway.open forwards opts.identity to runtime.openSession (channel adapters)", async () => {
  const { rt, opened } = recordingRuntime();
  const gw = await startGateway({ runtime: rt, port: 0, staticDir: tmpStatic().dir, tokenPath: join(mkdtempSync(join(tmpdir(), "mc-home-")), "tok") });
  try {
    const a = await gw.open("telegram", "chat 1", { identity: "public" });
    const b = await gw.open("telegram", "chat 2");
    assert.equal(a.surface, "telegram");
    assert.deepEqual(opened.map((o) => o.identity), ["public", undefined]);
    assert.deepEqual(opened.map((o) => o.title), ["chat 1", "chat 2"]);
    assert.notEqual(a.id, b.id);
  } finally { await gw.close(); }
});

test("HTTP clients cannot choose an identity: the wire protocol never forwards one", async () => {
  const { rt, opened } = recordingRuntime();
  const gw = await startGateway({ runtime: rt, port: 0, staticDir: tmpStatic().dir, tokenPath: join(mkdtempSync(join(tmpdir(), "mc-home-")), "tok") });
  try {
    const r = await http(gw.url, "POST", "/sessions", { headers: auth(gw.token), body: { surface: "web", identity: "public" } });
    assert.equal(r.status, 200);
    assert.equal(opened[0].identity, undefined);
  } finally { await gw.close(); }
});
