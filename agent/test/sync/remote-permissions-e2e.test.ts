// A remote bot turn on the desktop that needs a permission card: the card shows on the device that sent the message (the hosted stream),
// the answer goes back to the desktop, and the turn continues. No answer in time = denied, with a plain message.
process.env.DAEBOT_BOTS_ENABLED = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostedRig, deskRig, until } from "./rig.ts";
import { parseSse, http } from "../gateway/helpers.ts";
import { call } from "../core/helpers.ts";
import { H } from "./rig.ts";

async function remoteBot(hosted: Awaited<ReturnType<typeof hostedRig>>, desk: Awaited<ReturnType<typeof deskRig>>) {
  const bot = JSON.parse((await desk.api("POST", "/bots", { slug: "scout", name: "Scout" })).body).bot;
  const web = await hosted.as(hosted.keys.alice);
  const hostBot = await until(async () => JSON.parse((await web("GET", "/bots")).body).bots.find((b: any) => b.slug === "scout" && b.remoteDevices?.length));
  await desk.api("PATCH", `/bots/${bot.id}`, { remote: true });
  await until(async () => JSON.parse((await web("GET", "/bots")).body).bots.find((x: any) => x.slug === "scout").remote);
  await desk.api("PUT", "/permissions/mode", { mode: "everything" }); // the desktop asks before anything that is not a quiet read
  const { sessionId } = JSON.parse((await web("POST", "/sessions", { surface: "ios", bot: hostBot.id })).body);
  return { web, sessionId };
}

/** Sends a message; when the hosted stream shows a card, `answer` is POSTed to the HOSTED decide route (what the phone does). */
async function sendAndAnswer(hosted: Awaited<ReturnType<typeof hostedRig>>, sessionId: string, answer: Record<string, unknown> | undefined) {
  const h = await (async () => { const r = await http(hosted.gw.url, "POST", "/auth/key", { headers: H, body: { key: hosted.keys.alice } }); const sc = r.headers["set-cookie"]; return { ...H, cookie: (Array.isArray(sc) ? sc[0] : String(sc ?? "")).split(";")[0] }; })();
  let answered = false;
  let cardId = "";
  const res = await http(hosted.gw.url, "POST", `/sessions/${sessionId}/send`, {
    headers: h, body: { text: "write the file" },
    onChunk: (chunk) => {
      const m = /"type":"permission","id":"([^"]+)"/.exec(chunk);
      if (m && !answered && answer) { answered = true; cardId = m[1]; void http(hosted.gw.url, "POST", `/permissions/${m[1]}/decide`, { headers: h, body: answer }); }
    },
  });
  return { res, cardId, evs: parseSse(res.body) as any[] };
}

test("a remote turn that hits a permission card: the card shows on the sender, ALLOW goes back, the desktop runs the step and finishes", async () => {
  const target = join(mkdtempSync(join(tmpdir(), "remote-perm-")), "note.txt");
  const hosted = await hostedRig({ script: [{ text: "SERVER SHOULD NOT ANSWER" }] });
  const desk = await deskRig(hosted, hosted.keys.alice, { script: [{ calls: [call("c1", "write_file", { path: target, content: "hello" })] }, { text: "wrote the file" }] });
  try {
    const { sessionId } = await remoteBot(hosted, desk);
    const { res, evs } = await sendAndAnswer(hosted, sessionId, { decision: "allow", remember: "once" });
    assert.equal(res.status, 200, res.body);
    const card = evs.find((e) => e.type === "permission");
    assert.ok(card, "the card reached the sender's stream: " + res.body.slice(0, 600));
    assert.ok(card.allowOptions.length > 0 && card.denyOptions.length > 0, "the options the UI offers came through");
    assert.ok(evs.some((e) => e.type === "permissionResolved" && e.outcome === "allowed"));
    assert.ok(evs.some((e) => e.type === "text" && /wrote the file/.test(e.delta)));
    assert.equal(evs.at(-1).type, "done");
    assert.equal(existsSync(target), true, "the desktop ran the approved step");
    assert.equal(hosted.provider.requests.length, 0);
  } finally { await desk.close(); await hosted.close(); }
});

test("DENY from the sender: the desktop does not run the step, and the turn still ends with a reply", async () => {
  const target = join(mkdtempSync(join(tmpdir(), "remote-perm-")), "never.txt");
  const hosted = await hostedRig();
  const desk = await deskRig(hosted, hosted.keys.alice, { script: [{ calls: [call("c1", "write_file", { path: target, content: "x" })] }, { text: "ok, not writing" }] });
  try {
    const { sessionId } = await remoteBot(hosted, desk);
    const { evs } = await sendAndAnswer(hosted, sessionId, { decision: "deny", remember: "once" });
    assert.ok(evs.some((e) => e.type === "permissionResolved" && e.outcome === "denied"));
    assert.ok(evs.some((e) => e.type === "text" && /ok, not writing/.test(e.delta)));
    assert.equal(existsSync(target), false);
  } finally { await desk.close(); await hosted.close(); }
});

