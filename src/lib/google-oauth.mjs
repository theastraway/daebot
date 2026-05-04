/**
 * CLI-side Google OAuth via loopback redirect.
 *
 * Flow:
 *   1. Spin up an HTTP server on http://127.0.0.1:<port>/cb
 *   2. Ask MIND for the Google auth URL with redirect_after=<loopback>
 *   3. Open that URL in the user's browser
 *   4. After Google → MIND callback → MIND redirects to our loopback with
 *      ?token=<jwt>&username=...&is_new_user=true|false
 *   5. Capture, close the server, return the credentials.
 *
 * No client_secret on the wrapper. The MIND backend owns the Google
 * client and does the code-for-token exchange.
 */

import { createServer } from "node:http";
import { URL } from "node:url";
import { spawn } from "node:child_process";

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function html(body) {
  return `<!doctype html><html><head><meta charset="utf-8"/><title>MINDClaw</title><style>body{font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e2e8f0;display:grid;place-items:center;height:100vh;margin:0}.card{max-width:480px;text-align:center;padding:2rem;border:1px solid #1e2530;border-radius:12px}h1{margin:0 0 .5rem;color:#e53935}p{color:#94a3b8;line-height:1.6}</style></head><body><div class="card">${body}</div></body></html>`;
}

const SUCCESS_HTML = html(
  `<h1>MIND × Claw</h1><p>You're signed in. You can close this tab and return to your terminal.</p>`
);

function errorHtml(msg) {
  return html(`<h1>Sign-in failed</h1><p>${msg}</p>`);
}

export async function googleSignIn({ baseUrl, openInBrowser = true }) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    let done = false;

    const fail = (e) => {
      if (done) return;
      done = true;
      try { server.close(); } catch {}
      reject(e);
    };

    const succeed = (data) => {
      if (done) return;
      done = true;
      try { server.close(); } catch {}
      resolve(data);
    };

    server.on("request", (req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/cb") {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const token = u.searchParams.get("token");
      const username = u.searchParams.get("username");
      const isNewUser = u.searchParams.get("is_new_user") === "true";
      const error = u.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(errorHtml(`Google returned: ${error}`));
        fail(new Error(`Google OAuth error: ${error}`));
        return;
      }
      if (!token || !username) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(errorHtml("Missing token in callback."));
        fail(new Error("OAuth callback missing token"));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(SUCCESS_HTML);
      succeed({ token, username, isNewUser });
    });

    server.on("error", fail);

    server.listen(0, "127.0.0.1", async () => {
      const { port } = server.address();
      const loopback = `http://127.0.0.1:${port}/cb`;

      try {
        const res = await fetch(
          `${baseUrl}/oauth/google/url?redirect_after=${encodeURIComponent(loopback)}`
        );
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`MIND auth URL request failed (${res.status}): ${text}`);
        }
        const { auth_url: authUrl } = await res.json();
        if (!authUrl) throw new Error("MIND did not return an auth URL.");

        if (openInBrowser) {
          const opener =
            process.platform === "darwin"
              ? "open"
              : process.platform === "win32"
              ? "start"
              : "xdg-open";
          spawn(opener, [authUrl], { stdio: "ignore", detached: true }).unref();
        }

        process.stdout.write(`If your browser didn't open: ${authUrl}\n`);
      } catch (e) {
        fail(e);
        return;
      }

      setTimeout(() => fail(new Error("Google sign-in timed out (5 min).")), TIMEOUT_MS);
    });
  });
}
