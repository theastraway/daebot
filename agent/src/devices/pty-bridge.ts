// Gateway side of the desktop PTY channel. The desktop main process listens on 127.0.0.1 and this process
// calls it with the gateway token. node-pty is never imported here: the bun-compiled gateway cannot load an
// Electron ABI .node. A failure leaves the pipe backend in place.
import type { DeviceSupport } from "./index.ts";
import type { TermBackend, TermHandle, TermSpawnSpec, TerminalRegistry } from "../tools/terminal.ts";

export function isLoopbackPeer(addr: string | undefined | null): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase().replace(/^::ffff:/, "");
  return a === "127.0.0.1" || a === "::1" || a === "localhost";
}

function redact(s: string): string {
  return s.replace(/[0-9a-f]{32,}/gi, "[redacted]").split("\n")[0]!.slice(0, 180);
}

async function readError(res: Response): Promise<string> {
  try { return redact(await res.text()); } catch { return ""; }
}

export function createPtyBackend(opts: { port: number; token: string; fetchImpl?: typeof fetch }): TermBackend {
  const base = `http://127.0.0.1:${opts.port}`;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers = { authorization: `Bearer ${opts.token}`, "content-type": "application/json" };
  const call = async (path: string, body: unknown): Promise<void> => {
    const res = await fetchImpl(base + path, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`terminal: desktop PTY ${res.status} ${await readError(res)}`);
  };
  return {
    kind: "pty",
    typeable: true,
    async openAsync(spec: TermSpawnSpec): Promise<TermHandle> {
      const res = await fetchImpl(base + "/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: spec.id, file: spec.file, args: spec.args, cwd: spec.cwd, cols: spec.cols, rows: spec.rows, env: spec.env }),
      });
      if (!res.ok) throw new Error(`terminal: desktop PTY ${res.status} ${await readError(res)}`);
      const opened = await res.json() as { pid?: number };
      if (typeof opened.pid !== "number") throw new Error("terminal: desktop PTY did not return a pid");
      let onOut: ((chunk: string) => void) | undefined;
      let onErr: ((chunk: string) => void) | undefined;
      let onExit: ((code: number | null) => void) | undefined;
      const queued: string[] = [];
      let exited = false;
      let exitCode: number | null = null;
      const pump = async (): Promise<void> => {
        try {
          const stream = await fetchImpl(`${base}/sessions/${encodeURIComponent(spec.id)}/stream`, {
            headers: { authorization: `Bearer ${opts.token}`, accept: "text/event-stream" },
          });
          if (!stream.ok || !stream.body) throw new Error(`stream ${stream.status}`);
          const reader = stream.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          const take = (block: string): void => {
            let event = "message";
            const data: string[] = [];
            for (const line of block.split("\n")) {
              if (!line || line.startsWith(":")) continue;
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
            }
            if (!data.length) return;
            let payload: { data?: string; code?: number | null };
            try { payload = JSON.parse(data.join("\n")) as { data?: string; code?: number | null }; } catch { return; }
            if (event === "data" && typeof payload.data === "string") {
              if (onOut) onOut(payload.data);
              else queued.push(payload.data);
            } else if (event === "exit") {
              exited = true;
              exitCode = typeof payload.code === "number" ? payload.code : payload.code === null ? null : null;
              onExit?.(exitCode);
            }
          };
          for (;;) {
            const step = await reader.read();
            if (step.done) break;
            buf += dec.decode(step.value, { stream: true });
            let cut: number;
            while ((cut = buf.indexOf("\n\n")) >= 0) {
              take(buf.slice(0, cut));
              buf = buf.slice(cut + 2);
            }
          }
        } catch (e) {
          if (!exited) onErr?.(`desktop PTY stream closed: ${redact(String((e as Error)?.message ?? e))}`);
        }
        if (!exited) { exited = true; exitCode = null; onExit?.(null); }
      };
      void pump();
      // One chain per session. send() and keystrokes do not wait, and a burst (the shot seed, fast typing)
      // must still reach the pty in order. A failed call does not stall the next one.
      let chain = Promise.resolve();
      const enqueue = (path: string, body: unknown): void => {
        chain = chain.then(() => call(path, body)).catch(() => { /* the stream reports the death */ });
      };
      const sessionPath = `/sessions/${encodeURIComponent(spec.id)}`;
      return {
        pid: opened.pid,
        write(data) { enqueue(`${sessionPath}/write`, { data }); },
        resize(cols, rows) { enqueue(`${sessionPath}/resize`, { cols, rows }); },
        onStdout(fn) { onOut = fn; for (const chunk of queued) fn(chunk); queued.length = 0; },
        onStderr(fn) { onErr = fn; },
        onError(fn) { onErr = fn; },
        onExit(fn) { onExit = fn; if (exited) fn(exitCode); },
        interrupt() {
          enqueue(`${sessionPath}/write`, { data: "\x03" });
          return { sent: true, note: "sent Ctrl-C" };
        },
        kill() { enqueue(`${sessionPath}/kill`, {}); },
      };
    },
  };
}

export async function attachPtyBackend(opts: { port: number; token: string; registry: TerminalRegistry; fetchImpl?: typeof fetch }): Promise<void> {
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new Error("bad pty port");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`http://127.0.0.1:${opts.port}/health`, { headers: { authorization: `Bearer ${opts.token}` } });
  if (!res.ok) throw new Error(`pty health ${res.status} ${await readError(res)}`);
  const body = await res.json() as { ok?: boolean; backend?: string };
  if (body.ok !== true || body.backend !== "pty") throw new Error("pty health was not a pty");
  opts.registry.setBackend(createPtyBackend({ port: opts.port, token: opts.token, fetchImpl }));
}

export async function announcePty(opts: {
  hosted: boolean;
  remoteAddress: string | undefined;
  port: unknown;
  token: string;
  registry: TerminalRegistry;
  fetchImpl?: typeof fetch;
}): Promise<{ status: number; body: unknown }> {
  if (opts.hosted) return { status: 404, body: { error: "not found" } };
  if (!isLoopbackPeer(opts.remoteAddress)) return { status: 403, body: { error: "forbidden" } };
  const port = typeof opts.port === "number" && Number.isInteger(opts.port) ? opts.port : undefined;
  if (!port || port < 1 || port > 65535) return { status: 400, body: { error: "port must be a TCP port" } };
  try {
    await attachPtyBackend({ port, token: opts.token, registry: opts.registry, fetchImpl: opts.fetchImpl });
    return { status: 200, body: { ok: true, backend: "pty", typeable: true } };
  } catch (e) {
    return { status: 502, body: { error: redact(String((e as Error)?.message ?? e)) || "pty attach failed" } };
  }
}

export interface TerminalDeviceFields {
  available: boolean;
  pty: boolean;
  note: string;
  backend: "pipe" | "pty";
  typeable: boolean;
  reason: string;
}

/** Overlay the live registry on the static device report. deviceSupport() itself stays pipes. */
export function withTerminalBackend(support: DeviceSupport, reg: { backendKind(): "pipe" | "pty"; typeable(): boolean }): Omit<DeviceSupport, "terminal"> & { terminal: TerminalDeviceFields } {
  const pty = reg.backendKind() === "pty" && reg.typeable();
  const reason = pty
    ? "A desktop PTY is attached, so the pane is typeable and full-screen programs work."
    : "No desktop PTY is attached, so sessions are pipes and the pane is read-only.";
  return {
    ...support,
    terminal: {
      available: support.terminal.available,
      pty,
      note: pty ? reason : support.terminal.note,
      backend: pty ? "pty" : "pipe",
      typeable: pty,
      reason,
    },
  };
}
