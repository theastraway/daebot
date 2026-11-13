import type { MindClient } from "../types.ts";
import { capBoot, focusedContextOn } from "../focus.ts";

const BOOT_SECTIONS = ["soul", "user", "rules", "priorities", "recent"];
// Focused context: the always-on boot is only who I am (soul) and the house rules. Priorities and recent activity are no longer
// dumped into every turn; per-turn recall (focus.ts relevantFromMind) fetches what a message needs.
const FOCUSED_BOOT_SECTIONS = ["soul", "rules"];

function msg(e: unknown): string {
  return String((e as Error)?.message ?? e).slice(0, 200);
}

// A sick synthesis endpoint is NOT a failed boot: fall back to profile + a priorities query.
// ok:false only when everything is unreachable.
export async function bootMind(client: MindClient, o: { focused?: boolean; log?: (line: string) => void } = {}): Promise<{ ok: boolean; context: string; error?: string; degraded?: boolean }> {
  const focused = o.focused ?? focusedContextOn();
  if (focused) return bootFocused(client, o.log);
  let firstErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const context = await client.context(BOOT_SECTIONS);
      return { ok: true, context };
    } catch (e) {
      firstErr = msg(e);
    }
  }
  // Fallback ladder.
  const parts: string[] = [];
  let profileErr = "";
  let queryErr = "";
  try {
    parts.push("## PROFILE\n" + (await client.call("profile", { action: "get" })));
  } catch (e) { profileErr = msg(e); }
  try {
    parts.push("## PRIORITIES\n" + (await client.query("current priorities")));
  } catch (e) { queryErr = msg(e); }
  if (parts.length === 2) {
    const note = `mind_context failed twice (${firstErr}); booted from profile + priorities query instead.`;
    return { ok: true, degraded: true, context: `[MIND boot degraded: ${note}]\n\n${parts.join("\n\n")}`, error: note };
  }
  return {
    ok: false,
    context: parts.join("\n\n"),
    error: `MIND unreachable. context: ${firstErr}; profile: ${profileErr || "ok"}; query: ${queryErr || "ok"}`,
  };
}

async function bootFocused(client: MindClient, log: (line: string) => void = (l) => console.log(l)): Promise<{ ok: boolean; context: string; error?: string; degraded?: boolean }> {
  let firstErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const capped = capBoot(await client.context(FOCUSED_BOOT_SECTIONS));
      log(`[daebot] boot context (soul+rules) ${capped.chars} chars${capped.truncated ? `, capped to ${capped.text.length}` : ""}`);
      return { ok: true, context: capped.text };
    } catch (e) { firstErr = msg(e); }
  }
  try {
    const capped = capBoot("## PROFILE\n" + (await client.call("profile", { action: "get" })));
    const note = `mind_context failed twice (${firstErr}); booted from the profile instead.`;
    log(`[daebot] boot degraded, profile ${capped.chars} chars`);
    return { ok: true, degraded: true, context: `[MIND boot degraded: ${note}]\n\n${capped.text}`, error: note };
  } catch (e) {
    return { ok: false, context: "", error: `MIND unreachable. context: ${firstErr}; profile: ${msg(e)}` };
  }
}
