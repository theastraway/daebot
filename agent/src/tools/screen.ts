import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Tool, ToolResult } from "../types.ts";
import { fail } from "./util.ts";
import { frameDataUrl, pickKeyframes, screenFeed, DEFAULT_CHANGE_THRESHOLD, MAX_BUFFER_SECONDS } from "../screen/feed.ts";
import type { Frame, Region, ScreenFeed } from "../screen/feed.ts";

// `screen`: the model's eyes on the user's live screen feed (desktop app only, and only while the user has "Let Daebot watch my screen" on).
// It reads frames the desktop shell already captured into memory, so `look` is instant and needs no PowerShell. It never moves the mouse or types.

const ACTIONS = ["status", "look", "wait_for_change", "clip", "save"] as const;
type Action = (typeof ACTIONS)[number];
const MAX_WAIT_S = 120;
const DEFAULT_WAIT_S = 30;
const MAX_CLIP_FRAMES = 6;
const DEFAULT_CLIP_FRAMES = 4;
const FIRST_FRAME_WAIT_MS = 3000;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** Offered on every local gateway (the desktop app is where the feed comes from); the hosted allowlist never lets it through. */
export function screenToolSupported(env: NodeJS.ProcessEnv = process.env): boolean {
  return !(env.DAEBOT_SCREEN_WATCH === "0" || env.DAEBOT_SCREEN_WATCH === "false");
}

/** Why the feed cannot give a frame right now, in words the model can pass on. Undefined when it can. */
export function feedBlocker(feed: ScreenFeed): string | undefined {
  const s = feed.state();
  if (!feed.attached) return "Screen watching is only available in the Daebot desktop app.";
  if (!s.watching) return 'Screen watching is OFF. The user has not turned on "Let Daebot watch my screen" (account menu in the Daebot window, or the tray menu). Ask them to turn it on if they want you to look; do not try another way to see the screen.';
  if (s.permission === "needs-permission") return "Daebot does not have Screen Recording permission yet. The app shows a card with an Open System Settings button; the user has to grant it themselves, then reopen Daebot.";
  if (s.permission === "restricted") return "Screen capture is restricted on this computer by a system policy. Tell the user; nothing you can do.";
  if (s.permission === "unsupported") return "Screen capture is not supported on this system.";
  if (s.permission !== "granted") return "The screen permission has not been checked yet. Try again in a moment.";
  if (s.error) return `Screen capture reported a problem: ${s.error}`;
  return undefined;
}

const ago = (ms: number): string => (ms < 1500 ? "just now" : `${(ms / 1000).toFixed(1)}s ago`);

function frameLine(f: Frame, now: number): string {
  return `Frame ${f.width}x${f.height} (screen ${f.screenWidth}x${f.screenHeight}), captured ${ago(now - f.t)}, cursor at ${f.cursorX},${f.cursorY}. Coordinates in this frame are the same ones the computer tool takes.`;
}

