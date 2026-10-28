// Photo validation and the per-owner photo store. Pure: no network, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_OWNER_BYTES, MAX_PHOTOS_PER_MESSAGE, MAX_PHOTO_BYTES, MAX_SESSION_PHOTOS, PhotoStore, checkPhotos, cleanName, imageSize, isPhotoId, messageWithPhotos, photoLines,
} from "../../src/photos.ts";
import type { UploadedPhoto } from "../../src/photos.ts";
import { dataUrl, gif, jpeg, jpegUrl, png, sample, webpL, webpLossy, webpX } from "./images.ts";

const bad = (raw: unknown) => { const r = checkPhotos(raw); assert.equal(r.ok, false); return r as Extract<ReturnType<typeof checkPhotos>, { ok: false }>; };
const good = (raw: unknown) => { const r = checkPhotos(raw); assert.equal(r.ok, true, JSON.stringify(r)); return (r as Extract<ReturnType<typeof checkPhotos>, { ok: true }>).photos; };

test("imageSize reads JPEG, PNG, GIF and WebP (lossy, lossless, extended) headers", () => {
  assert.deepEqual(imageSize(jpeg(1024, 700), "image/jpeg"), { width: 1024, height: 700 });
  assert.deepEqual(imageSize(png(640, 480), "image/png"), { width: 640, height: 480 });
  assert.deepEqual(imageSize(gif(320, 200), "image/gif"), { width: 320, height: 200 });
  assert.deepEqual(imageSize(webpX(1600, 900), "image/webp"), { width: 1600, height: 900 });
  assert.deepEqual(imageSize(webpL(800, 600), "image/webp"), { width: 800, height: 600 });
  assert.deepEqual(imageSize(webpLossy(500, 400), "image/webp"), { width: 500, height: 400 });
  // a JPEG whose size marker comes after other segments still reads
  assert.deepEqual(imageSize(jpeg(33, 44, 300), "image/jpeg"), { width: 33, height: 44 });
});

test("imageSize refuses bytes that are not the declared type, and never throws on junk", () => {
  assert.equal(imageSize(png(10, 10), "image/jpeg"), undefined);
  assert.equal(imageSize(jpeg(10, 10), "image/png"), undefined);
  assert.equal(imageSize(Buffer.from("not an image at all, just text"), "image/gif"), undefined);
  assert.equal(imageSize(Buffer.alloc(0), "image/webp"), undefined);
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg"), undefined);
});

test("checkPhotos: a valid jpeg, png, webp and gif pass and carry their real size and a safe name", () => {
  const p = good([
    { name: "estimate.jpg", dataUrl: jpegUrl(1024, 700) },
    { name: "../../etc/shot.png", dataUrl: dataUrl("image/png", png(300, 200)) },
    { name: "a[1]\nb.webp", dataUrl: dataUrl("image/webp", webpX(64, 64)) },
    { dataUrl: dataUrl("image/gif", gif(10, 12)) },
  ]);
  assert.deepEqual(p.map((x) => [x.name, x.mime, x.width, x.height]), [
    ["estimate.jpg", "image/jpeg", 1024, 700], ["shot.png", "image/png", 300, 200], ["a_1__b.webp", "image/webp", 64, 64], ["photo-4", "image/gif", 10, 12],
  ]);
  assert.deepEqual(checkPhotos(undefined), { ok: true, photos: [] });
  assert.deepEqual(checkPhotos([]), { ok: true, photos: [] });
});

test("checkPhotos: a bad mime prefix is refused (svg, pdf, text, HEIC with its own message)", () => {
  assert.equal(bad([{ name: "a", dataUrl: dataUrl("image/svg+xml", Buffer.from("<svg/>")) }]).status, 415);
  assert.equal(bad([{ name: "a", dataUrl: dataUrl("application/pdf", Buffer.from("%PDF-1.4")) }]).status, 415);
  assert.equal(bad([{ name: "a", dataUrl: dataUrl("text/html", Buffer.from("<script>")) }]).status, 415);
  const heic = bad([{ name: "IMG_1.HEIC", dataUrl: dataUrl("image/heic", Buffer.alloc(40)) }]);
  assert.equal(heic.status, 415);
  assert.match(heic.error, /HEIC.*convert it to JPEG/);
  assert.match(bad([{ dataUrl: "https://example.com/a.jpg" }]).error, /base64 data URL/);
  assert.match(bad([{ dataUrl: "data:image/jpeg,rawtext" }]).error, /base64 data URL/);
  assert.match(bad([{ name: "x" }]).error, /expected/);
  assert.match(bad("nope").error, /array/);
});

