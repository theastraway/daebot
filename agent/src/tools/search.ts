// web_search: ranked web results (title, URL, snippet) for a query, through OpenRouter's web-search plugin.
//
// One non-streaming chat call with `plugins: [{ id: "web", max_results }]` on a cheap model. The plugin runs the search BEFORE the model
// and returns every hit as an `annotations[].url_citation` ({ url, title, content }) on the message; we hand those back as the result and
// ignore the model's own text (max_tokens is tiny). On MIND billing the call goes to MIND's /llm/chat/completions proxy with the user's own
// key, so the cost (the plugin's per-result fee plus a few tokens) is deducted from their MIND credits; the amount is in result.meta.costUsd.
// Results are text from other people's pages: they are quoted as untrusted data, and web_fetch reads a hit in full.
import type { Tool } from "../types.ts";
import { fail, ok } from "./util.ts";
import { quoteUntrusted } from "./untrusted.ts";
import { refusalText, type LlmEndpoint } from "./llm-call.ts";

export const SEARCH_MODEL = "deepseek/deepseek-v4.1-flash";
export const DEFAULT_RESULTS = 5;
export const MAX_RESULTS = 8;
const SNIPPET = 420;
const TIMEOUT_MS = 45_000;

export interface SearchHit { rank: number; title: string; url: string; snippet: string }

/** The url_citation annotations of a chat completion, deduplicated by URL, in the order the search ranked them. */
export function parseSearchHits(body: unknown, max = MAX_RESULTS): SearchHit[] {
  const ann = (body as any)?.choices?.[0]?.message?.annotations;
  if (!Array.isArray(ann)) return [];
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const a of ann) {
    const c = a?.type === "url_citation" ? a.url_citation ?? a : undefined;
    const url = typeof c?.url === "string" ? c.url.trim() : "";
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const title = typeof c.title === "string" && c.title.trim() ? c.title.trim() : url;
    let raw = typeof c.content === "string" ? c.content : "";
    if (raw.startsWith(title)) raw = raw.slice(title.length); // the plugin repeats the title at the top of the content
    const snippet = raw.replace(/[#*_`>]+/g, " ").replace(/\s+/g, " ").trim().slice(0, SNIPPET);
    hits.push({ rank: hits.length + 1, title: title.slice(0, 200), url, snippet });
    if (hits.length >= max) break;
  }
  return hits;
}

export interface WebSearchOptions {
  endpoint: () => LlmEndpoint | undefined;
  fetchImpl?: typeof fetch;
  model?: string;
  timeoutMs?: number;
}

export function createWebSearchTool(o: WebSearchOptions): Tool {
  const model = o.model || SEARCH_MODEL;
  return {
    class: "read",
    receipt: "surface",
    spec: {
      name: "web_search",
      description:
        "Search the public web and get ranked results: title, URL and a text snippet for each. Use it when you do not already have the URL: current events, prices, versions, docs, people, companies, anything that may have changed. " +
        "Then read the best hit in full with web_fetch, and cite the URLs you used in your answer. Costs about a cent per search (deducted from the user's MIND credits).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for, as a specific search query (names, versions, dates)." },
          max_results: { type: "number", description: `How many results, 1 to ${MAX_RESULTS} (default ${DEFAULT_RESULTS}).` },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    async run(args, ctx) {
      const query = typeof args.query === "string" ? args.query.replace(/\s+/g, " ").trim() : "";
      if (!query) return fail("web_search: query is required");
      if (query.length > 400) return fail("web_search: query is over 400 characters; search for the key terms");
      const n = Math.min(MAX_RESULTS, Math.max(1, Math.round(Number(args.max_results)) || DEFAULT_RESULTS));
      const ep = o.endpoint();
      if (!ep) return fail("web_search: no model provider is configured on this server (needs a MIND key or OPENROUTER_API_KEY)");
      const doFetch = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
      const timeout = AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
      try {
        const res = await doFetch(ep.url, {
          method: "POST",
          headers: ep.headers(),
          body: JSON.stringify({
            model,
            messages: [{ role: "system", content: "Reply with the single word OK." }, { role: "user", content: query }],
            plugins: [{ id: "web", max_results: n }],
            max_tokens: 24,
            usage: { include: true },
          }),
          signal,
        });
        const text = await res.text();
        if (!res.ok) return fail(`web_search: ${refusalText(res.status, text)}`);
        let body: any;
        try { body = JSON.parse(text); } catch { return fail("web_search: the search service sent a reply that was not JSON"); }
        if (body?.error) return fail(`web_search: ${String(body.error?.message ?? body.error).slice(0, 200)}`);
        const costUsd = Math.max(0, Number(body?.usage?.cost) || 0);
        const hits = parseSearchHits(body, n);
        const meta = { costUsd, inputTokens: Number(body?.usage?.prompt_tokens) || 0, outputTokens: Number(body?.usage?.completion_tokens) || 0, results: hits.length, model: String(body?.model ?? model), via: ep.via };
        if (!hits.length) return ok(`web_search: no results for "${query.slice(0, 120)}". Try different words.`, meta);
        const lines = hits.map((h) => `${h.rank}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ""}`).join("\n");
        return ok(quoteUntrusted(`Web search results for "${query.slice(0, 100)}" (title, URL, snippet; open one with web_fetch)`, lines, 14_000), meta);
      } catch (e) {
        if (ctx.signal?.aborted) return fail("web_search: stopped");
        return fail(`web_search: ${(e as Error)?.name === "TimeoutError" ? "the search timed out" : String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200)}`);
      }
    },
  };
}