export function createScreenTool(feed: ScreenFeed = screenFeed, opts: { now?: () => number; home?: string } = {}): Tool {
  const now = opts.now ?? Date.now;
  return {
    class: "read",
    receipt: "surface",
    classFor: (args) => (args.action === "save" ? "write" : "read"),
    spec: {
      name: "screen",
      description:
        "Your eyes on the user's live screen, from a feed the desktop app keeps in memory (about 2 frames a second, only while the user has Let Daebot watch my screen turned ON). No PowerShell, no screenshot step, no mouse or keyboard: it only looks. " +
        "Use it instead of a computer screenshot, and instead of a fixed wait, whenever you need to see the screen. Background tools (connectors, web_fetch, bash, app) still come first; this is for when the screen is the thing to read. " +
        "You do NOT see the screen between calls: you see it only when you call this. " +
        "Actions: status (is the feed on, permission, frames held) | look (the latest frame, instant) | " +
        "wait_for_change (block until the screen changes by more than threshold, a fraction 0-1, default 0.02, or timeout_seconds passes, default 30, max 120; then returns the settled new frame. Optional region {x,y,w,h} in frame pixels to watch only part of the screen, for example a progress bar or a download list. Use this instead of sleeping: \"wait until the download finishes\", \"wait for the page to load\") | " +
        "clip (what just happened: keyframes from the last seconds, default 10, up to frames, default 4, max 6, first and last included, the rest where the screen changed most) | " +
        "save (write the last seconds of frames as JPEG files to dir; ONLY when the user asked to save a clip; default dir is a new folder under ~/Daebot clips).",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: [...ACTIONS] },
          timeout_seconds: { type: "number", description: "wait_for_change: how long to wait (default 30, max 120)." },
          threshold: { type: "number", description: "wait_for_change: fraction of the screen (or region) that must change, 0-1 (default 0.02)." },
          region: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } }, description: "wait_for_change: only watch this rectangle, in frame pixels." },
          seconds: { type: "number", description: "clip/save: how far back to look (default 10)." },
          frames: { type: "number", description: "clip: how many keyframes (default 4, max 6)." },
          dir: { type: "string", description: "save: folder to write into." },
        },
        required: ["action"],
      },
    },
    async run(args, ctx): Promise<ToolResult> {
      const action = args.action as Action;
      if (!ACTIONS.includes(action)) return fail(`screen: action must be one of ${ACTIONS.join(", ")}`);
      const s = feed.state();
      if (action === "status") {
        const blocked = feedBlocker(feed);
        const f = feed.latest();
        return {
          ok: true,
          output: [
            `Screen watching: ${s.watching ? "ON" : "OFF"}. Permission: ${s.permission}. Rate: ${s.fps} frames/s. Frames held: ${feed.count()} (${feed.span().toFixed(0)}s of ${s.bufferSeconds}s). Latest: ${f ? ago(now() - f.t) : "none"}.`,
            blocked ? `Not usable now: ${blocked}` : "Ready: look, wait_for_change and clip work.",
          ].join("\n"),
        };
      }
      const blocked = feedBlocker(feed);
      if (blocked) return fail(`screen: ${blocked}`);

      if (action === "look") {
        const f = feed.latest() ?? (await feed.next({ timeoutMs: FIRST_FRAME_WAIT_MS, signal: ctx.signal }));
        if (!f) return fail("screen: no frame yet. The feed is on but nothing has arrived; try again in a second.");
        return { ok: true, output: frameLine(f, now()), images: [frameDataUrl(f)], meta: { width: f.width, height: f.height } };
      }

      if (action === "wait_for_change") {
        const timeout = Math.min(MAX_WAIT_S, Math.max(1, num(args.timeout_seconds) ?? DEFAULT_WAIT_S));
        const threshold = Math.min(1, Math.max(0.001, num(args.threshold) ?? DEFAULT_CHANGE_THRESHOLD));
        let region: Region | undefined;
        if (args.region !== undefined) {
          const r = args.region as Record<string, unknown>;
          const x = num(r?.x), y = num(r?.y), w = num(r?.w), h = num(r?.h);
          if (x === undefined || y === undefined || w === undefined || h === undefined || w <= 0 || h <= 0) return fail("screen: region needs numeric x, y, w and h (w and h above 0), in frame pixels");
          region = { x, y, w, h };
        }
        const r = await feed.waitForChange({ timeoutMs: timeout * 1000, threshold, region, signal: ctx.signal });
        if (ctx.signal?.aborted) return fail("screen: aborted");
        if (!r) return fail("screen: no frame arrived to compare against (the feed may have been turned off).");
        const waited = (r.waitedMs / 1000).toFixed(1);
        return {
          ok: true,
          output: r.changed
            ? `The screen changed after ${waited}s (${(r.score * 100).toFixed(1)}% of ${region ? "the region" : "the screen"} differed), then settled. ${frameLine(r.frame, now())}`
            : `No change above ${(threshold * 100).toFixed(1)}% in ${waited}s: timed out. This is the latest frame. ${frameLine(r.frame, now())}`,
          images: [frameDataUrl(r.frame)],
          meta: { changed: r.changed, waitedMs: r.waitedMs, width: r.frame.width, height: r.frame.height },
        };
      }

      const seconds = Math.min(MAX_BUFFER_SECONDS, Math.max(1, num(args.seconds) ?? 10));
      if (action === "clip") {
        const n = Math.min(MAX_CLIP_FRAMES, Math.max(1, Math.round(num(args.frames) ?? DEFAULT_CLIP_FRAMES)));
        const held = feed.recent(seconds);
        if (!held.length) return fail("screen: no frames in that window yet.");
        const keys = pickKeyframes(held, n);
        const t0 = keys[0].t;
        const times = keys.map((k) => `t+${((k.t - t0) / 1000).toFixed(1)}s`).join(", ");
        return {
          ok: true,
          output: `${keys.length} keyframes from the last ${Math.round((now() - held[0].t) / 1000)}s (${held.length} frames held in that window), oldest first, at ${times}. The last is the current screen. ${frameLine(keys[keys.length - 1], now())}`,
          images: keys.map(frameDataUrl),
          meta: { imageCap: MAX_CLIP_FRAMES, frames: keys.length },
        };
      }

      // save
      const base = opts.home ?? homedir();
      const dir = typeof args.dir === "string" && args.dir.trim() ? resolve(ctx.cwd || ".", args.dir.trim()) : join(base, "Daebot clips", new Date(now()).toISOString().replace(/[:.]/g, "-"));
      const wrote = feed.save(dir, seconds);
      if (!wrote.files.length) return fail("screen: no frames in that window to save.");
      return { ok: true, output: `Saved ${wrote.files.length} frames (last ${seconds}s) to ${wrote.dir}. They are JPEG files; nothing else was written.` };
    },
  };
}
