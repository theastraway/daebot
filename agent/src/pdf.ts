// PDF text extraction, dependency-free (node:zlib only).
//
// A PDF the user attaches is read as TEXT, not as pixels: the hosted agent has no shell, no rasterizer and no runtime
// dependencies, and the chat model is text-first, so pulling the page text out is the only route that works everywhere.
// This is deliberately a small, forgiving reader:
//   - it walks every `N 0 obj ... endobj` in file order and treats `/Type /Page` objects as pages;
//   - a page's `/Contents` stream (single ref or an array) is inflated (FlateDecode) or taken raw, and the text
//     operators (Tj, TJ, ', ") are turned into lines;
//   - a ToUnicode CMap, when the file has one, is used to map the codes back to real characters (subset fonts
//     otherwise come out as gibberish), falling back to Latin-1.
// It is a reader, not a renderer: no images, no layout, no annotations. A scan with no text layer returns almost nothing
// and the caller says so plainly instead of guessing. Never throws.
import { inflateRawSync, inflateSync } from "node:zlib";

/** Cheap signature test: does this buffer look like a PDF? */
export function isPdf(buf: Buffer): boolean {
  if (!buf || buf.length < 8) return false;
  const head = buf.toString("latin1", 0, Math.min(buf.length, 1024));
  return /%PDF-\d\.\d/.test(head);
}

export interface PdfText {
  /** Page objects found in the file (0 when the file is not a page tree we can read). */
  pageCount: number;
  /** Extracted text per page, in file order. Empty strings are pages with no text layer. */
  pages: string[];
  /** All pages joined with a blank line. */
  text: string;
  /** True when at least one printable character came out. */
  hasText: boolean;
  /** First bytes as a latin1 string: how the bytes were read from a stream. */
  method: string;
}

// ---------------------------------------------------------------- object walking

interface RawObject { num: number; body: string }

const OBJ_HEAD = /(\d+)\s+(\d+)\s+obj\b/g;

/** Every `N G obj ... endobj` body in file order, as latin1. Truncated at the next object header. */
function objects(raw: string): RawObject[] {
  const heads: { num: number; at: number; end: number }[] = [];
  OBJ_HEAD.lastIndex = 0;
  for (let m; (m = OBJ_HEAD.exec(raw)); ) heads.push({ num: Number(m[1]), at: m.index, end: m.index + m[0].length });
  const out: RawObject[] = [];
  for (let i = 0; i < heads.length; i++) {
    const stop = i + 1 < heads.length ? heads[i + 1].at : Math.min(raw.length, heads[i].at + 4_000_000);
    out.push({ num: heads[i].num, body: raw.slice(heads[i].end, stop) });
  }
  return out;
}

/** Streams of a decoded object body (after `stream` up to the last `endstream`), with their declared filters. */
function streamBytes(body: string): { data: Buffer; filters: string }[] {
  const out: { data: Buffer; filters: string }[] = [];
  let from = 0;
  while (true) {
    const s = body.indexOf("stream", from);
    if (s < 0) break;
    let start = s + 6;
    if (body[start] === "\r") start++;
    if (body[start] === "\n") start++;
    const e = body.indexOf("endstream", start);
    if (e < 0) break;
    const dict = body.slice(0, s);
    const filters = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(dict)?.[1] ?? "";
    const data = e > start ? Buffer.from(body.slice(start, e), "latin1") : Buffer.alloc(0);
    if (data.length) out.push({ data, filters });
    from = e + 9;
  }
  return out;
}

/** ASCII85 (`<~ ... ~>` or bare) as PDF uses it, then end-of-data `~>`. */
function ascii85(data: Buffer): Buffer {
  const s = data.toString("latin1");
  const out: number[] = [];
  let tuple: number[] = [];
  const flush = (partialCount: number) => {
    if (!tuple.length) return;
    const n = tuple.length;
    for (let i = n; i < 5; i++) tuple.push(84); // pad with "u"
    let v = 0;
    for (const d of tuple) v = v * 85 + d;
    const bytes = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    out.push(...bytes.slice(0, partialCount === 0 ? 4 : n - 1));
    tuple = [];
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "~" && s[i + 1] === ">") break;
    if (c === "<" && s[i + 1] === "~") { i++; continue; }
    if (c === "z" && tuple.length === 0) { out.push(0, 0, 0, 0); continue; }
    const code = s.charCodeAt(i);
    if (code < 33 || code > 117) continue; // whitespace and anything outside the alphabet
    tuple.push(code - 33);
    if (tuple.length === 5) flush(0);
  }
  flush(tuple.length);
  return Buffer.from(out);
}

