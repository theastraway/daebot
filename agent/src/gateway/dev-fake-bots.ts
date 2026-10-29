// Dev/test only. A tiny in-memory fake of the bots + models REST contract, sitting in FRONT of the real gateway
// (a reverse proxy: anything it does not own is piped straight through), so the web UI can be built and screenshotted
// before the real endpoints land. Nothing here is imported by the gateway itself.
//
//   GET/POST /bots, PATCH/DELETE /bots/:id (PATCH takes model: an id, or null to clear), GET/PUT /bots/:id/instructions
//   GET /sessions?bot=<id>, GET /sessions (annotated with `bot`/`peer`), POST /sessions {bot,model}, PATCH /sessions/:id {model}
//   GET /models
import { request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { COOKIE_NAME, parseCookies, safeEqual } from "./auth.ts";
import { isFaceId } from "../bots/faces.ts";

export interface FakeBot { id: string; slug: string; name: string; purpose: string; color: string; face?: string | null; model?: string | null; pinned?: boolean; pinnedAt?: number | null; updatedAt: number; live: boolean; busy: boolean }

const MAX_INSTRUCTIONS = 8 * 1024;
const COLORS = ["#ffd25a", "#ff9a3d", "#7dff9a", "#5ee0ff", "#a98bff", "#ff7ad9"];

const MODELS = [
  { id: "qwen/qwen3.8-flash", name: "Qwen 3.8 Flash", free: false, allowed: true, price_hint: "$0.10 / $0.40 per 1M" },
  { id: "qwen/qwen3.8-flash:free", name: "Qwen 3.8 Flash (free)", free: true, allowed: true },
  { id: "mind/steady-1", name: "Steady 1", free: false, allowed: true, price_hint: "$0.30 / $1.20 per 1M" },
  { id: "mind/deep-2", name: "Deep 2", free: false, allowed: false, price_hint: "$3 / $15 per 1M" },
  { id: "mind/deep-2-long", name: "Deep 2 Long Context", free: false, allowed: false, price_hint: "$3 / $15 per 1M" },
];

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "bot";
const json = (res: ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(text);
};
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
const parse = (b: Buffer): Record<string, any> => { try { return JSON.parse(b.toString("utf8") || "{}"); } catch { return {}; } };

export function createBotsFake(opts: { token: string; backendPort: number; botLimit?: number; upgradeUrl?: string }) {
  const limit = opts.botLimit ?? 3;
  const now = Date.now();
  const bots = new Map<string, FakeBot>();
  const instructions = new Map<string, { text: string; updatedAt: number }>();
  const threadBot = new Map<string, { bot: string; peer?: string }>();
  const sessionModel = new Map<string, string>();
  let n = 0;

  const add = (name: string, purpose: string, color: string, flags: Partial<FakeBot>, text: string): FakeBot => {
    const id = `b${++n}`;
    const bot: FakeBot = { id, slug: slugify(name), name, purpose, color, updatedAt: now - n * 3_600_000, live: false, busy: false, ...flags };
    bots.set(id, bot);
    instructions.set(id, { text, updatedAt: now - n * 7_200_000 });
    return bot;
  };
  const quinn = add("Quinn", "Triage new TCPA claims every morning and flag the ones that need a lawyer", "#ffd25a", { live: true },
    "# Role\nYou are Quinn. Your job: triage new TCPA claims every morning.\n\n# How you work\n- Look in MIND before you answer. Say what you found.\n- Keep answers short and concrete.\n- Ask before anything that reaches a real person.\n\n# Never\n- Guess a number, name, price or date.\n");
  const ledger = add("Ledger", "Reconcile invoices against the bank feed", "#5ee0ff", { live: true, busy: true }, "# Role\nYou are Ledger. Reconcile invoices against the bank feed.\n");
  add("Scout", "Research a company before a call", "#7dff9a", {}, "# Role\nYou are Scout. Research a company before a call and report what matters.\n");

  /** Sessions the real runtime should know about, mapped to bots (seeded by dev-fake.ts). */
  const seedThreads = [
    { id: "seed-quinn-1", title: "Morning claims sweep", bot: quinn.id },
    { id: "seed-quinn-dm", title: "Handoff: three invoices to check", bot: quinn.id, peer: ledger.id },
    { id: "seed-ledger-1", title: "March bank feed", bot: ledger.id },
  ];
  for (const t of seedThreads) threadBot.set(t.id, { bot: t.bot, peer: t.peer });

  const authed = (req: IncomingMessage) => {
    const h = req.headers.authorization;
    if (h && h.startsWith("Bearer ") && safeEqual(h.slice(7), opts.token)) return true;
    const c = parseCookies(req.headers.cookie)[COOKIE_NAME];
    return !!c && safeEqual(c, opts.token);
  };

  function forward(req: IncomingMessage, res: ServerResponse, body?: Buffer, tap?: (status: number, payload: Buffer) => Buffer | void): void {
    const up = httpRequest({ host: "127.0.0.1", port: opts.backendPort, method: req.method, path: req.url, headers: req.headers }, (r) => {
      if (!tap) { res.writeHead(r.statusCode ?? 502, r.headers); return void r.pipe(res); }
      const chunks: Buffer[] = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        const raw = Buffer.concat(chunks);
        const out = tap(r.statusCode ?? 502, raw) ?? raw;
        const headers = { ...r.headers, "content-length": String(out.length) };
        delete headers["transfer-encoding"];
        res.writeHead(r.statusCode ?? 502, headers);
        res.end(out);
      });
    });
    up.on("error", () => { if (!res.headersSent) json(res, 502, { error: "backend unavailable" }); else res.destroy(); });
    if (body) up.end(body); else req.pipe(up);
  }

  /** Returns true when the request was answered here (or forwarded with a tap); false to let the caller pipe it through. */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname, method = req.method ?? "GET";
    const mine = path === "/bots" || path.startsWith("/bots/") || path === "/models"
      || (path === "/sessions" && (method === "GET" || method === "POST")) || (/^\/sessions\/[^/]+$/.test(path) && method === "PATCH");
    if (!mine) return false;
    if (!authed(req)) { json(res, 401, { error: "unauthorized" }); return true; }

    if (path === "/models" && method === "GET") { json(res, 200, { models: MODELS, default: MODELS[0].id }); return true; }

    if (path === "/bots") {
      if (method === "GET") { json(res, 200, { bots: [...bots.values()] }); return true; }
      if (method === "POST") {
        const b = parse(await readBody(req));
        const name = typeof b.name === "string" ? b.name.trim() : "";
        if (!name) { json(res, 400, { error: "name_required" }); return true; }
        if (bots.size >= limit) { json(res, 402, { error: "bot_limit", limit, tier: "Free", upgrade_url: opts.upgradeUrl ?? "https://example.com/upgrade" }); return true; }
        if ([...bots.values()].some((x) => x.name.toLowerCase() === name.toLowerCase())) { json(res, 409, { error: "name_taken" }); return true; }
        const text = typeof b.instructions === "string" ? b.instructions : "";
        if (Buffer.byteLength(text) > MAX_INSTRUCTIONS) { json(res, 413, { error: "instructions_too_long" }); return true; }
        const color = typeof b.color === "string" && /^#[0-9a-f]{6}$/i.test(b.color) ? b.color.toLowerCase() : COLORS[bots.size % COLORS.length];
        if (b.face !== undefined && b.face !== null && b.face !== "" && !isFaceId(b.face)) { json(res, 400, { error: "bad_face" }); return true; }
        const bot = add(name.slice(0, 40), typeof b.purpose === "string" ? b.purpose.slice(0, 140) : "", color, { face: b.face || null }, text);
        json(res, 201, bot);
        return true;
      }
    }

    if (path === "/bots") { json(res, 405, { error: "method not allowed" }); return true; }

    const m = /^\/bots\/([^/]+)(\/instructions)?$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const bot = bots.get(id);
      if (!bot) { json(res, 404, { error: "not_found" }); return true; }
      if (m[2]) {
        if (method === "GET") { json(res, 200, instructions.get(id) ?? { text: "", updatedAt: 0 }); return true; }
        if (method === "PUT") {
          const text = parse(await readBody(req)).text;
          if (typeof text !== "string") { json(res, 400, { error: "bad_request" }); return true; }
          if (Buffer.byteLength(text) > MAX_INSTRUCTIONS) { json(res, 413, { error: "instructions_too_long" }); return true; }
          const v = { text, updatedAt: Date.now() };
          instructions.set(id, v);
          json(res, 200, v);
          return true;
        }
      } else {
        if (method === "PATCH") {
          const b = parse(await readBody(req));
          if (typeof b.name === "string" && b.name.trim()) {
            if ([...bots.values()].some((x) => x.id !== id && x.name.toLowerCase() === b.name.trim().toLowerCase())) { json(res, 409, { error: "name_taken" }); return true; }
            bot.name = b.name.trim().slice(0, 40); bot.slug = slugify(bot.name);
          }
          if (typeof b.purpose === "string") bot.purpose = b.purpose.slice(0, 140);
          if (typeof b.color === "string" && /^#[0-9a-f]{6}$/i.test(b.color)) bot.color = b.color.toLowerCase();
          if (b.face !== undefined) {
            if (b.face !== null && b.face !== "" && !isFaceId(b.face)) { json(res, 400, { error: "bad_face" }); return true; }
            bot.face = b.face || null;
          }
          if (b.model !== undefined) {
            if (b.model === null || b.model === "") bot.model = null;
            else { const row = MODELS.find((x) => x.id === b.model); if (!row) { json(res, 400, { error: "unknown_model" }); return true; } if (!row.allowed) { json(res, 403, { error: "model_locked" }); return true; } bot.model = row.id; }
          }
          if (b.pinned !== undefined) {
            if (typeof b.pinned !== "boolean") { json(res, 400, { error: "bad_pinned" }); return true; }
            bot.pinned = b.pinned; bot.pinnedAt = b.pinned ? (bot.pinnedAt ?? Date.now()) : null;
          }
          if (Object.keys(b).some((k) => k !== "pinned")) bot.updatedAt = Date.now();
          json(res, 200, bot);
          return true;
        }
        if (method === "DELETE") { bots.delete(id); instructions.delete(id); json(res, 200, { ok: true }); return true; }
      }
      json(res, 405, { error: "method not allowed" });
      return true;
    }

    if (path === "/sessions" && method === "GET") {
      const want = url.searchParams.get("bot");
      forward(req, res, undefined, (status, raw) => {
        if (status !== 200) return;
        const list: any[] = parse(raw).sessions ?? [];
        const annotated = list.map((s) => ({ ...s, ...(threadBot.get(s.id) ? { bot: threadBot.get(s.id)!.bot, peer: threadBot.get(s.id)!.peer } : {}) }));
        const out = want ? annotated.filter((s) => s.bot === want) : annotated;
        return Buffer.from(JSON.stringify({ sessions: out }));
      });
      return true;
    }
    if (path === "/sessions" && method === "POST") {
      const body = await readBody(req);
      const b = parse(body);
      if (typeof b.bot === "string" && !bots.has(b.bot)) { json(res, 404, { error: "no_such_bot" }); return true; }
      if (typeof b.model === "string" && MODELS.find((x) => x.id === b.model && !x.allowed)) { json(res, 403, { error: "model_locked" }); return true; }
      forward(req, res, body, (status, raw) => {
        if (status === 200) {
          const id = parse(raw).sessionId;
          if (id && typeof b.bot === "string") threadBot.set(id, { bot: b.bot });
          if (id && typeof b.model === "string") sessionModel.set(id, b.model);
        }
      });
      return true;
    }
    if (method === "PATCH") {
      const id = decodeURIComponent(path.split("/")[2]);
      const model = parse(await readBody(req)).model;
      const row = MODELS.find((x) => x.id === model);
      if (!row) { json(res, 400, { error: "unknown_model" }); return true; }
      if (!row.allowed) { json(res, 403, { error: "model_locked" }); return true; }
      sessionModel.set(id, row.id);
      json(res, 200, { id, model: row.id });
      return true;
    }
    return false;
  }

  return { handle, seedThreads, botCount: () => bots.size };
}
