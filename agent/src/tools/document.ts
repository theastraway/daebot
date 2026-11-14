// read_document: read a document (PDF) the user attached to this chat.
//
// The chat model is text-first, so an attached PDF is extracted to text (src/pdf.ts) and handed back as a tool result
// with the pages it came from. The bytes never leave this host and no model is billed: this is a pure read of what the
// user attached. Read-only: it changes nothing anywhere, and it can only reach attachments of the session it runs in
// (ctx.sessionId), through the PhotoStore of the runtime's own owner.
import type { Tool } from "../types.ts";
import type { PhotoMeta, PhotoStore } from "../photos.ts";
import { pdfText } from "../pdf.ts";
import { cap, fail, ok } from "./util.ts";

const MAX_PAGES_PER_CALL = 40;      // a very long PDF is read in page windows, not one giant blob
const MAX_CHARS = 60_000;           // per call, so one huge document cannot fill the context
const NO_TEXT = "This document has no text layer (it is a scan or an image-only PDF). Tell the user plainly that its text cannot be read, and that a photo of the page works: attach a picture of it and view_photo reads it.";

export interface ReadDocumentOptions {
  store: Pick<PhotoStore, "list" | "read">;
}

/** "3", "3-7", "1,4,9-12", "all" -> page numbers (1-based), or an error line. */
export function parsePages(raw: unknown, pageCount: number): { ok: true; pages: number[]; capped: boolean } | { ok: false; error: string } {
  const total = Math.max(1, pageCount);
  if (raw === undefined || raw === null || raw === "" || String(raw).trim().toLowerCase() === "all") {
    const all = Array.from({ length: total }, (_, i) => i + 1);
    return { ok: true, pages: all.slice(0, MAX_PAGES_PER_CALL), capped: all.length > MAX_PAGES_PER_CALL };
  }
  const out: number[] = [];
  for (const part of String(raw).split(/[\s,;]+/).filter(Boolean)) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!m) return { ok: false, error: `read_document: "${part.slice(0, 20)}" is not a page or a range (use 3, 3-7, 1,4,9-12 or "all")` };
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (from < 1 || to < from) return { ok: false, error: `read_document: bad page range "${part.slice(0, 20)}"` };
    for (let p = from; p <= Math.min(to, total); p++) if (!out.includes(p)) out.push(p);
  }
  if (!out.length) return { ok: false, error: `read_document: no page in that range exists (this document has ${total})` };
  out.sort((a, b) => a - b);
  return { ok: true, pages: out.slice(0, MAX_PAGES_PER_CALL), capped: out.length > MAX_PAGES_PER_CALL };
}

export function createReadDocumentTool(o: ReadDocumentOptions): Tool {
  return {
    class: "read",        // changes nothing, so it never raises a permission card
    receipt: "surface",   // a read of what the user attached: it backs the numbers the answer quotes
    spec: {
      name: "read_document",
      description:
        "Read the text of a document (PDF) the user attached to this chat. Call it before you answer anything about a PDF: you cannot see the file yourself. " +
        "Documents are listed in the user's message as [document p1: name.pdf, 4 pages]. Use pages to read a window of a long file (for example \"3-7\"), or leave it out for the whole document. " +
        "A scanned PDF has no text layer: the tool says so, and a photo of the page read with view_photo is the way to read it. No cost.",
      parameters: {
        type: "object",
        properties: {
          document: { type: "string", description: "A document id from the user's message (p1), or \"all\" for every document in this chat (newest 4)." },
          pages: { type: "string", description: "Which pages to read: \"all\" (default), a page (\"4\"), a range (\"3-7\") or a list (\"1,4,9-12\")." },
        },
        required: ["document"],
        additionalProperties: false,
      },
    },
    async run(args, ctx) {
      const have = o.store.list(ctx.sessionId).filter((p) => p.kind === "document");
      if (have.length === 0) {
        const any = o.store.list(ctx.sessionId);
        return fail(any.length
          ? `read_document: this chat has no documents. It holds ${any.length} photo${any.length === 1 ? "" : "s"}; use view_photo for those.`
          : "read_document: this chat has no attachments. Tell the user nothing arrived and ask them to attach it again.");
      }

      const want = String(args.document ?? "").trim().toLowerCase();
      const picked: PhotoMeta[] = [];
      if (!want || want === "all") {
        picked.push(...have.slice(-4));
      } else {
        for (const id of want.split(/[\s,;]+/).filter(Boolean)) {
          const norm = /^\d+$/.test(id) ? `p${id}` : id;
          const hit = have.find((p) => p.id === norm);
          if (!hit) return fail(`read_document: no document "${id.slice(0, 20)}" in this chat. Available: ${have.map((p) => `${p.id} (${p.name})`).join(", ")}`);
          if (!picked.includes(hit)) picked.push(hit);
        }
      }

      const chunks: string[] = [];
      let anyText = false;
      for (const meta of picked) {
        const hit = await o.store.read(ctx.sessionId, meta.id);
        if (!hit) return fail(`read_document: ${meta.id} could not be read from storage. Ask the user to attach it again.`);
        const read = pdfText(hit.data);
        const total = read.pages.length || read.pageCount || 1;
        const pick = parsePages(args.pages, total);
        if (!pick.ok) return fail(pick.error);
        const body = read.pages.length
          ? pick.pages.map((n) => `--- page ${n} ---\n${(read.pages[n - 1] ?? "").trim()}`).join("\n\n")
          : read.text;
        // What the document itself says, without the "--- page N ---" markers this reader adds: a scan has none of it.
        const real = read.pages.length ? pick.pages.map((n) => read.pages[n - 1] ?? "").join("") : read.text;
        if (real.replace(/[^\x20-\x7E\u00a0-\uffff]+/g, "").trim().length > 0) anyText = true;
        const text = cap(body.trim() || "(no text on this page)", MAX_CHARS);
        const head = `${meta.id} (${meta.name})${read.pageCount ? `, ${read.pageCount} page${read.pageCount === 1 ? "" : "s"}` : ""}, read ${pick.pages[0]}${pick.pages.length > 1 ? `-${pick.pages[pick.pages.length - 1]}` : ""} of ${total}`;
        chunks.push(`${head}\n${text}${pick.capped ? `\n[Only the first ${MAX_PAGES_PER_CALL} pages of this window were read; ask for the rest by page.]` : ""}`);
      }

      if (!anyText) return { ok: false, output: `read_document: ${NO_TEXT}\n\nWhat was there:\n${cap(chunks.join("\n\n"), 4000)}`, meta: { documents: picked.map((p) => p.id), empty: true } };
      return ok(chunks.join("\n\n"), { documents: picked.map((p) => p.id), pages: picked.map((p) => p.pages ?? null) });
    },
  };
}