test("checkPhotos: the payload must be real base64 of a real image of the declared type", () => {
  assert.match(bad([{ dataUrl: "data:image/jpeg;base64,@@@@" }]).error, /not valid base64/);
  assert.match(bad([{ dataUrl: "data:image/jpeg;base64,abc" }]).error, /not valid base64/); // length not a multiple of 4
  assert.match(bad([{ dataUrl: "data:image/jpeg;base64," }]).error, /not valid base64/);
  // a PNG sent as image/jpeg, and text sent as an image
  assert.match(bad([{ dataUrl: dataUrl("image/jpeg", png(10, 10)) }]).error, /not a valid JPEG/);
  assert.match(bad([{ dataUrl: dataUrl("image/png", Buffer.from("MZ this is an executable")) }]).error, /not a valid PNG/);
  // an absurd canvas
  assert.equal(bad([{ dataUrl: dataUrl("image/png", png(30000, 30000)) }]).status, 413);
  assert.equal(bad([{ dataUrl: dataUrl("image/png", png(0, 10)) }]).status, 400);
});

test("checkPhotos: per-photo size cap", () => {
  const huge = jpegUrl(2000, 1500, MAX_PHOTO_BYTES); // header + 8 MB of padding: over the cap
  const r = bad([{ name: "big.jpg", dataUrl: huge }]);
  assert.equal(r.status, 413);
  assert.match(r.error, /limit is 8 MB per photo/);
  // just under the cap passes
  assert.equal(good([{ name: "ok.jpg", dataUrl: jpegUrl(2000, 1500, MAX_PHOTO_BYTES - 200) }]).length, 1);
});

test("checkPhotos: more than 5 photos, and a request over the total cap, are refused", () => {
  const six = Array.from({ length: MAX_PHOTOS_PER_MESSAGE + 1 }, (_, i) => sample(`p${i}.jpg`));
  assert.match(bad(six).error, /at most 5 photos/);
  assert.equal(good(six.slice(0, 5)).length, 5);
  // 4 x 7 MB = 28 MB decoded: each is under the per-photo cap, together they are over the per-request cap
  const sevens = Array.from({ length: 4 }, (_, i) => ({ name: `s${i}.jpg`, dataUrl: jpegUrl(3000, 2000, 7 * 1024 * 1024) }));
  const r = bad(sevens);
  assert.equal(r.status, 413);
  assert.match(r.error, /total over 24 MB/);
});

test("cleanName strips paths, brackets and control characters and clips length", () => {
  assert.equal(cleanName("C:\\Users\\me\\roof [final].jpg", "x"), "roof _final_.jpg");
  assert.equal(cleanName("a".repeat(200) + ".jpg", "x").length, 60);
  assert.equal(cleanName("", "fallback"), "fallback");
  assert.equal(cleanName("..", "fallback"), "fallback");
  assert.equal(cleanName(42, "fallback"), "fallback");
});

