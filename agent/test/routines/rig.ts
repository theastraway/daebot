import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutineRunner } from "../../src/routines/runner.ts";
import type { RunnerDeps, TurnResult } from "../../src/routines/runner.ts";
import { RoutineHub } from "../../src/routines/store.ts";
import type { BoardLite, ThreadLite } from "../../src/routines/heartbeat.ts";

export const BOT = "b_0123456789ab";
export const OWNER = "u_alice";

export function rig(o: { dir?: string; t0?: number; hold?: boolean; deps?: Partial<RunnerDeps>; desktop?: boolean } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "routines-"));
  mkdirSync(join(dir, "bots", OWNER), { recursive: true });
  writeFileSync(join(dir, "bots", OWNER, "bots.json"), JSON.stringify({ v: 1, bots: { [BOT]: { id: BOT, slug: "quinn" } } }));
  const clock = { t: o.t0 ?? Date.parse("2026-10-28T12:00:00Z") };
  const now = () => clock.t;
  const hub = new RoutineHub(dir, { now });
  hub.caps.desktop = o.desktop === true;
  const world = { threads: [] as ThreadLite[], board: [] as BoardLite[], alive: true };
  const turns: { thread: string; text: string }[] = [];
  const gate: { release?: () => void; wait?: Promise<void> } = {};
  if (o.hold) gate.wait = new Promise<void>((r) => { gate.release = r; });
  const deps: RunnerDeps = {
    hub, now, jitterMs: 0,
    ownerOk: (seg) => seg,
    state: () => (world.alive ? { threads: world.threads, board: world.board } : undefined),
    async runTurn(a): Promise<TurnResult> {
      turns.push({ thread: a.thread, text: a.text });
      if (gate.wait) await gate.wait;
      return { ok: true, threadId: "th_1", finalText: "did it" };
    },
    ...(o.desktop ? { desktop: true } : {}),
    ...o.deps,
  };
  const runner = new RoutineRunner(deps);
  return { dir, clock, hub, runner, world, turns, gate, deps };
}
