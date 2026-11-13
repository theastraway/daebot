// The PDF text reader (src/pdf.ts) and the read_document tool (src/tools/document.ts).
// Real producers are exercised: an uncompressed PDF built here, ReportLab's ASCII85+Flate, a Flate PDF with a ToUnicode CMap,
// and a scan with no text layer (which must be reported plainly, never guessed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { readFileSync, existsSync } from "node:fs";
import { isPdf, pdfText, contentStreamText } from "../../src/pdf.ts";
import { createReadDocumentTool, parsePages } from "../../src/tools/document.ts";
import type { PhotoMeta } from "../../src/photos.ts";

// ---------------------------------------------------------------- fixture builders

/** A minimal one-page PDF whose content stream holds `content`, uncompressed. */
function simplePdf(content: string): Buffer {
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]/Contents 4 0 R>>",
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  objs.forEach((b, i) => { out += `${i + 1} 0 obj\n${b}\nendobj\n`; });
  return Buffer.from(`${out}trailer<</Root 1 0 R>>\n%%EOF\n`, "latin1");
}

/** The same, with the content stream Flate-compressed. */
function flatePdf(content: string): Buffer {
  const z = deflateSync(Buffer.from(content, "latin1"));
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]/Contents 4 0 R>>",
    Buffer.concat([Buffer.from(`<</Length ${z.length}/Filter/FlateDecode>>\nstream\n`, "latin1"), z, Buffer.from("\nendstream", "latin1")]),
  ];
  let out = Buffer.from("%PDF-1.5\n", "latin1");
  objs.forEach((b, i) => { out = Buffer.concat([out, Buffer.from(`${i + 1} 0 obj\n`, "latin1"), Buffer.isBuffer(b) ? b : Buffer.from(b, "latin1"), Buffer.from("\nendobj\n", "latin1")]); });
  return Buffer.concat([out, Buffer.from("trailer<</Root 1 0 R>>\n%%EOF\n", "latin1")]);
}

const T = (s: string) => `BT /F1 12 Tf 20 200 Td (${s}) Tj ET`;

// ---------------------------------------------------------------- pdf.ts

test("isPdf: the %PDF header is required, and a text file is not one", () => {
  assert.equal(isPdf(simplePdf(T("hi"))), true);
  assert.equal(isPdf(Buffer.from("just text, no header")), false);
  assert.equal(isPdf(Buffer.alloc(4)), false);
});

test("pdfText reads an uncompressed content stream: the strings, in order, one line per text-positioning operator", () => {
  const r = pdfText(simplePdf(`${T("HELLO PDF 12345")} T* ${T("Second line")}`));
  assert.equal(r.pageCount, 1);
  assert.equal(r.hasText, true);
  assert.match(r.text, /HELLO PDF 12345/);
  assert.match(r.text, /Second line/);
  assert.equal(r.pages.length, 1);
});

test("pdfText reads a Flate-compressed stream (the common case)", () => {
  const r = pdfText(flatePdf(`${T("COMPRESSED TOTAL: 4321")}`));
  assert.equal(r.pageCount, 1);
  assert.match(r.text, /COMPRESSED TOTAL: 4321/);
  assert.equal(r.method, "latin1");
});

test("pdfText: a page with no text layer reports no text (a scan), and never invents any", () => {
  const r = pdfText(simplePdf("q 0 0 612 792 re W n /Im0 Do Q"));
  assert.equal(r.pageCount, 1);
  assert.equal(r.hasText, false);
  assert.equal(r.text.replace(/---[^\n]*---/g, "").trim(), "");
});

test("pdfText: junk, an empty buffer and a truncated file come back empty instead of throwing", () => {
  for (const b of [Buffer.alloc(0), Buffer.from("%PDF-1.4\ngarbage"), Buffer.from("PK\u0003\u0004 a zip, not a pdf"), Buffer.from("%PDF-1.7\n1 0 obj\n<<\nendob")]) {
    const r = pdfText(b);
    assert.equal(r.hasText, false, b.toString("latin1").slice(0, 12));
    assert.equal(typeof r.text, "string");
  }
});

