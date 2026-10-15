import type { MindClient } from "../types.ts";

const BOOT_SECTIONS = ["soul", "user", "rules", "priorities", "recent"];

function msg(e: unknown): string {
  return String((e as Error)?.message ?? e).slice(0, 200);
}

// A sick synthesis endpoint is NOT a failed boot: fall back to profile + a priorities query.
// ok:false only when everything is unreachable.
export async function bootMind(client: MindClient): Promise<{ ok: boolean; context: string; error?: string; degraded?: boolean }> {
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