test("the lines the model reads: one per photo, and an empty message still says what arrived", () => {
  const refs = [{ id: "p1", name: "estimate.jpg", width: 1024, height: 768 }, { id: "p2", name: "b.png", width: 5, height: 6 }];
  assert.equal(photoLines(refs), "[photo p1: estimate.jpg, 1024x768]\n[photo p2: b.png, 5x6]");
  assert.equal(messageWithPhotos("What is the total?", refs), "What is the total?\n\n[photo p1: estimate.jpg, 1024x768]\n[photo p2: b.png, 5x6]");
  assert.match(messageWithPhotos("", [refs[0]]), /^\(The user attached a photo without a message\.\)\n\[photo p1: /);
  assert.match(messageWithPhotos("  ", refs), /attached 2 photos/);
  assert.equal(messageWithPhotos("hello", undefined), "hello");
  assert.equal(messageWithPhotos("hello", []), "hello");
});

// ---------------------------------------------------------------- store
const up = (name: string, w = 100, h = 80, pad = 0): UploadedPhoto => ({ name, mime: "image/jpeg", data: jpeg(w, h, pad), width: w, height: h });
const tmp = () => mkdtempSync(join(tmpdir(), "photos-"));

test("store: ids run p1, p2 ... per session and are never reused; bytes read back identical; survives a new store object (restart)", async () => {
  const dir = tmp();
  const a = new PhotoStore({ dir, owner: "u_alice" });
  const r1 = await a.add("s1", [up("one.jpg"), up("two.jpg", 200, 100)]);
  assert.ok(r1.ok);
  assert.deepEqual(r1.photos.map((p) => p.id), ["p1", "p2"]);
  const r2 = await a.add("s1", [up("three.jpg")]);
  assert.ok(r2.ok && r2.photos[0].id === "p3");
  const other = await a.add("s2", [up("x.jpg")]);
  assert.ok(other.ok && other.photos[0].id === "p1", "ids are per session");
  const hit = await a.read("s1", "p2");
  assert.equal(hit?.meta.name, "two.jpg");
  assert.deepEqual(hit?.data, jpeg(200, 100));
  const again = new PhotoStore({ dir, owner: "u_alice" });
  assert.deepEqual(again.list("s1").map((p) => p.id), ["p1", "p2", "p3"]);
  assert.equal(again.get("s1", "p9"), undefined);
  assert.equal(await again.read("s1", "../../../etc/passwd"), undefined, "an id that is not pN never reaches the filesystem");
  assert.ok(isPhotoId("p12") && !isPhotoId("p0") && !isPhotoId("p1/../x") && !isPhotoId("P1"));
});

test("store: one owner can never read another owner's photo, even with the right session id and photo id", async () => {
  const dir = tmp();
  const alice = new PhotoStore({ dir, owner: "u_alice" });
  const bob = new PhotoStore({ dir, owner: "u_bob" });
  await alice.add("shared-id", [up("secret.jpg")]);
  assert.equal(alice.list("shared-id").length, 1);
  assert.deepEqual(bob.list("shared-id"), []);
  assert.equal(await bob.read("shared-id", "p1"), undefined);
  // and an owner id that tries to climb out of the photos folder is hashed, not joined
  const evil = new PhotoStore({ dir, owner: "../../u_alice" });
  assert.equal(await evil.read("shared-id", "p1"), undefined);
  assert.ok(existsSync(join(dir, "photos", "u_alice")));
  assert.ok(readdirSync(join(dir, "photos")).every((d) => !d.includes("..")));
});

test("store: unsafe session ids are hashed into a safe folder name", async () => {
  const dir = tmp();
  const s = new PhotoStore({ dir, owner: "owner" });
  const r = await s.add("../../../tmp/evil", [up("a.jpg")]);
  assert.ok(r.ok);
  assert.equal(s.list("../../../tmp/evil").length, 1);
  assert.ok(readdirSync(join(dir, "photos", "owner")).every((d) => /^h-[0-9a-f]{40}$/.test(d)));
});

test("store: concurrent adds to one session get distinct ids", async () => {
  const s = new PhotoStore({ dir: tmp(), owner: "owner" });
  const all = await Promise.all(Array.from({ length: 8 }, (_, i) => s.add("s", [up(`${i}.jpg`)])));
  const ids = all.map((r) => (r.ok ? r.photos[0].id : "x"));
  assert.equal(new Set(ids).size, 8);
});

test("store: per-session and per-owner caps refuse with a plain message and a 413", async () => {
  const s = new PhotoStore({ dir: tmp(), owner: "owner" });
  for (let i = 0; i < MAX_SESSION_PHOTOS / 5; i++) assert.ok((await s.add("full", Array.from({ length: 5 }, (_, j) => up(`${i}-${j}.jpg`)))).ok);
  const over = await s.add("full", [up("one-too-many.jpg")]);
  assert.ok(!over.ok && over.status === 413 && /start a new chat/.test(over.error));
  // the owner cap: fill it with a few big photos (sparse padding), the next one is refused, deleting a chat frees the space
  const big = new PhotoStore({ dir: tmp(), owner: "owner" });
  const chunk = 7 * 1024 * 1024;
  const n = Math.floor(MAX_OWNER_BYTES / chunk);
  for (let i = 0; i < n; i++) assert.ok((await big.add(`c${i}`, [up(`b${i}.jpg`, 100, 80, chunk)])).ok, `fill ${i}`);
  const full = await big.add("late", [up("late.jpg", 100, 80, chunk)]);
  assert.ok(!full.ok && full.status === 413 && /storage is full/.test(full.error));
  await big.removeSession("c0");
  assert.ok((await big.add("late", [up("late.jpg", 100, 80, chunk)])).ok, "space freed by deleting a chat");
});

test("store: removeSession deletes every photo of that chat and nothing else", async () => {
  const dir = tmp();
  const s = new PhotoStore({ dir, owner: "owner" });
  await s.add("a", [up("1.jpg"), up("2.jpg")]);
  await s.add("b", [up("3.jpg")]);
  await s.removeSession("a");
  assert.deepEqual(s.list("a"), []);
  assert.equal(await s.read("a", "p1"), undefined);
  assert.equal(s.list("b").length, 1);
  await s.removeSession("never-existed"); // harmless
});