test("an answer for a card that is not yours, or malformed, is refused; the real card stays answerable", async () => {
  const hosted = await hostedRig();
  const desk = await deskRig(hosted, hosted.keys.alice, { script: [{ calls: [call("c1", "write_file", { path: join(mkdtempSync(join(tmpdir(), "rp-")), "a.txt"), content: "x" })] }, { text: "done" }] });
  try {
    const { sessionId } = await remoteBot(hosted, desk);
    const bob = await hosted.as(hosted.keys.bob);
    const web = await hosted.as(hosted.keys.alice);
    let cardId = "";
    const h = await (async () => { const r = await http(hosted.gw.url, "POST", "/auth/key", { headers: H, body: { key: hosted.keys.alice } }); const sc = r.headers["set-cookie"]; return { ...H, cookie: (Array.isArray(sc) ? sc[0] : String(sc ?? "")).split(";")[0] }; })();
    const out: string[] = [];
    const res = await http(hosted.gw.url, "POST", `/sessions/${sessionId}/send`, {
      headers: h, body: { text: "go" },
      onChunk: (chunk) => {
        const m = /"type":"permission","id":"([^"]+)"/.exec(chunk);
        if (m && !cardId) {
          cardId = m[1];
          void (async () => {
            out.push(String((await bob("POST", `/permissions/${cardId}/decide`, { decision: "allow" })).status)); // another user: not their card
            out.push(String((await web("POST", `/permissions/${cardId}/decide`, { decision: "maybe" })).status)); // malformed
            out.push(String((await web("POST", `/permissions/${cardId}/decide`, { decision: "deny", remember: "once" })).status));
          })();
        }
      },
    });
    assert.deepEqual(out, ["404", "400", "200"]);
    assert.ok((parseSse(res.body) as any[]).some((e) => e.type === "permissionResolved" && e.outcome === "denied"));
  } finally { await desk.close(); await hosted.close(); }
});

test("hub: a decision is held for the device that runs the job, wakes its poll, and is handed over once", async () => {
  const { RemoteHub } = await import("../../src/remote/hub.ts");
  const hub = new RemoteHub();
  hub.heartbeat("u", { id: "d_" + "1".repeat(16), name: "Mac", slugs: ["scout"] });
  const job = hub.enqueue("u", { deviceId: "d_" + "1".repeat(16), sessionId: "s", botSlug: "scout", surface: "ios", title: "t", text: "x", interactive: true });
  assert.equal(hub.addDecision("u", { jobId: job.id, permId: "p", decision: "allow" }), false, "not delivered yet: nothing to answer");
  hub.take("u", "d_" + "1".repeat(16));
  assert.equal(hub.addDecision("other", { jobId: job.id, permId: "p", decision: "allow" }), false, "another owner cannot answer");
  const waiting = hub.wait("u", "d_" + "1".repeat(16), 5000);
  assert.equal(hub.addDecision("u", { jobId: job.id, permId: "p", decision: "deny", remember: "once" }), true);
  const t0 = Date.now();
  await waiting;
  assert.ok(Date.now() - t0 < 1000, "the poll woke at once");
  assert.deepEqual(hub.takeDecisions("u", "d_" + "1".repeat(16)).map((d) => [d.permId, d.decision]), [["p", "deny"]]);
  assert.deepEqual(hub.takeDecisions("u", "d_" + "1".repeat(16)), []);
});

test("a card nobody answers: the desktop expires it, and the sender is told in plain words that it was denied", async () => {
  const hosted = await hostedRig();
  try {
    const web = await hosted.as(hosted.keys.alice);
    const bot = JSON.parse((await web("POST", "/bots", { slug: "scout", name: "Scout" })).body).bot;
    const dev = "d_" + "2".repeat(16);
    const poll = (wait: number) => hosted.host(hosted.keys.alice, "POST", "/api/sync/device/poll", { deviceId: dev, name: "Fake Mac", bots: [{ slug: "scout", remote: true, at: Date.now() }], wait });
    await poll(0);
    const { sessionId } = JSON.parse((await web("POST", "/sessions", { surface: "ios", bot: bot.id })).body);
    const sending = web("POST", `/sessions/${sessionId}/send`, { text: "do it" });
    const job = await until(async () => JSON.parse((await poll(1)).body).jobs?.[0]);
    const post = (body: unknown) => hosted.host(hosted.keys.alice, "POST", `/api/sync/device/jobs/${job.id}/events`, body);
    assert.equal(job.interactive, true, "the job tells the desktop the sender can answer cards");
    await post({ events: [{ type: "permission", id: "card-1", tool: "write_file", cls: "write", title: "Write a file", detail: [], args: {}, allowOptions: [], denyOptions: [], expiresAt: Date.now() + 1000 }] });
    await post({ events: [{ type: "permissionResolved", id: "card-1", outcome: "expired", by: "user" }, { type: "text", delta: "I did not run it." }], done: true });
    const evs = parseSse((await sending).body) as any[];
    assert.ok(evs.some((e) => e.type === "permission"));
    assert.ok(evs.some((e) => e.type === "notice" && /Nobody answered the permission request in time, so it was denied/.test(e.text)));
    // a late answer finds nothing to answer
    assert.equal((await web("POST", `/permissions/card-1/decide`, { decision: "allow" })).status, 404);
  } finally { await hosted.close(); }
});
