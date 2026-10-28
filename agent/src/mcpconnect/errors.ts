// The one error type of the connect feature. It lives in its own file so the MIND backend client and the service can both use it
// without importing each other. `message` is always plain words that are safe to show the user; `code` is MIND's machine word when MIND gave one.
export class McpConnectError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 400, code?: string) { super(message); this.status = status; if (code) this.code = code; }
}
