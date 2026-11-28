// Likeness for Craft mode / the loop: capture the reference page and the built page at each width and score them with likeness/score.ts.
// Shadow-safe: every capture has a ceiling, any failure becomes { measured: false, note } and the loop goes on. Nothing here throws.
import type { Raster } from "./score.ts";
import { reportAcross, widthScore, type WidthScore } from "./score.ts";
import { cropRaster, decodePng } from "./png.ts";
import type { BrowserHost } from "../browser/host.ts";
import { navigationAllowed } from "../browser/policy.ts";

export const LIKENESS_WIDTHS = [390, 768, 1280] as const;
export const VIEW_HEIGHT = 900;

/** Something that can photograph a URL at a width (the desktop browser pane), or say it cannot. */
export interface PageCapture {
  available(): boolean;
  /** Why it cannot capture here (shown on the card as "likeness: not measured here"). */
  reason?: string;
  shot(url: string, width: number, signal?: AbortSignal): Promise<Raster>;
}

export interface LikenessResult { measured: boolean; similarity?: number; widths?: { width: number; similarity: number }[]; worst?: number; note?: string }

const round1 = (n: number) => Math.round(n * 10) / 10;

async function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error("timed out")), ms); })]); } finally { if (t) clearTimeout(t); }
}

/** Two rasters of one width: same size first (the shorter page sets the height), then layout + detail. */
export function compareRasters(a: Raster, b: Raster, width: number): WidthScore {
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  return { width, ...widthScore(cropRaster(a, w, h), cropRaster(b, w, h)) };
}

/**
 * Reference vs build at every width. `refCache` keeps the reference shots between rounds (the original does not change).
 * Never throws: no capture, a refused URL, a timeout or a bad image all come back as measured:false with a plain note.
 */
export async function measureLikeness(o: { capture?: PageCapture; reference?: string; build?: string; widths?: readonly number[]; timeoutMs?: number; signal?: AbortSignal; refCache?: Map<string, Raster> }): Promise<LikenessResult> {
  if (!o.capture || !o.capture.available()) return { measured: false, note: `not measured here${o.capture?.reason ? ` (${o.capture.reason})` : " (no browser to capture pages in this environment)"}` };
  if (!o.reference) return { measured: false, note: "not measured: no reference URL to match" };
  if (!o.build) return { measured: false, note: "not measured: the build gave no preview URL" };
  const widths = o.widths ?? LIKENESS_WIDTHS;
  const ms = o.timeoutMs ?? 20_000;
  const scores: WidthScore[] = [];
  try {
    for (const w of widths) {
      if (o.signal?.aborted) return { measured: false, note: "not measured: stopped" };
      const key = `${o.reference}@${w}`;
      let ref = o.refCache?.get(key);
      if (!ref) { ref = await within(o.capture.shot(o.reference, w, o.signal), ms); o.refCache?.set(key, ref); }
      const got = await within(o.capture.shot(o.build, w, o.signal), ms);
      scores.push(compareRasters(ref, got, w));
    }
  } catch (e) {
    return { measured: false, note: `not measured: ${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 120)}` };
  }
  const r = reportAcross(scores);
  return { measured: true, similarity: round1(r.similarity), widths: r.widths.map((x) => ({ width: x.width, similarity: round1(x.similarity) })), ...(r.worst ? { worst: r.worst.width } : {}) };
}

/** Desktop capture through Daebot's browser pane (CDP): its own tab, the width set by device metrics, a PNG of the viewport, the tab closed. */
export function createBrowserCapture(host: () => BrowserHost | undefined, o: { settleMs?: number } = {}): PageCapture {
  return {
    available: () => { try { return !!host()?.connected(); } catch { return false; } },
    reason: "the desktop browser pane is not connected",
    async shot(url, width) {
      const h = host();
      if (!h || !h.connected()) throw new Error("the browser pane is not connected");
      const nav = navigationAllowed(url, h.snapshot().gatewayOrigin);
      if (!nav.ok) throw new Error(nav.reason ?? "URL refused");
      const opened = await h.call("open", { url }) as { tabId?: string };
      const tabId = typeof opened?.tabId === "string" ? opened.tabId : "";
      if (!tabId) throw new Error("the browser did not open a tab");
      const cdp = (method: string, params: Record<string, unknown>) => h.call("cdp", { tabId, method, params }) as Promise<{ data?: string } | undefined>;
      try {
        await cdp("Emulation.setDeviceMetricsOverride", { width, height: VIEW_HEIGHT, deviceScaleFactor: 1, mobile: width < 600 });
        await cdp("Page.reload", {}).catch(() => undefined);
        await new Promise((r) => setTimeout(r, o.settleMs ?? 1500));
        const out = await cdp("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height: VIEW_HEIGHT, scale: 1 } });
        if (!out || typeof out.data !== "string" || !out.data) throw new Error("the page gave no screenshot");
        return decodePng(Buffer.from(out.data, "base64"));
      } finally {
        await h.call("close", { tabId }).catch(() => undefined);
      }
    },
  };
}
