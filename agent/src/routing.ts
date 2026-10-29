// Background-first routing. Daebot works like a background agent: it picks the first tool that can do the job without the
// user's screen, and drives the screen (`computer`) only when the UI is the only way. This is the prompt section; the
// tool descriptions repeat the rule, and tools/computer.ts refuses the obvious screen-for-background-work calls.

/** The "## Work in the background first" section, shaped to the tools this session actually has. Empty when there is nothing to route. */
export function routingSection(toolNames: Iterable<string>): string[] {
  const has = new Set(toolNames);
  const connectors = [...has].some((n) => /^mind_/.test(n) || /^[a-z0-9][a-z0-9-]{0,30}__/.test(n) || n === "apple_calendar");
  const steps: string[] = [];
  if (connectors) steps.push("A connector, MCP server or MIND tool: mail, calendar, contacts, files, CRM, bots, n8n, anything named mind_* or <server>__<tool>. They are exact and need no screen.");
  if (has.has("web_fetch")) steps.push("web_fetch for anything on a public URL: read a page, call a JSON API, weather, prices, docs. Never open a browser to read a page, even if the user says go to, open or look up a site.");
  if (has.has("bash")) steps.push("bash, read_file, write_file, edit_file, glob, grep for files, folders, scripts, git, tests, conversions (ffmpeg, pandoc, libreoffice, imagemagick), installs. Never open a terminal or a file explorer on the screen to run a command or look at files, even if the user says open Terminal or open the folder.");
  if (has.has("process")) steps.push("process for anything that takes more than about a minute or must keep running (builds, test suites, downloads, watchers, servers, long conversions): process start, then process status or tail on later turns. Tell the user it is running in the background and check back; do not wait on a foreground command or on the screen.");
  if (!steps.length) return [];
  const out = [
    "## Work in the background first",
    "You are a background agent. Do the work with the first of these that can do it, in this order:",
    ...steps.map((s, i) => `${i + 1}. ${s}`),
  ];
  if (has.has("computer")) {
    out.push(
      `${steps.length + 1}. computer, LAST. It takes over the user's screen, mouse and keyboard, so they cannot use their PC while you do. Use it only when the job is in a desktop app that has no API, CLI or connector, or the user asked to watch you do it on screen. Before the first computer action, say in one line why no background tool can do this. "The app is open", "it is faster" and "I am not sure" are not reasons. Never use it to open a terminal, run a command, read a URL or file, or click through something a tool above already does. When the user asks you to operate a desktop app, or to do something on screen so they can watch, that IS the reason: use computer, do not substitute a shell command.`,
      "If a background tool fails, try another background route, then ask the user, before you reach for the screen.",
    );
  } else out.push("If a background tool fails, try another background route, then ask the user.");
  out.push("Say in the reply what you did in the background.");
  return out;
}

const TERMINAL_WORDS = /^(cmd|cmd\.exe|powershell|powershell\.exe|pwsh|wt|windows terminal|terminal|iterm|bash|wsl|command prompt)$/i;
const CLI_LINE = /^(npm|npx|pnpm|yarn|git|node|python3?|pip3?|curl|wget|dir|ls|cd|mkdir|cat|ffmpeg|magick|convert|winget|choco|brew|docker|dotnet|cargo|make|pandoc|soffice|libreoffice)\s+\S/i;
const URL_ONLY = /^(https?:\/\/\S+|www\.\S+\.\S+)$/i;

/**
 * An error string when a `computer` call is obviously work a background tool does, else undefined. Cheap and stateless:
 * typing a URL (read it with web_fetch), typing a terminal's name (use bash) or typing a shell command line (use bash or process).
 * `screen_required: true` (the user asked to watch it on screen, or no background tool can do it) skips the guard.
 */
export function backgroundGuard(args: Record<string, unknown>): string | undefined {
  if (args.screen_required === true || args.action !== "type" || typeof args.text !== "string") return undefined;
  const text = args.text.trim();
  if (!text) return undefined;
  const tail = "If the user asked to watch this on screen, or no background tool can do it, say why in one line and call computer again with screen_required:true.";
  if (URL_ONLY.test(text)) return `computer: not run. Typing a URL into a browser just to read it takes over the user's screen. Use web_fetch to read ${text.slice(0, 120)} in the background. ${tail}`;
  if (TERMINAL_WORDS.test(text)) return `computer: not run. Do not open a terminal on the screen. Use bash for a command, or process for a long job (start, then status/tail). ${tail}`;
  if (!text.includes("\n") && CLI_LINE.test(text)) return `computer: not run. That looks like a shell command typed into a terminal. Run it with bash (short) or process (long, background) instead. ${tail}`;
  return undefined;
}