/** RunLengthDecode: a length byte, then that many literal bytes (or a repeated byte with length 257-n). */
function runLength(data: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const n = data[i];
    if (n === 128) break;
    if (n < 128) { for (let k = 1; k <= n + 1 && i + k < data.length; k++) out.push(data[i + k]); i += n + 1; }
    else { const b = data[i + 1]; for (let k = 0; k < 257 - n; k++) out.push(b); i += 1; }
  }
  return Buffer.from(out);
}

/** Applies the stream's filters in the order the dictionary lists them. */
function applyFilters(data: Buffer, filters: string): Buffer {
  let out = data;
  const names = [...filters.matchAll(/\/([A-Za-z0-9]+Decode)/g)].map((m) => m[1]);
  for (const name of names) {
    try {
      if (name === "ASCII85Decode") out = ascii85(out);
      else if (name === "ASCIIHexDecode") { const h = out.toString("latin1").replace(/[^0-9A-Fa-f]/g, "").replace(/>.*$/, ""); out = Buffer.from(h.length % 2 ? h + "0" : h, "hex"); }
      else if (name === "FlateDecode") out = inflateSync(out);
      else if (name === "RunLengthDecode") out = runLength(out);
      else return data; // an image codec or LZWDecode: not text, leave it alone
    } catch {
      // Some producers declare a filter they did not apply (or a broken stream): try Flate, then keep the bytes.
      try { out = inflateSync(out); } catch { return data; }
    }
  }
  return out;
}

/** Inflates one stream: its declared filters, then zlib, then raw deflate, then the bytes as they are. */
function decodeStream(data: Buffer, filters: string): Buffer | undefined {
  const image = /DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode/.test(filters);
  if (image) return undefined;
  if (filters) {
    const applied = applyFilters(data, filters);
    if (applied.length && applied !== data) return applied;
    if (/FlateDecode/.test(filters)) {
      const out = applied.length ? applied : data;
      for (const t of [() => inflateSync(out), () => inflateRawSync(out)]) {
        try { const r = t(); if (r.length) return r; } catch { /* not this one */ }
      }
      return undefined;
    }
    return applied.length ? applied : undefined;
  }
  // No filter at all: the stream is literal (some producers store content streams plain).
  for (const t of [() => inflateSync(data), () => inflateRawSync(data)]) {
    try { const r = t(); if (r.length) return r; } catch { /* not compressed */ }
  }
  return data;
}

/** Text-bearing streams of one object, decoded. Image and font streams are skipped by their own dictionaries. */
function decodedStreams(body: string): Buffer[] {
  if (/\/Subtype\s*\/Image/.test(body) || /\/Type\s*\/(Font|XObject|Metadata|ObjStm)/.test(body)) return [];
  const out: Buffer[] = [];
  for (const s of streamBytes(body)) {
    const d = decodeStream(s.data, s.filters);
    if (d && d.length) out.push(d);
  }
  return out;
}

// ---------------------------------------------------------------- ToUnicode CMaps

interface Cmaps { one: Map<number, string>; two: Map<number, string> }

const pair = (hex: string): string => {
  const h = hex.replace(/\s+/g, "");
  let s = "";
  for (let i = 0; i + 3 < h.length + 1 && i + 4 <= h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
  return s;
};

/** Parses beginbfchar / beginbfrange blocks into 1-byte and 2-byte code maps. Later fonts win; a clash is not worth a per-font map here. */
function parseCmap(text: string, into: Cmaps): void {
  const src = /\b(\d+)\s+beginbfchar\b([\s\S]*?)endbfchar/g;
  for (let m; (m = src.exec(text)); ) {
    const body = m[2];
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    for (let p; (p = re.exec(body)); ) {
      const code = parseInt(p[1], 16);
      const val = pair(p[2]);
      (p[1].length <= 2 ? into.one : into.two).set(code, val);
    }
  }
  const rng = /\b(\d+)\s+beginbfrange\b([\s\S]*?)endbfrange/g;
  for (let m; (m = rng.exec(text)); ) {
    const body = m[2];
    // <lo> <hi> <dst>  |  <lo> <hi> [<d1> <d2> ...]
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g;
    for (let p; (p = re.exec(body)); ) {
      const lo = parseInt(p[1], 16);
      const hi = parseInt(p[2], 16);
      const width = p[1].length <= 2 ? 1 : 2;
      const map = width === 1 ? into.one : into.two;
      if (p[4] !== undefined) {
        const base = parseInt(p[4], 16);
        for (let c = lo; c <= hi && c - lo < 512; c++) map.set(c, String.fromCharCode(base + (c - lo)));
      } else if (p[5]) {
        const items = p[5].match(/<[0-9A-Fa-f]+>/g) ?? [];
        items.forEach((h, i) => map.set(lo + i, pair(h.slice(1, -1))));
      }
    }
  }
}

function readCmaps(all: Buffer[]): Cmaps {
  const c: Cmaps = { one: new Map(), two: new Map() };
  for (const b of all) {
    const s = b.toString("latin1");
    if (s.includes("beginbfchar") || s.includes("beginbfrange")) parseCmap(s, c);
  }
  return c;
}

// ---------------------------------------------------------------- text operators

const ESC: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };

