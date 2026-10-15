import type { Tool } from "../types.ts";
import { cap, errMsg, fail, ok } from "./util.ts";

const WEB_CAP = 50_000;

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

export function createWebFetchTool(fetchImpl: typeof fetch = fetch): Tool {
  return {
    class: "read",
    receipt: "surface",
    spec: {
      name: "web_fetch",
      description: "HTTP GET a URL and return its text (HTML is stripped to plain text). Capped at 50k chars.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
    async run(args, ctx) {
      const url = args.url;
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return fail("web_fetch: url must start with http:// or https://");
      try {
        const res = await fetchImpl(url, {
          method: "GET",
          headers: { "User-Agent": "MINDClaw/0.2 (+https://www.m-i-n-d.ai/mindclaw)", Accept: "text/html,text/plain,application/json,*/*" },
          redirect: "follow",
          signal: ctx.signal,
        });
        const raw = await res.text();
        const type = res.headers.get("content-type") ?? "";
        const text = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw) : raw;
        const body = cap(text, WEB_CAP);
        if (!res.ok) return { ok: false, output: `web_fetch: HTTP ${res.status}\n${body.slice(0, 2000)}`, meta: { status: res.status } };
        return ok(body, { status: res.status, contentType: type });
      } catch (e) {
        return fail(`web_fetch: ${errMsg(e)}`);
      }
    },
  };
}