test("contentStreamText: TJ kerning gaps become spaces, escaped parentheses survive, hex strings read", () => {
  const t1 = contentStreamText("BT [(Total: ) -400 (1,234.56)] TJ ET", { one: new Map(), two: new Map() });
  assert.equal(t1, "Total: 1,234.56");
  const t2 = contentStreamText("BT (a \\(b\\) c) Tj ET", { one: new Map(), two: new Map() });
  assert.equal(t2, "a (b) c");
  const t3 = contentStreamText("BT <48656C6C6F> Tj ET", { one: new Map(), two: new Map() });
  assert.equal(t3, "Hello");
  const t4 = contentStreamText("BT [(one) -50 (two)] TJ ET", { one: new Map(), two: new Map() });
  assert.equal(t4, "onetwo", "a small adjustment is kerning, not a space");
});

test("contentStreamText: a ToUnicode CMap maps subset-font codes back to real characters", () => {
  const cm = { one: new Map([[1, "A"], [2, "B"]]), two: new Map([[0x0102, "7"]]) };
  assert.equal(contentStreamText("BT (\\001) Tj (\\002) Tj ET", cm), "AB");
  assert.equal(contentStreamText("BT <0102> Tj ET", cm), "7");
});

test("pdfText on the real ReportLab file on this Mac (ASCII85 + Flate) reads its text", (t) => {
  const f = "/Users/ajc/Desktop/Interviews/Sample-Engagement-Agreement.pdf";
  if (!existsSync(f)) return t.skip("not on this machine");
  const r = pdfText(readFileSync(f));
  assert.equal(r.pageCount, 2);
  assert.equal(r.hasText, true);
  assert.match(r.text, /Northfield Claims Advisory LLC/);
  assert.match(r.text, /Client Engagement Agreement/);
});

test("pdfText on a real scanned PDF says there is no text layer", (t) => {
  const f = "/Users/ajc/Desktop/Interviews/Sample-Engagement-Agreement-SCANNED.pdf";
  if (!existsSync(f)) return t.skip("not on this machine");
  const r = pdfText(readFileSync(f));
  assert.equal(r.hasText, false);
  assert.equal(r.pageCount, 2);
});

// ---------------------------------------------------------------- parsePages

test("parsePages: all, a page, ranges, lists and a cap; bad input is refused with the usable forms", () => {
  const good = (raw: unknown, n: number) => {
    const r = parsePages(raw, n);
    assert.equal(r.ok, true, JSON.stringify(r));
    return r as Extract<ReturnType<typeof parsePages>, { ok: true }>;
  };
  const bad = (raw: unknown, n: number) => {
    const r = parsePages(raw, n);
    assert.equal(r.ok, false);
    return r as Extract<ReturnType<typeof parsePages>, { ok: false }>;
  };
  assert.deepEqual(good(undefined, 3).pages, [1, 2, 3]);
  assert.deepEqual(good("all", 3).pages, [1, 2, 3]);
  assert.deepEqual(good("2", 5).pages, [2]);
  assert.deepEqual(good("2-4", 5).pages, [2, 3, 4]);
  assert.deepEqual(good("1,4,2-3", 5).pages, [1, 2, 3, 4]);
  assert.match(bad("9-20", 3).error, /9-20|no page/, "a window past the end is refused, naming what was asked");
  assert.match(bad("abc", 5).error, /not a page or a range/);
  assert.match(bad("7-9", 3).error, /7-9|no page/, "a window entirely past the end is refused, not silently empty");
  assert.equal(good(undefined, 100).pages.length, 40, "a long document is read in windows");
  assert.equal(good(undefined, 100).capped, true);
});

// ---------------------------------------------------------------- read_document

const doc = (id: string, name: string, data: Buffer, extra: Partial<PhotoMeta> = {}): PhotoMeta =>
  ({ id, name, width: 0, height: 0, mime: "application/pdf", kind: "document", bytes: data.length, at: 0, ...extra } as PhotoMeta);

function storeOf(files: Record<string, Buffer>, metas?: PhotoMeta[]) {
  const list = metas ?? Object.entries(files).map(([id, data]) => doc(id, `${id}.pdf`, data));
  return {
    list: () => list,
    read: async (_sid: string, id: string) => (files[id] ? { meta: list.find((m) => m.id === id)!, data: files[id] } : undefined),
  };
}

