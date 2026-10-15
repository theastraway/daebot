// Public entry point: runTui() is what cli.ts calls.
import type { Runtime } from "../types.ts";
import { TuiApp } from "./app.ts";
import type { InStream, OutStream } from "./app.ts";
import { createGatewayClient, createLocalClient } from "./client.ts";
import { defaultHistoryPath } from "./history.ts";

export type TuiOptions = { mode: "gateway"; url: string; token: string } | { mode: "local"; runtime: Runtime };

export async function runTui(opts: TuiOptions): Promise<number> {
  const client = opts.mode === "gateway" ? createGatewayClient({ url: opts.url, token: opts.token }) : createLocalClient(opts.runtime);
  const app = new TuiApp({ client, stdin: process.stdin as unknown as InStream, stdout: process.stdout as unknown as OutStream, env: process.env, historyPath: defaultHistoryPath() });
  return app.run();
}

export { TuiApp } from "./app.ts";
export { createGatewayClient, createLocalClient } from "./client.ts";
export type { SessionClient } from "./client.ts";
