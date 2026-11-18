// web_fetch: GET a public URL and return its text. Every hop goes through the SSRF guard (pinned DNS,
// private-address block, redirects re-checked). The page is quoted as untrusted and instruction-shaped
// chunks are withheld. Desktop users still reach localhost with bash; this tool does not.
import type { Tool } from "../types.ts";
import { createSafeFetch, responseFinalUrl, SsrfError, type Resolver, type Transport } from "../mcpconnect/ssrf.ts";
import { cap, errMsg, fail, ok } from "./util.ts";
import { quoteUntrusted } from "./untrusted.ts";
import { screenUntrustedText, withScreenNotice } from "./text-screen.ts";

const WEB_CAP = 50_000;
const WEB_MAX_BYTES = 2_000_000;
const WEB_MAX_REDIRECTS = 5;
const UA = "Daebot/0.3 (+https://daebot.live)";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "-", ndash: "-", hellip: "..." };

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br|ul|ol|table|blockquote|pre)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface WebFetchOptions {
  /** Existing seam from createBuiltinTools. The guard still runs first; this fetch does not follow redirects. */
  fetchImpl?: typeof fetch;
  /** Test seam: resolve a hostname without DNS. */
  resolve?: Resolver;
  /** Test seam: the pinned request, with no socket. Wins over fetchImpl. */
  transport?: Transport;
}

/** Read a fetch body but stop once it passes the cap, so a huge page cannot fill memory. */
async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => {}); throw new SsrfError("the response was too large and was cut off"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function transportFromFetch(fetchImpl: typeof fetch): Transport {
  return async (req) => {
    // redirect manual: createSafeFetch follows hops itself and re-checks each one. The injected fetch is
    // the test double (or a caller-supplied fetch); the node transport is what pins production connections.
    const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body, redirect: "manual", signal: req.signal });
    const buf = await readCapped(res, req.maxBytes);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return { status: res.status, headers, body: buf };
  };
}

export function createWebFetchTool(fetchImplOrOpts?: typeof fetch | WebFetchOptions): Tool {
  const o: WebFetchOptions = typeof fetchImplOrOpts === "function" ? { fetchImpl: fetchImplOrOpts } : (fetchImplOrOpts ?? {});
  const net = createSafeFetch({
    resolve: o.resolve,
    transport: o.transport ?? (o.fetchImpl ? transportFromFetch(o.fetchImpl) : undefined),
    allowHttp: true,
    maxRedirects: WEB_MAX_REDIRECTS,
    maxBytes: WEB_MAX_BYTES,
  });
  return {
    class: "read",
    receipt: "surface",
    spec: {
      name: "web_fetch",
      description:
        "Read any public web page or JSON API in the background: HTTP GET a URL and return its text (HTML is stripped to plain text). " +
        "Public addresses only: private, loopback and link-local hosts are refused. On a desktop, reach localhost with bash. " +
        "Capped at 50k chars. Use this for what is on a site, weather, prices, docs; never open a browser on the screen to read a page.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
    async run(args, ctx) {
      const url = args.url;
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return fail("web_fetch: url must start with http:// or https://");
      try {
        const res = await net(url, {
          method: "GET",
          headers: { "User-Agent": UA, Accept: "text/html,text/plain,application/json,*/*" },
          redirects: "public",
          signal: ctx.signal,
        });
        const raw = await res.text();
        const type = res.headers.get("content-type") ?? "";
        const text = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw) : raw;
        const screened = screenUntrustedText(text);
        const body = res.ok ? cap(screened.text, WEB_CAP) : screened.text.slice(0, 2000);
        const shown = withScreenNotice({ text: body, withheld: screened.withheld });
        const finalUrl = responseFinalUrl(res) || url;
        const wrapped = quoteUntrusted(`Web page ${finalUrl}`, shown, Math.max(shown.length, 1));
        const meta = { status: res.status, contentType: type, withheld: screened.withheld };
        if (!res.ok) return { ok: false, output: `web_fetch: HTTP ${res.status}\n${wrapped}`, meta };
        return ok(wrapped, meta);
      } catch (e) {
        return fail(`web_fetch: ${errMsg(e)}`);
      }
    },
  };
}