/** The bytes inside a `( ... )` literal, escapes resolved, as raw bytes (each char code 0-255). */
function literal(raw: string, i: number, end: number): { bytes: number[]; at: number } {
  const out: number[] = [];
  let depth = 1;
  i++;
  while (i < end) {
    const c = raw[i];
    if (c === "\\") {
      const n = raw[i + 1];
      if (n === undefined) { i++; break; }
      if (n >= "0" && n <= "7") {
        let oct = "";
        let k = i + 1;
        while (k < end && oct.length < 3 && raw[k] >= "0" && raw[k] <= "7") oct += raw[k++];
        out.push(parseInt(oct, 8) & 0xff);
        i = k;
        continue;
      }
      if (n === "\r" || n === "\n") { i += n === "\r" && raw[i + 2] === "\n" ? 3 : 2; continue; }
      out.push((ESC[n] ?? n).charCodeAt(0) & 0xff);
      i += 2;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) { i++; break; } }
    out.push(c.charCodeAt(0) & 0xff);
    i++;
  }
  return { bytes: out, at: i };
}

/** A `<hex>` string's bytes. */
function hexString(raw: string, i: number, end: number): { bytes: number[]; at: number } {
  let h = "";
  i++;
  while (i < end && raw[i] !== ">") { if (/[0-9A-Fa-f]/.test(raw[i])) h += raw[i]; i++; }
  if (h.length % 2) h += "0";
  const bytes: number[] = [];
  for (let k = 0; k + 2 <= h.length; k += 2) bytes.push(parseInt(h.slice(k, k + 2), 16));
  return { bytes, at: i + 1 };
}

/** Bytes -> characters. UTF-16 BOM first, then the CMap, then Latin-1. */
function bytesToText(bytes: number[], cm: Cmaps): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return s;
  }
  if (cm.two.size && bytes.length >= 2 && bytes.length % 2 === 0) {
    let hits = 0;
    let s = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes[i] << 8) | bytes[i + 1];
      const hit = cm.two.get(code);
      if (hit !== undefined) { hits++; s += hit; } else s += String.fromCharCode(code);
    }
    if (hits * 2 >= bytes.length / 2) return s; // most pairs mapped: this is a code-per-two-bytes font
  }
  if (cm.one.size) {
    let hits = 0;
    let s = "";
    for (const b of bytes) {
      const hit = cm.one.get(b);
      if (hit !== undefined) { hits++; s += hit; } else s += String.fromCharCode(b);
    }
    if (hits * 2 >= bytes.length) return s;
  }
  return String.fromCharCode(...bytes);
}

/**
 * The text of one content stream. Strings are collected in order; a large kerning gap in a TJ array becomes a space, a
 * text-positioning or end-of-text operator becomes a line break.
 */
