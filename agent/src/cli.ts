#!/usr/bin/env node
// MINDClaw CLI. Subcommands: chat (default), run "<prompt>", serve. Flags: --shadow, --local, --version.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { loadConfig } from "./config.ts";
import { HostedConfigError, hostedPort, isHostedEnv, loadHostedOptions, parseDailyCap } from "./hosted.ts";
import type { HostedOptions } from "./hosted.ts";
import type { AgentEvent, AgentSession, Config, Runtime } from "./types.ts";

function version(): string {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "unknown";
  }
}

const dim = (s: string) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

// Prints one event. Assistant text goes to stdout, everything else to stderr.
export function render(ev: AgentEvent, o: { streamText: boolean }): void {
  switch (ev.type) {
    case "text": if (o.streamText) process.stdout.write(ev.delta); break;
    case "toolStart": process.stderr.write(dim(`  > ${ev.tool} #${ev.receiptId} ${JSON.stringify(ev.args).slice(0, 120)}\n`)); break;
    case "toolEnd": process.stderr.write(dim(`  < #${ev.receiptId} ${ev.ok ? "ok" : "FAILED"} ${ev.preview.slice(0, 100)}\n`)); break;
    case "gate": process.stderr.write(dim(`  [gate ${ev.verdict.gate}${ev.enforced ? "" : " shadow"}] ${ev.verdict.reason}\n`)); break;
    case "confirm": process.stderr.write(`  [needs your go] ${ev.reason}\n`); break;
    case "notice": process.stderr.write(`  [${ev.level}] ${ev.text}\n`); break;
    case "usage": process.stderr.write(dim(`  $${ev.totalCostUsd.toFixed(4)} total\n`)); break;
    case "done": break;
  }
}

// Hosted deployment settings from the environment (MINDCLAW_HOSTED=1 or --hosted). Undefined for local use.
function hostedRuntime(argv: string[] = []): { dailyUsdCap: number } | undefined {
  return isHostedEnv(process.env, argv) ? { dailyUsdCap: parseDailyCap(process.env.MINDCLAW_DAILY_USD_CAP) } : undefined;
}

async function makeRuntime(cfg: ReturnType<typeof loadConfig>, argv: string[] = []): Promise<Runtime> {
  const { createRuntime } = await import("./runtime.ts");
  return createRuntime(cfg, { hosted: hostedRuntime(argv) });
}

function preflight(cfg: ReturnType<typeof loadConfig>): string | undefined {
  if (!cfg.openrouterKey) return "OPENROUTER_API_KEY is not set (env or ~/.mindclaw/config.json).";
  return undefined;
}

async function open(cfg: ReturnType<typeof loadConfig>, surface: string): Promise<AgentSession> {
  return (await makeRuntime(cfg)).openSession({ surface });
}

async function runHeadless(prompt: string, cfg: ReturnType<typeof loadConfig>): Promise<number> {
  const bad = preflight(cfg);
  if (bad) { process.stderr.write(`${bad}\n`); return 1; }
  const session = await open(cfg, "headless");
  let final = "";
  let errored = false;
  for await (const ev of session.send(prompt)) {
    render(ev, { streamText: false });
    if (ev.type === "notice" && ev.level === "warn" && ev.text.startsWith("error:")) errored = true;
    if (ev.type === "done") final = ev.finalText;
  }
  await session.close(final.slice(0, 500));
  if (final) process.stdout.write(final.endsWith("\n") ? final : `${final}\n`);
  return errored || !final ? 1 : 0;
}

