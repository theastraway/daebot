// Bot definition versions. A bot's DAEBOT.md and its MIND are the user's; the DEFINITION is the base operating rules Daebot
// layers under them. A bot records the definition version it was created on (`version`, absent = 1). The latest definition is
// LATEST_BOT_VERSION; "Update" moves a bot to it. Updating never touches DAEBOT.md, the bot's threads or its MIND memory.
// To ship a new definition: add an entry with the next number and raise LATEST_BOT_VERSION (old entries stay so older bots keep behaving as they did).

export interface BotDefinition { version: number; label: string; notes: string[]; base: string }

export const BOT_DEFINITIONS: Record<number, BotDefinition> = {
  1: { version: 1, label: "1.0", notes: ["The original bot: your DAEBOT.md and its own MIND."], base: "" },
  2: {
    version: 2,
    label: "1.1",
    notes: [
      "Looks in its own MIND before it answers and says what it found.",
      "Never guesses a number, name, price or date; says it does not know and goes to find out.",
      "Asks before anything that reaches a real person or cannot be undone.",
    ],
    base: [
      "# Base rules (Daebot bot definition 1.1)",
      "- Look in your MIND before you answer. Say what you found.",
      "- Never guess a number, name, price or date. Say you do not know and go find it.",
      "- Ask before anything that reaches a real person or cannot be undone.",
      "- Keep answers short and concrete. The instructions below are the owner's and win over these rules.",
    ].join("\n"),
  },
};

BOT_DEFINITIONS[3] = {
  version: 3,
  label: "1.2",
  notes: [
    "Works in the background first: connectors and MIND, then web pages, files, long jobs, then the app tool (UI Automation), and the screen last.",
    "Never opens or types into a terminal, PowerShell or the Run box on screen; commands run in the background.",
  ],
  base: [
    BOT_DEFINITIONS[2].base.replace("(Daebot bot definition 1.1)", "(Daebot bot definition 1.2)"),
    "- Use tools in this order: a connector, MCP or MIND tool; web_fetch; files and bash; process for long jobs; app (background UI Automation) to operate a desktop app; the screen (computer) last, only when app cannot reach the control or the user asked to watch.",
    "- Never open, focus or type into a terminal, PowerShell, cmd or the Run box on the screen. Run commands with bash or process.",
  ].join("\n"),
};

export const LATEST_BOT_VERSION = 3;

export function versionOf(rec: { version?: number } | undefined): number {
  const v = rec?.version;
  return typeof v === "number" && BOT_DEFINITIONS[v] ? v : 1;
}

/** What the UI shows for a bot: installed vs latest, and what the update brings. */
export function versionInfo(rec: { version?: number } | undefined): { version: string; latestVersion: string; updateAvailable: boolean; updateNotes: string[] } {
  const cur = versionOf(rec);
  const latest = BOT_DEFINITIONS[LATEST_BOT_VERSION];
  return { version: BOT_DEFINITIONS[cur].label, latestVersion: latest.label, updateAvailable: cur < LATEST_BOT_VERSION, updateNotes: cur < LATEST_BOT_VERSION ? latest.notes : [] };
}

/** The installed definition's base rules (empty for 1.0). The system prompt puts them above the owner's DAEBOT.md, outside its 8 KB cap. */
export function botBase(version: number | undefined): string { return BOT_DEFINITIONS[versionOf({ version })].base; }

/** Base rules then the owner's text, as one string. */
export function withBotBase(version: number | undefined, instructions: string): string {
  const base = BOT_DEFINITIONS[versionOf({ version })].base;
  return base ? (instructions.trim() ? `${base}\n\n${instructions}` : base) : instructions;
}
