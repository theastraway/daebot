// SSRF guard: address table, https-only, DNS pinning, rebinding, redirects, size cap, timeout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { SsrfError, checkHostName, createNodeTransport, createSafeFetch, isBlockedIp, pinnedLookup, resolvePublic } from "../../src/mcpconnect/ssrf.ts";
import type { RawRequest, RawResponse, Resolver, Transport } from "../../src/mcpconnect/ssrf.ts";

test("isBlockedIp: private, loopback, link-local, metadata, CGNAT, multicast, reserved and tunnelled forms are all refused", () => {
  const blocked = [
    "0.0.0.0", "10.1.2.3", "127.0.0.1", "127.255.255.254", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "198.18.0.1",
    "224.0.0.1", "240.0.0.1", "255.255.255.255", "192.0.2.5", "203.0.113.9",
    "::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:7f00:1", "64:ff9b::7f00:1",
    "2002:7f00:0001::1", "2002:a9fe:a9fe::1", "2001:db8::1", "2001::1", "::127.0.0.1", "fec0::1", "not-an-ip", "1.2.3", "300.1.1.1", "fe80::1%eth0",
  ];
  for (const ip of blocked) assert.equal(isBlockedIp(ip), true, ip);
  const open = ["8.8.8.8", "93.184.216.34", "172.32.0.1", "100.63.255.255", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450:4009:81f::200e", "::ffff:8.8.8.8", "64:ff9b::808:808"];
  for (const ip of open) assert.equal(isBlockedIp(ip), false, ip);
});

test("checkHostName: internal names and odd forms are refused before any lookup", () => {
  for (const h of ["localhost", "a.localhost", "foo.local", "db.internal", "metadata.google.internal", "intranet", "x.corp", "127.0.0.1", "[::1]", "169.254.169.254", "bad..host"])
    assert.throws(() => checkHostName(h), SsrfError, h);
  assert.equal(checkHostName("Docs.Example.com."), "docs.example.com");
  // WHATWG URL normalises decimal / hex / octal IPv4 to dotted form, which is then refused.
  for (const u of ["https://2130706433/", "https://0x7f.1/", "https://017700000001/", "https://[::ffff:7f00:1]/"]) assert.throws(() => checkHostName(new URL(u).hostname), SsrfError, u);
});

const pub: Resolver = async () => [{ address: "93.184.216.34", family: 4 }];
function fake(status = 200, body = "{}", headers: Record<string, string> = {}): { t: Transport; seen: RawRequest[] } {
  const seen: RawRequest[] = [];
  return { seen, t: async (r) => { seen.push(r); return { status, headers, body: Buffer.from(body) } as RawResponse; } };
}

test("safe fetch: https only, no credentials in the URL, no private literal", async () => {
  const f = fake();
  const net = createSafeFetch({ resolve: pub, transport: f.t });
  for (const u of ["http://example.com/mcp", "https://user:pw@example.com/", "https://127.0.0.1/", "https://[::1]/", "https://169.254.169.254/latest/meta-data", "https://localhost/", "file:///etc/passwd"])
    await assert.rejects(net(u), SsrfError, u);
  assert.equal(f.seen.length, 0, "no request ever left");
  assert.equal((await net("https://example.com/ok")).status, 200);
});

test("safe fetch: a host that RESOLVES to a private address is refused (and one private answer among public ones too)", async () => {
  const f = fake();
  const priv: Resolver = async () => [{ address: "10.0.0.5", family: 4 }];
  const mixed: Resolver = async () => [{ address: "93.184.216.34", family: 4 }, { address: "169.254.169.254", family: 4 }];
  await assert.rejects(createSafeFetch({ resolve: priv, transport: f.t })("https://evil.example/mcp"), /private or internal/);
  await assert.rejects(createSafeFetch({ resolve: mixed, transport: f.t })("https://evil.example/mcp"), /private or internal/);
  assert.equal(f.seen.length, 0);
});

test("DNS rebinding: the connection is pinned to the address that was checked, not re-resolved", async () => {
  let calls = 0;
  const rebinding: Resolver = async () => (++calls === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]);
  const f = fake();
  const net = createSafeFetch({ resolve: rebinding, transport: f.t });
  await net("https://rebind.example/mcp");
  assert.equal(f.seen[0].ip, "93.184.216.34", "transport is told to connect to the checked address");
  assert.equal(calls, 1, "one lookup per hop: the HTTP stack never does its own");
  // and the pinned lookup hook the real transport uses returns exactly that address
  await new Promise<void>((res) => pinnedLookup("93.184.216.34", 4)("rebind.example", {}, (e, a, fam) => { assert.equal(e, null); assert.equal(a, "93.184.216.34"); assert.equal(fam, 4); res(); }));
  await new Promise<void>((res) => pinnedLookup("93.184.216.34", 4)("rebind.example", { all: true }, (_e, a) => { assert.deepEqual(a, [{ address: "93.184.216.34", family: 4 }]); res(); }));
  // a second request re-validates: now the name points inside and is refused
  await assert.rejects(net("https://rebind.example/mcp"), /private or internal/);
});

