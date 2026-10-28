// Ask Caelum: maps MIND's AgentSpec (MINDapp backend/models/agent_spec.py, returned by POST /api/agentbuilder/intake) onto the
// three fields of Daebot's New bot form. The spec is third-party-shaped data: every string is clipped, lists are capped.

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const list = (v: unknown, n = 8, max = 300): string[] => (Array.isArray(v) ? v.map((x) => str(x, max)).filter(Boolean).slice(0, n) : []);

export const BOT_NAME_MAX = 40;
export const BOT_PURPOSE_MAX = 140;

/** "insurance_claim_email_reviewer" / "ClaimReviewBot" -> "Insurance Claim Email Reviewer" / "Claim Review Bot". */
export function displayName(raw: string): string {
  const spaced = raw.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();
  return spaced.split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ").slice(0, BOT_NAME_MAX).trim();
}

export function caelumToBot(spec: any): { name: string; purpose: string; instructions: string } {
  const role = str(spec?.role, 120);
  const name = displayName(str(spec?.name, 80)) || displayName(role) || "New bot";
  const purpose = (str(spec?.primary_responsibility, 400) || str(spec?.frontmatter_description, 400) || role).slice(0, BOT_PURPOSE_MAX);
  const section = (title: string, items: string[]) => (items.length ? `\n${title}\n${items.map((i) => `- ${i}`).join("\n")}\n` : "");
  const para = (title: string, text: string) => (text ? `\n${title}\n${text}\n` : "");
  const instructions = [
    `You are ${name}${role ? `, ${role}` : ""}.`,
    para("Mission", str(spec?.mission_paragraph, 1200) || str(spec?.frontmatter_description, 600)),
    para("Main job", str(spec?.primary_responsibility, 600)),
    section("What you do", list(spec?.purposes)),
    section("Priorities", list(spec?.priorities)),
    section("Rules", list(spec?.rules, 12)),
    section("Done looks like", list(spec?.success_criteria)),
    section("Context", list(spec?.context_lines)),
    para("Personality", [str(spec?.soul_paragraph, 600), list(spec?.traits, 6, 60).join(", ")].filter(Boolean).join(" ")),
    para("Start of every task", str(spec?.startup_query, 300) || str(spec?.mind_query_on_start, 300)),
  ].join("").trim();
  return { name, purpose, instructions };
}
