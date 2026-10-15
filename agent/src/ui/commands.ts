// Slash command parsing and routing. Pure: returns an Action, the app performs it.

export interface CommandSpec { name: string; usage: string; help: string }

export const COMMANDS: CommandSpec[] = [
  { name: "help", usage: "/help", help: "list commands and keys" },
  { name: "sessions", usage: "/sessions", help: "list sessions on this runtime" },
  { name: "new", usage: "/new", help: "start a fresh session" },
  { name: "resume", usage: "/resume <id>", help: "resume a session by id (or unique prefix)" },
  { name: "model", usage: "/model", help: "show the model in use" },
  { name: "shadow", usage: "/shadow", help: "show kernel mode (on/shadow/off) and shadow-logged violations" },
  { name: "violations", usage: "/violations", help: "list kernel violations for this session" },
  { name: "cost", usage: "/cost", help: "running cost and token usage" },
  { name: "expand", usage: "/expand [id|last|all|off]", help: "show full tool output; toggle collapsed rows" },
  { name: "clear", usage: "/clear", help: "clear the screen" },
  { name: "quit", usage: "/quit", help: "exit (also /exit, Ctrl+D on empty input)" },
];

export type Action =
  | { type: "send"; text: string }
  | { type: "help" }
  | { type: "sessions" }
  | { type: "new" }
  | { type: "resume"; id: string }
  | { type: "model" }
  | { type: "shadow" }
  | { type: "violations" }
  | { type: "cost" }
  | { type: "expand"; arg: string }
  | { type: "clear" }
  | { type: "quit" }
  | { type: "noop" }
  | { type: "error"; message: string };

const ALIASES: Record<string, string> = { exit: "quit", q: "quit", "?": "help", h: "help", ls: "sessions", session: "sessions", v: "violations" };

export function parseSlash(line: string): { name: string; args: string } | null {
  const t = line.trim();
  if (!t.startsWith("/") || t.startsWith("//")) return null;
  const m = /^\/(\S*)\s*([\s\S]*)$/.exec(t);
  if (!m) return null;
  // "/Users/me/file.txt do X" is a path, not a command
  if (m[1].includes("/")) return null;
  return { name: m[1].toLowerCase(), args: m[2].trim() };
}

export function completeCommand(prefix: string): string[] {
  const p = prefix.replace(/^\//, "").toLowerCase();
  return COMMANDS.map((c) => c.name).filter((n) => n.startsWith(p));
}

export function routeInput(line: string): Action {
  if (line.trim() === "") return { type: "noop" };
  if (line.trimStart().startsWith("//")) return { type: "send", text: line.trimStart().slice(1) }; // escape a literal slash
  const cmd = parseSlash(line);
  if (!cmd) return { type: "send", text: line };
  const name = ALIASES[cmd.name] ?? cmd.name;
  switch (name) {
    case "help": return { type: "help" };
    case "sessions": return { type: "sessions" };
    case "new": return { type: "new" };
    case "resume":
      return cmd.args ? { type: "resume", id: cmd.args.split(/\s+/)[0] } : { type: "error", message: "usage: /resume <session id>" };
    case "model": return { type: "model" };
    case "shadow": return { type: "shadow" };
    case "violations": return { type: "violations" };
    case "cost": return { type: "cost" };
    case "expand": return { type: "expand", arg: cmd.args };
    case "clear": return { type: "clear" };
    case "quit": return { type: "quit" };
  }
  const near = completeCommand(cmd.name);
  if (near.length === 1) return routeInput("/" + near[0] + (cmd.args ? " " + cmd.args : ""));
  return { type: "error", message: `unknown command /${cmd.name}` + (near.length > 1 ? ` (did you mean ${near.map((n) => "/" + n).join(", ")}?)` : "; /help lists commands. Start with // to send a literal slash.") };
}