export function contentStreamText(raw: string, cm: Cmaps): string {
  const pieces: string[] = [];   // the rendered line so far
  let line = "";
  let pendingGap = false;        // a wide TJ adjustment right before the next string
  const endsLine = () => { pieces.push(line.replace(/[ \t]+$/g, "")); line = ""; pendingGap = false; };
  let inArray = false;
  let lastNum = 0;
  const end = raw.length;
  let i = 0;
  while (i < end) {
    const c = raw[i];
    if (c === "(") {
      const r = literal(raw, i, end);
      i = r.at;
      const t = bytesToText(r.bytes, cm);
      if (t) { if (pendingGap && !/\s$/.test(line)) line += " "; line += t; }
      pendingGap = false;
      continue;
    }
    if (c === "<" && raw[i + 1] !== "<") {
      const r = hexString(raw, i, end);
      i = r.at;
      const t = bytesToText(r.bytes, cm);
      if (t) { if (pendingGap && !/\s$/.test(line)) line += " "; line += t; }
      pendingGap = false;
      continue;
    }
    if (c === "[") { inArray = true; i++; continue; }
    if (c === "]") { inArray = false; i++; continue; }
    if (c === "-" || (c >= "0" && c <= "9") || c === ".") {
      let num = "";
      while (i < end && /[-+0-9.]/.test(raw[i])) num += raw[i++];
      const v = Number(num);
      if (Number.isFinite(v)) {
        lastNum = v;
        // A negative adjustment over about a quarter of an em is a space the producer did not write as a character.
        if (inArray && v <= -120) pendingGap = true;
      }
      continue;
    }
    if (/[A-Za-z'"]/.test(c)) {
      let op = "";
      while (i < end && /[A-Za-z0-9'"]/.test(raw[i])) op += raw[i++];
      // Tj, TJ, ' and " paint text; Td, TD, T*, TL-plus-quote and ET move the cursor.
      if (op === "'" || op === "\"") { if (line) endsLine(); }
      else if (op === "Td" || op === "TD" || op === "T*" || op === "ET") { if (line) endsLine(); }
      else if (op === "TJ") { if (lastNum <= -120) pendingGap = true; }
      continue;
    }
    i++;
  }
  if (line) endsLine();
  return pieces.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------- public API

const MAX_EXTRACT_CHARS = 400_000;

/** Position of a page's `/Contents`, in object numbers. */
function contentRefs(body: string): number[] {
  const single = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(body);
  if (single) return [Number(single[1])];
  const arr = /\/Contents\s*\[([^\]]*)\]/.exec(body);
  if (arr) return [...arr[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
  const inline = /\/Contents\s+\d+\s+\d+\s+obj/.test(body); // rare: an object header inside the page dictionary
  return inline ? [] : [];
}

/**
 * Reads a PDF's text. Never throws: a file that cannot be parsed comes back with no pages and no text.
 */
export function pdfText(buf: Buffer): PdfText {
  const empty = (method: string): PdfText => ({ pageCount: 0, pages: [], text: "", hasText: false, method });
  try {
    if (!isPdf(buf)) return empty("not a pdf");
    const raw = buf.toString("latin1");
    const objs = objects(raw);
    if (!objs.length) return empty("no objects");
    const byNum = new Map<number, RawObject>();
    for (const o of objs) if (!byNum.has(o.num)) byNum.set(o.num, o);

    // ToUnicode CMaps live in their own streams; they need the whole file's decoded streams.
    const allDecoded: Buffer[] = [];
    for (const o of objs) allDecoded.push(...decodedStreams(o.body));
    const cm = readCmaps(allDecoded);

    const pages = objs.filter((o) => /\/Type\s*\/Page[^s]/.test(o.body.slice(0, 2000)));
    const texts: string[] = [];
    if (pages.length) {
      for (const p of pages) {
        let text = "";
        for (const ref of contentRefs(p.body)) {
          const target = byNum.get(ref);
          if (!target) continue;
          for (const d of decodedStreams(target.body)) text += (text ? "\n" : "") + contentStreamText(d.toString("latin1"), cm);
        }
        texts.push(text.replace(/\n{3,}/g, "\n\n").trim());
      }
    } else {
      // No page tree we can read (a linearized or unusual file): use every stream that yields text.
      for (const d of allDecoded) {
        const t = contentStreamText(d.toString("latin1"), cm);
        if (t) texts.push(t);
      }
    }
    let text = texts.map((t, i) => (texts.length > 1 ? `--- page ${i + 1} ---\n${t}` : t)).join("\n\n");
    if (text.length > MAX_EXTRACT_CHARS) text = `${text.slice(0, MAX_EXTRACT_CHARS)}\n...[text truncated]`;
    // hasText is about the DOCUMENT's text, never about the "--- page N ---" markers this reader adds.
    const body = texts.join("\n").replace(/[^\x20-\x7E\u00a0-\uffff]+/g, "").trim();
    return { pageCount: pages.length, pages: texts, text, hasText: body.length >= 8, method: cm.two.size || cm.one.size ? "cmap" : "latin1" };
  } catch {
    return empty("unreadable");
  }
}