test("read_document: reads the text of the attached PDF, names the document and reports what it read", async () => {
  const data = simplePdf(`${T("INVOICE 88")} T* ${T("TOTAL 1,250.00")}`);
  const tool = createReadDocumentTool({ store: storeOf({ p1: data }) });
  const r = await tool.run({ document: "p1" }, { cwd: "/", sessionId: "s1" });
  assert.equal(r.ok, true);
  assert.match(r.output, /INVOICE 88/);
  assert.match(r.output, /TOTAL 1,250.00/);
  assert.match(r.output, /p1 \(p1\.pdf\)/);
  assert.deepEqual(r.meta?.documents, ["p1"]);
});

test("read_document: no document id means the newest documents; a photo-only chat gets a pointer to view_photo", async () => {
  const files = { p1: simplePdf(T("one")), p2: simplePdf(T("two")) };
  const tool = createReadDocumentTool({ store: storeOf(files) });
  const r = await tool.run({}, { cwd: "/", sessionId: "s1" });
  assert.equal(r.ok, true);
  assert.match(r.output, /one/);
  assert.match(r.output, /two/);

  const photoOnly = { list: () => [{ id: "p1", name: "a.jpg", width: 10, height: 10, kind: "photo" } as PhotoMeta], read: async () => undefined };
  const r2 = await createReadDocumentTool({ store: photoOnly }).run({}, { cwd: "/", sessionId: "s1" });
  assert.equal(r2.ok, false);
  assert.match(r2.output, /no documents/);
  assert.match(r2.output, /view_photo/);
});

test("read_document: an unknown id is refused and the available documents are named", async () => {
  const tool = createReadDocumentTool({ store: storeOf({ p3: simplePdf(T("x")) }) });
  const r = await tool.run({ document: "p1" }, { cwd: "/", sessionId: "s1" });
  assert.equal(r.ok, false);
  assert.match(r.output, /no document "p1"/);
  assert.match(r.output, /p3/);
});

test("read_document: a scanned PDF is reported as having no text layer, and the reader suggests a photo", async () => {
  const tool = createReadDocumentTool({ store: storeOf({ p1: simplePdf("q /Im0 Do Q") }) });
  const r = await tool.run({ document: "p1" }, { cwd: "/", sessionId: "s1" });
  assert.equal(r.ok, false);
  assert.match(r.output, /no text layer/);
  assert.match(r.output, /view_photo/);
  assert.equal(r.meta?.empty, true);
});

test("read_document: a page window reads only those pages; a long document is capped and says so", async () => {
  const three = `${T("page one")} T* ${T("page two")} T* ${T("page three")}`;
  // one page holding all three lines: the window is per page, so build a 3-page file
  const multi = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n2 0 obj\n<</Type/Pages/Kids[3 0 R 5 0 R 7 0 R]/Count 3>>\nendobj\n" +
    "3 0 obj\n<</Type/Page/Parent 2 0 R/Contents 4 0 R>>\nendobj\n" +
    `4 0 obj\n<</Length ${T("page one").length}>>\nstream\n${T("page one")}\nendstream\nendobj\n` +
    "5 0 obj\n<</Type/Page/Parent 2 0 R/Contents 6 0 R>>\nendobj\n" +
    `6 0 obj\n<</Length ${T("page two").length}>>\nstream\n${T("page two")}\nendstream\nendobj\n` +
    "7 0 obj\n<</Type/Page/Parent 2 0 R/Contents 8 0 R>>\nendobj\n" +
    `8 0 obj\n<</Length ${T("page three").length}>>\nstream\n${T("page three")}\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n`,
    "latin1",
  );
  assert.equal(pdfText(multi).pageCount, 3);
  const tool = createReadDocumentTool({ store: storeOf({ p1: multi }) });
  const r = await tool.run({ document: "p1", pages: "2" }, { cwd: "/", sessionId: "s1" });
  assert.equal(r.ok, true);
  assert.match(r.output, /page two/);
  assert.ok(!r.output.includes("page three"), "only the asked-for page is in the result");
  const all = await tool.run({ document: "p1", pages: "all" }, { cwd: "/", sessionId: "s1" });
  assert.match(all.output, /read 1-3 of 3/);
  void three;
});

test("read_document is a quiet read with a surface receipt: no permission card, and its numbers can be cited", () => {
  const tool = createReadDocumentTool({ store: storeOf({}) });
  assert.equal(tool.spec.name, "read_document");
  assert.equal(tool.class, "read");
  assert.equal(tool.receipt, "surface");
});
