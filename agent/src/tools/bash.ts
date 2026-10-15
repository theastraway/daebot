import { spawn } from "node:child_process";
import type { Tool } from "../types.ts";
import { cap, fail } from "./util.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const OUTPUT_CAP = 30_000;

export const bashTool: Tool = {
  class: "write",
  receipt: "surface",
  spec: {
    name: "bash",
    description: "Run a shell command (bash -c) in the working directory. 120s default timeout, output capped at 30k chars. Prefer read_file/grep/glob for reading.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "number", description: "Default 120000, max 600000" },
      },
      required: ["command"],
    },
  },
  run(args, ctx) {
    const command = args.command;
    if (typeof command !== "string" || command.trim() === "") return Promise.resolve(fail("bash: command is required"));
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(Number(args.timeout_ms) || DEFAULT_TIMEOUT_MS)));
    return new Promise((resolve) => {
      if (ctx.signal?.aborted) return resolve(fail("bash: aborted before start"));
      const child = spawn("bash", ["-c", command], { cwd: ctx.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: process.env });
      let out = "";
      let hardCap = false;
      let timedOut = false;
      let aborted = false;
      const onData = (d: Buffer) => {
        if (out.length < OUTPUT_CAP * 4) out += d.toString("utf8");
        else hardCap = true;
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      const killTree = () => {
        try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
      };
      const timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);
      const onAbort = () => { aborted = true; killTree(); };
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      const finish = (code: number | null, extra?: string) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        let text = cap(out, OUTPUT_CAP);
        if (hardCap) text += "\n[output exceeded buffer; middle dropped]";
        if (timedOut) return resolve({ ok: false, output: `${text}\n[timed out after ${timeoutMs}ms]`.trim() });
        if (aborted) return resolve({ ok: false, output: `${text}\n[aborted]`.trim() });
        if (extra) return resolve({ ok: false, output: `bash: ${extra}` });
        resolve({ ok: code === 0, output: code === 0 ? text : `${text}\n[exit code ${code}]`.trim(), meta: { exitCode: code } });
      };
      child.on("error", (e) => finish(null, e.message));
      child.on("close", (code) => finish(code));
    });
  },
};