test("redirects are re-validated hop by hop: to a private IP, to an http URL, to a host that resolves privately, and across hosts", async () => {
  const mk = (loc: string, resolve: Resolver = pub) => {
    let n = 0;
    const t: Transport = async () => (n++ === 0 ? { status: 302, headers: { location: loc }, body: Buffer.from("") } : { status: 200, headers: {}, body: Buffer.from("secret") });
    return createSafeFetch({ resolve, transport: t });
  };
  await assert.rejects(mk("https://169.254.169.254/latest/meta-data/")("https://a.example/x", { redirects: "public" }), /private or internal/);
  await assert.rejects(mk("http://b.example/x")("https://a.example/x", { redirects: "public" }), /non-https/);
  const split: Resolver = async (h) => (h === "internal.example" ? [{ address: "192.168.0.9", family: 4 }] : [{ address: "93.184.216.34", family: 4 }]);
  await assert.rejects(mk("https://internal.example/x", split)("https://a.example/x", { redirects: "public" }), /private or internal/);
  await assert.rejects(mk("https://other.example/x")("https://a.example/x"), /different host/); // default same-host
  assert.equal((await mk("https://a.example/y")("https://a.example/x")).status, 200);          // same host is fine
  // too many hops
  const loop = createSafeFetch({ resolve: pub, transport: async () => ({ status: 302, headers: { location: "https://a.example/x" }, body: Buffer.from("") }) });
  await assert.rejects(loop("https://a.example/x"), /too many redirects/);
  // credentials are not carried to another host
  const seen: RawRequest[] = [];
  let n = 0;
  const t: Transport = async (r) => { seen.push(r); return n++ === 0 ? { status: 302, headers: { location: "https://c.example/x" }, body: Buffer.from("") } : { status: 200, headers: {}, body: Buffer.from("") }; };
  await createSafeFetch({ resolve: pub, transport: t })("https://a.example/x", { redirects: "public", headers: { Authorization: "Bearer T" } });
  assert.equal(seen[1].headers["authorization"], undefined);
});

test("resolvePublic: no answers or a failed lookup is a refusal, never a pass", async () => {
  await assert.rejects(resolvePublic(new URL("https://x.example/"), async () => []), /did not resolve/);
  await assert.rejects(resolvePublic(new URL("https://x.example/"), async () => { throw new Error("ENOTFOUND"); }), /could not look up/);
});

test("node transport: response-size cap and timeout (against a local server, scheme http for the test only)", async () => {
  const srv = createServer((req, res) => {
    if (req.url === "/big") { res.writeHead(200); res.write(Buffer.alloc(5000, 97)); res.end(Buffer.alloc(5000, 97)); }
    else if (req.url === "/slow") { res.writeHead(200); res.write("x"); /* never ends */ }
    else { res.writeHead(200, { "content-type": "text/plain" }); res.end("hello"); }
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  const tr = createNodeTransport({ scheme: "http" });
  const base = { ip: "127.0.0.1", family: 4 as const, method: "GET", headers: {}, timeoutMs: 2000, maxBytes: 4000 };
  try {
    assert.equal((await tr({ ...base, url: new URL(`https://x.test:${port}/`), maxBytes: 100 })).body.toString(), "hello");
    await assert.rejects(tr({ ...base, url: new URL(`https://x.test:${port}/big`) }), /too large/);
    await assert.rejects(tr({ ...base, url: new URL(`https://x.test:${port}/slow`), timeoutMs: 300 }), /timed out/);
  } finally { srv.closeAllConnections(); await new Promise<void>((r) => srv.close(() => r())); }
});
