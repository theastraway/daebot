// A bot session reads photos too: it is offered view_photo, gets the ## Photos skill, and the vision call goes through its owner's provider.
import { test } from "node:test";
process.env.DAEBOT_BOTS_ENABLED = "1"; // the Bots feature flag (default off)
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { startFakeMind } from "../gateway/fake-mind.ts";
import { FakeProvider, baseCfg, call, collect } from "../core/helpers.ts";
import { jpeg } from "./images.ts";

const rnd = () => randomBytes(18).toString("hex");

test("bot session: view_photo is offered, the Photos skill is in its prompt, and a photo sent to the bot is read", async () => {
  const key = "mind_" + rnd();
  const fake = await startFakeMind({ [key]: "pat" });
  try {
    const dir = mkdtempSync(join(tmpdir(), "bots-photos-"));
    // chat asks for the photo; the vision call answers; chat answers the user
    const provider = new FakeProvider([
      { calls: [call("c1", "view_photo", { photo: "p1", question: "read the total exactly" })] },
      { text: "Total: $5,211.50" },
      { text: "SURFACE✓ #c1 view_photo -> the total is $5,211.50" },
    ]);
    const rt = createRuntime(baseCfg({ mindBaseUrl: fake.base, mindApiKey: key }), { provider, store: createFileStore(dir), owner: "u_pat", bots: { dir, bus: {} }, hosted: { dailyUsdCap: 50, username: "pat", exempt: true } });
    const bot = await rt.bots!.create({ slug: "sales", name: "Sales Bot", purpose: "owns the pipeline" });
    const s = await rt.openSession({ surface: "web", botId: bot.id, identity: "admin" });
    const added = await rt.photos!.add(s.id, [{ name: "estimate.jpg", mime: "image/jpeg", data: jpeg(1024, 700), width: 1024, height: 700 }]);
    assert.ok(added.ok);
    const ev = await collect(s.send("What is the total?", { photos: added.photos.map(({ id, name, width, height }) => ({ id, name, width, height })) }));
    const chat = provider.requests[0];
    assert.ok(chat.tools.some((t) => t.name === "view_photo"), "the bot is offered view_photo");
    assert.ok(!chat.tools.some((t) => t.name === "bash" || t.name === "write_file"), "a bot still has no shell or file writes");
    assert.match(chat.messages[0].content, /## Photos/);
    assert.match(chat.messages[0].content, /Sales Bot/);
    assert.match(chat.messages.at(-1)!.content, /\[photo p1: estimate\.jpg, 1024x700\]/);
    assert.equal(provider.requests[1].messages[1].images?.length, 1, "the vision call carried the photo");
    assert.ok(ev.some((e) => e.type === "toolEnd" && (e as any).tool === "view_photo" && (e as any).ok));
    assert.match((ev.at(-1) as any).finalText, /\$5,211\.50/);
  } finally { await fake.close(); }
});
