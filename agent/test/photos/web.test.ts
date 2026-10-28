// The composer's photo module (web/photos.js): its pure helpers, and checks that the served files are wired up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain browser module
import { MAX_BYTES, MAX_EDGE, MAX_PHOTOS, MAX_TOTAL_BYTES, QUALITY, QUEUE_PHOTO_BUDGET, SAYS, classifyFile, dataUrlBytes, fitWithin, normQueue, packQueue, queueLabel } from "../../web/photos.js";

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../../web/${p}`, import.meta.url)), "utf8");

test("limits match the spec: 5 photos, 1568px long edge, JPEG q0.85, 8 MB after shrinking", () => {
  assert.equal(MAX_PHOTOS, 5);
  assert.equal(MAX_EDGE, 1568);
  assert.equal(QUALITY, 0.85);
  assert.equal(MAX_BYTES, 8 * 1024 * 1024);
  assert.equal(MAX_TOTAL_BYTES, 24 * 1024 * 1024);
});

test("classifyFile: jpeg, png, webp and gif are ok; HEIC and HEIF are named; the rest is other; an empty type falls back to the extension", () => {
  for (const t of ["image/jpeg", "image/png", "image/webp", "image/gif", "IMAGE/JPEG"]) assert.equal(classifyFile({ type: t, name: "x" }), "ok", t);
  assert.equal(classifyFile({ type: "image/heic", name: "IMG_0001.HEIC" }), "heic");
  assert.equal(classifyFile({ type: "image/heif", name: "a" }), "heic");
  assert.equal(classifyFile({ type: "", name: "IMG_0002.heic" }), "heic");
  assert.equal(classifyFile({ type: "", name: "scan.JPG" }), "ok");
  assert.equal(classifyFile({ type: "", name: "pic.PNG" }), "ok");
  for (const f of [{ type: "image/svg+xml", name: "a.svg" }, { type: "application/pdf", name: "a.pdf" }, { type: "image/tiff", name: "a.tif" }, { type: "", name: "noext" }, { type: "video/mp4", name: "a.mp4" }]) assert.equal(classifyFile(f), "other", f.name);
  assert.match(SAYS.heic, /convert it to JPEG/i);
});

test("fitWithin: the long edge is at most 1568, the shape is kept, and small images are never scaled up", () => {
  assert.deepEqual(fitWithin(3000, 2000), { width: 1568, height: 1045 });
  assert.deepEqual(fitWithin(2000, 3000), { width: 1045, height: 1568 });
  assert.deepEqual(fitWithin(1568, 900), { width: 1568, height: 900 });
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 });
  assert.deepEqual(fitWithin(12000, 1), { width: 1568, height: 1 }, "never a zero side");
  assert.deepEqual(fitWithin(4000, 4000, 1000), { width: 1000, height: 1000 });
});

test("dataUrlBytes is the decoded size", () => {
  const b = Buffer.alloc(1000, 7);
  assert.equal(dataUrlBytes(`data:image/jpeg;base64,${b.toString("base64")}`), 1000);
  assert.equal(dataUrlBytes(`data:image/jpeg;base64,${Buffer.alloc(1001).toString("base64")}`), 1001);
  assert.equal(dataUrlBytes(`data:image/jpeg;base64,${Buffer.alloc(1002).toString("base64")}`), 1002);
  assert.equal(dataUrlBytes("nonsense"), 0);
  assert.equal(dataUrlBytes(undefined), 0);
});

const photo = (n: number, size = 1000) => ({ name: `p${n}.jpg`, dataUrl: `data:image/jpeg;base64,${"A".repeat(size)}`, width: 10, height: 10 });

test("queued messages keep their photos: the queue reads back old string entries and new {text, photos} entries", () => {
  const q = normQueue({ k: ["old string", { text: "with photo", photos: [photo(1)], lost: 0 }, { text: "  ", photos: [] }, 5, null], __draft__: [{ text: "", photos: [photo(2)] }], bad: "x" });
  assert.deepEqual(q.k.map((i: any) => [i.text, i.photos.length, i.lost]), [["old string", 0, 0], ["with photo", 1, 0]]);
  assert.equal(q.__draft__[0].photos[0].name, "p2.jpg");
  assert.equal(q.bad, undefined);
  assert.deepEqual(normQueue(null), {});
  assert.deepEqual(normQueue("junk"), {});
  // an entry that is not an image data URL is dropped, not trusted
  assert.equal(normQueue({ k: [{ text: "t", photos: [{ name: "x", dataUrl: "javascript:alert(1)" }] }] }).k[0].photos.length, 0);
});

test("packQueue: photos persist while they fit the sessionStorage budget; the rest keep their words and say how many photos were lost", () => {
  const queue = { k: [{ text: "one", photos: [photo(1, 1000)], lost: 0 }, { text: "two", photos: [photo(2, 1000), photo(3, 1000)], lost: 0 }, { text: "three", photos: [], lost: 0 }] };
  const fits = packQueue(queue, 10_000);
  assert.equal(fits.dropped, 0);
  assert.deepEqual(JSON.parse(fits.json).k.map((i: any) => (i.photos || []).length), [1, 2, 0]);
  const tight = packQueue(queue, 2_500); // room for the first message's photo (1,000+) and not the second's two
  assert.equal(tight.dropped, 2);
  const back = normQueue(JSON.parse(tight.json));
  assert.deepEqual(back.k.map((i: any) => [i.text, i.photos.length, i.lost]), [["one", 1, 0], ["two", 0, 2], ["three", 0, 0]]);
  // the in-memory queue was not touched
  assert.equal(queue.k[1].photos.length, 2);
  assert.ok(QUEUE_PHOTO_BUDGET < 5_000_000, "stays inside sessionStorage");
});

test("queueLabel: the text, or what the message holds when it is only photos", () => {
  assert.equal(queueLabel({ text: "hello", photos: [photo(1)] }), "hello");
  assert.equal(queueLabel({ text: "", photos: [photo(1)] }), "1 photo");
  assert.equal(queueLabel({ text: " ", photos: [photo(1), photo(2)] }), "2 photos");
  assert.equal(queueLabel({ text: "", photos: [], lost: 3 }), "3 photos");
  assert.equal(queueLabel({ text: "", photos: [] }), "");
});

test("the served files are wired: markup, document-level drop handling, paste, picker, queue, transcript, and no innerHTML", () => {
  const html = read("index.html");
  for (const needle of ['id="attach-strip"', 'id="attach-note"', 'id="drop-overlay"', 'id="btn-attach"', 'id="photo-input"', 'accept="image/*"', "multiple", 'aria-label="Attach photos"', 'id="i-image"', "Drop photos to attach"]) assert.ok(html.includes(needle), needle);
  const js = read("photos.js");
  // a missed drop must never navigate the app away: dragover and drop are cancelled on the DOCUMENT
  assert.match(js, /document\.addEventListener\("dragover", \(e\) => \{\s*e\.preventDefault\(\)/);
  assert.match(js, /document\.addEventListener\("drop"/);
  assert.match(js, /document\.addEventListener\("paste"/);
  assert.match(js, /els\.picker\.click\(\)/);
  assert.match(js, /imageOrientation/);
  assert.match(js, /toDataURL\("image\/jpeg", QUALITY\)/);
  assert.ok(!/\binnerHTML\b/.test(js), "DOM is built with createElement and textContent only");
  assert.ok(!/createObjectURL/.test(js), "the page CSP allows data: images, not blob:");
  const app = read("app.js");
  assert.ok(app.includes('import { initPhotos'));
  assert.ok(app.includes("photos: attached.map"), "photos go in the send body");
  assert.ok(app.includes("enqueue(tkey(), t, attached)"), "queued messages keep their photos");
  assert.ok(app.includes("sendMessage(item.text, item.photos)"), "Send now sends the queued photos");
  assert.ok(app.includes('ev.type === "photos"'), "the stored photo ids come back in the first SSE event");
  assert.ok(app.includes("photos.thumbs(it.photos, tkey())"), "the sent bubble shows the thumbnails");
  assert.ok(/photos: ev\.photos/.test(app), "history and re-attached runs carry photos");
  assert.ok(app.includes("({ dataUrl, ...p }) => p"), "photo data never goes into sessionStorage transcripts");
  const css = read("style.css");
  for (const sel of [".attach-strip", ".attach-thumb", ".attach-x", ".drop-overlay", ".msg-photo", ".photo-view"]) assert.ok(css.includes(sel), sel);
  assert.ok(css.includes("pointer-events: none"), "the overlay never steals the drop");
});
