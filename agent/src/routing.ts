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
  if (has.has("app")) steps.push("app (background UI Automation): operate a desktop app WITHOUT touching the user's mouse, keyboard or screen. list_windows, tree, find, invoke (click a button or menu item by name), set_value (fill a field), get_text, select, toggle, expand, collapse, launch, close. Give it several steps in ONE call (steps:[...]); no screenshot unless you pass screenshot:true. Not for when the user asks to watch it happen on screen: that is computer. \"Click Save in Notepad\" and \"fill the Name field in <app>\" are app calls, not computer calls.");
  if (!steps.length) return [];
  const out = [
    "## Work in the background first",
    "You are a background agent. Do the work with the first of these that can do it, in this order:",
    ...steps.map((s, i) => `${i + 1}. ${s}`),
  ];
  if (has.has("bash")) out.push("\"Open PowerShell\", \"open cmd or Terminal\", \"press Win+R\" or \"run this in a terminal\" all mean: run that command with bash (short) or process (long). Never open, focus, click into or type into a terminal, console or Run box on the screen" + (has.has("computer") ? ", with computer or any other tool, even if the user asks for it or says to watch." : "."));
  if (has.has("computer")) {
    out.push(
      `${steps.length + 1}. computer, LAST. It takes over the user's screen, mouse and keyboard, so they cannot use their PC while you do, and every step is slow (move, screenshot, think). Use it only when the job is in a desktop app that has no API, CLI or connector${has.has("app") ? " AND app cannot reach it (a canvas or custom-drawn window with no UI Automation tree)" : ""}, or the user asked to watch you do it on screen ("so I can watch", "show me on screen", "do it on screen"): then use computer, not app or bash, because they want to see it. Before the first computer action, say in one line why no background tool can do this. "The app is open", "it is faster" and "I am not sure" are not reasons. Never use it to open a terminal, run a command, read a URL or file, or click through something a tool above already does. Send several actions in ONE call (actions:[...]) with one screenshot at the end.`,
      "If a background tool fails, try another background route, then ask the user, before you reach for the screen.",
    );
  } else out.push("If a background tool fails, try another background route, then ask the user.");
  if (has.has("computer")) out.push("EXCEPTION: when the user asks to WATCH you do something on screen in an ordinary app (Calculator, Notepad, a browser, a document) \"so I can watch\", \"on screen\", \"show me\", do it with computer, even if bash could compute the answer: they want to see it. The exception never covers a terminal, PowerShell, cmd or the Run box.");
  out.push("Say in the reply what you did in the background.");
  return out;
}

/** Console hosts and shells. Shared by the computer guard, the app tool's launch refusal and the PowerShell foreground check. */
export const CONSOLE_PROCESSES = ["cmd", "powershell", "powershell_ise", "pwsh", "windowsterminal", "wt", "conhost", "openconsole", "wsl", "wslhost", "bash", "mintty", "sh", "zsh", "terminal", "iterm2"];
export const CONSOLE_WINDOW_CLASSES = ["ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS", "PseudoConsoleWindow", "mintty", "VirtualConsoleClass"];
/** The Run box is a #32770 dialog titled "Run" owned by explorer. */
export const RUN_DIALOG_TITLE = "Run";

const TERMINAL_WORDS = /^(cmd|cmd\.exe|powershell|powershell\.exe|windows powershell|powershell ise|pwsh|pwsh\.exe|wt|wt\.exe|windows terminal|terminal|iterm|bash|wsl|conhost|conhost\.exe|openconsole|command prompt|run dialog|git bash|mintty)$/i;
const TERMINAL_EXE_LINE = /^(cmd|cmd\.exe|powershell|powershell\.exe|pwsh|pwsh\.exe|wt|wt\.exe|conhost|conhost\.exe|wsl|wsl\.exe|bash|bash\.exe)(\s|$)/i;
const PS_CMDLET = /^(Get|Set|Start|Stop|Invoke|New|Remove|Out|Write|Select|Where|ForEach|Import|Export|Test|Add|Copy|Move|Rename|Clear|Install|Enable|Disable|Restart|Expand|Compress|Format|Measure|Sort|Join|Split|Read|Resolve|Wait|Register|Unregister|Update|Find)-[A-Za-z]{3,}\b/;
const CLI_LINE = /^(npm|npx|pnpm|yarn|git|node|python3?|pip3?|curl|wget|dir|ls|cd|mkdir|cat|ffmpeg|magick|convert|winget|choco|brew|docker|dotnet|cargo|make|pandoc|soffice|libreoffice)\s+\S/i;
const URL_ONLY = /^(https?:\/\/\S+|www\.\S+\.\S+)$/i;
const TERMINAL_HOTKEYS = new Set(["win+r", "windows+r", "win+x", "windows+x", "ctrl+alt+t"]);