async function chat(cfg: ReturnType<typeof loadConfig>, plain: boolean): Promise<number> {
  const bad = preflight(cfg);
  if (bad) { process.stderr.write(`${bad}\n`); return 1; }
  if (!plain) {
    const { runTui } = await import("./ui/index.ts");
    return runTui({ mode: "local", runtime: await makeRuntime(cfg) });
  }
  const session = await open(cfg, "tui");
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  let ctl: AbortController | undefined;
  rl.on("SIGINT", () => { if (ctl) ctl.abort(); else rl.close(); });
  process.stdout.write(`MINDClaw ${version()} (${cfg.shadow ? "shadow" : cfg.kernel ? "kernel on" : "kernel off"}). /quit to exit, ctrl-c aborts a turn.\n`);
  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (text === "/quit" || text === "/exit") break;
    if (text === "/violations") {
      for (const v of session.violations()) process.stdout.write(`${v.gate} ${v.action}${v.enforced ? "" : " (shadow)"}: ${v.reason}\n`);
    } else if (text) {
      ctl = new AbortController();
      try {
        for await (const ev of session.send(text, { signal: ctl.signal })) render(ev, { streamText: true });
      } finally { ctl = undefined; }
      process.stdout.write("\n");
    }
    rl.prompt();
  }
  await session.close();
  return 0;
}

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function serve(cfg: ReturnType<typeof loadConfig>, argv: string[]): Promise<number> {
  let mod: { startGateway?: (o: { runtime: Runtime; cfg?: Config; port?: number; host?: string; hosted?: HostedOptions }) => Promise<{ url: string; token: string }> };
  try { mod = (await import("./gateway/index.ts")) as typeof mod; } catch { process.stdout.write("gateway not built yet\n"); return 1; }
  if (!mod.startGateway) { process.stdout.write("gateway not built yet\n"); return 1; }
  const hostedMode = isHostedEnv(process.env, argv);
  let hosted: HostedOptions | undefined;
  if (hostedMode) {
    try { hosted = loadHostedOptions(process.env); } catch (e) {
      process.stderr.write(`${e instanceof HostedConfigError ? e.message : "invalid hosted configuration"}\n`);
      return 1;
    }
  }
  const bad = preflight(cfg);
  if (bad) { process.stderr.write(`${bad}\n`); return 1; }
  const runtime = await makeRuntime(cfg, argv);
  const port = argValue(argv, "--port") ? Number(argValue(argv, "--port")) : hosted ? hostedPort(process.env) : undefined;
  const host = argValue(argv, "--host");
  if (hosted && !process.env.MINDCLAW_MODEL) process.stderr.write(`hosted: MINDCLAW_MODEL is not set, using the built-in default (${cfg.models.default}). Set a cheap model for the deployment.\n`);
  let gw: { url: string; token: string };
  try { gw = await mod.startGateway({ runtime, cfg, port, host, hosted }); } catch (e) {
    process.stderr.write(`gateway failed to start: ${String((e as Error)?.message ?? e).split("\n")[0]}\n`);
    return 1;
  }
  if (hosted) {
    // Never print the login secret (platform logs are not a safe place for it).
    process.stdout.write(`MINDClaw hosted gateway listening on ${gw.url} (login required; allowed hosts: ${hosted.allowedHosts.join(", ")})\n`);
  } else {
    process.stdout.write(`MINDClaw gateway on ${gw.url} (token in ~/.mindclaw/gateway-token)\n`);
    // Machine-readable line for the desktop shell and scripts.
    process.stdout.write(`${JSON.stringify({ mindclawGateway: { url: gw.url, token: gw.token } })}\n`);
  }
  try {
    const ch = await import("./channels/index.ts");
    const adapters = ch.createChannels(ch.loadChannelsConfig());
    if (adapters.length) {
      const gateway = { open: (surface: string, title?: string, opts?: { identity?: string }) => runtime.openSession({ surface, title, identity: opts?.identity }) };
      const r = await ch.startChannels(gateway as never, adapters);
      process.stdout.write(`channels started: ${r.started.join(", ") || "none"}${r.failed.length ? `; failed: ${r.failed.join(", ")}` : ""}\n`);
    }
  } catch (e) { process.stderr.write(`channels unavailable: ${String((e as Error)?.message ?? e)}\n`); }
  await new Promise(() => {}); // run until stopped
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const rest = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--port", "--host"].includes(argv[i - 1])));
  if (flags.has("--version") || flags.has("-v")) { process.stdout.write(`${version()}\n`); return 0; }
  if (flags.has("--shadow")) process.env.MINDCLAW_SHADOW = "1";
  const cfg = loadConfig();
  const cmd = rest[0] ?? "chat";
  if (cmd === "run") {
    const prompt = rest.slice(1).join(" ").trim();
    if (!prompt) { process.stderr.write('usage: mindclaw run "<prompt>"\n'); return 1; }
    return runHeadless(prompt, cfg);
  }
  if (cmd === "chat") return chat(cfg, flags.has("--plain"));
  if (cmd === "serve") return serve(cfg, argv);
  process.stderr.write(`unknown command "${cmd}". Use: chat | run "<prompt>" | serve [--port N] [--host H] [--hosted] [--shadow] [--plain] [--version]\n`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/cli.ts")) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { process.stderr.write(`fatal: ${String(e?.message ?? e)}\n`); process.exit(1); });
}