const TERMINAL_HARD_TAIL = "This rule has no override, not even screen_required. Run the command with the bash tool (short) or the process tool (long, background). Never on screen.";

/**
 * HARD RULE, no override: `computer` never opens, focuses, clicks into or types into a terminal, console or Run box.
 * Refuses typing a terminal's name or a shell line starting with a terminal program or a PowerShell cmdlet, and the Win+R / Win+X hotkeys.
 * (The PowerShell script ALSO refuses when the foreground window, or the window under the pointer, is a console: see consoleCheckScript.)
 * `screen_required` does not skip this.
 */
export function terminalGuard(args: Record<string, unknown>): string | undefined {
  if (args.action === "key" && typeof args.keys === "string") {
    const k = args.keys.toLowerCase().replace(/\s+/g, "");
    if (TERMINAL_HOTKEYS.has(k)) return `computer: not run. ${k} opens the Run box or a terminal menu. ${TERMINAL_HARD_TAIL}`;
  }
  if (args.action !== "type" || typeof args.text !== "string") return undefined;
  const text = args.text.trim();
  if (!text) return undefined;
  const firstLine = text.split(/\r?\n/)[0].trim();
  if (TERMINAL_WORDS.test(text) || TERMINAL_EXE_LINE.test(firstLine)) return `computer: not run. Do not open or type into a terminal, console or Run box. ${TERMINAL_HARD_TAIL}`;
  if (PS_CMDLET.test(firstLine)) return `computer: not run. That is a PowerShell command, not something to type on screen. ${TERMINAL_HARD_TAIL}`;
  return undefined;
}

/** True when a launch target (path or name) is a shell or terminal program. */
export function isTerminalProgram(target: string): boolean {
  const base = target.trim().replace(/^["']|["']$/g, "").split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat|lnk)$/i, "").toLowerCase();
  return CONSOLE_PROCESSES.includes(base) || TERMINAL_WORDS.test(base);
}

/** The window facts the PowerShell check reads, so tests can run the same decision in TypeScript. */
export function isConsoleWindow(w: { process?: string; className?: string; title?: string }): boolean {
  const proc = (w.process ?? "").toLowerCase().replace(/\.exe$/, "");
  if (CONSOLE_PROCESSES.includes(proc)) return true;
  if (w.className && CONSOLE_WINDOW_CLASSES.includes(w.className)) return true;
  return w.className === "#32770" && w.title === RUN_DIALOG_TITLE && proc === "explorer";
}

/**
 * An error string when a `computer` call is obviously work a background tool does, else undefined. Cheap and stateless.
 * Terminals are a hard refusal (terminalGuard). Typing a URL (read it with web_fetch) or a shell command line into some other app is refused
 * unless `screen_required: true` (the user asked to watch it on screen, or no background tool can do it).
 */
export function backgroundGuard(args: Record<string, unknown>): string | undefined {
  const hard = terminalGuard(args);
  if (hard) return hard;
  if (args.screen_required === true || args.action !== "type" || typeof args.text !== "string") return undefined;
  const text = args.text.trim();
  if (!text) return undefined;
  const tail = "If the user asked to watch this on screen, or no background tool can do it, say why in one line and call computer again with screen_required:true.";
  if (URL_ONLY.test(text)) return `computer: not run. Typing a URL into a browser just to read it takes over the user's screen. Use web_fetch to read ${text.slice(0, 120)} in the background. ${tail}`;
  if (!text.includes("\n") && CLI_LINE.test(text)) return `computer: not run. That looks like a shell command typed into a terminal. Run it with bash (short) or process (long, background) instead. ${tail}`;
  return undefined;
}
