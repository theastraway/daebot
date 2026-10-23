# Deploying the hosted agent (daebot.live)

Hosted mode runs the agent as a public web service on Render with TLS terminated by Render.
It differs from local use on purpose:

- **No host tools.** `bash`, `read_file`, `write_file`, `edit_file`, `glob` and `grep` are not in the tool list and the kernel refuses them by name. Only `web_fetch` and the `mind_*` tools run. A prompt injection therefore cannot read the server's environment.
- **Login required.** One access code (`GATEWAY_TOKEN`). `POST /login` sets an HttpOnly, Secure, SameSite=Strict session cookie (7 days). Bearer headers and `?token=` are not accepted. 5 failed logins per IP per 10 minutes returns 429.
- **Host allowlist.** `Host` and `X-Forwarded-Host` must both be in `ALLOWED_HOSTS`. Origin must be `https://<allowed host>`. `/health` is the only route exempt (it returns `{ok:true}` and nothing else).
- **Kernel enforced** (never shadow), identity `admin` (Anthony only, behind the login), surface `web`.
- **Daily spend cap.** `MINDCLAW_DAILY_USD_CAP` (default 5, UTC day, in memory, resets on restart). Over the cap, new turns get a one-line notice.

## Environment variables

| Key | Secret | Value |
|---|---|---|
| `MINDCLAW_HOSTED` | no | `1` |
| `GATEWAY_TOKEN` | yes | the login access code, 24+ characters. The service refuses to start without it. |
| `ALLOWED_HOSTS` | no | `daebot.live,www.daebot.live` (the `<service>.onrender.com` name is added automatically from `RENDER_EXTERNAL_HOSTNAME`) |
| `MIND_API_KEY` | yes | MIND key for the agent's tenant |
| `MIND_SESSION_API_KEY` | yes | key with `chat:write` for Agent Session sync (falls back to `MIND_API_KEY`) |
| `OPENROUTER_API_KEY` | yes | OpenRouter key |
| `MINDCLAW_MODEL` | no | main model, read from the environment only. Built-in default `qwen/qwen3.8-flash`; fallback `deepseek/deepseek-v4-flash`. `/health` reports the active model as `model` (provider `openrouter`). The service logs a warning if this is unset. |
| `MINDCLAW_CHEAP_MODEL` | no | cheap model for light work |
| `DATA_DIR` | no | where chats are saved as JSON (`<DATA_DIR>/sessions/<id>.json`). `/data` on Render (the 1 GB persistent disk in `render.yaml`). Default locally: `~/.mindclaw/data`. |
| `MINDCLAW_CONTEXT_WINDOW` | no | model context window in tokens for compaction (default 128000). At 60% (`MINDCLAW_COMPACT_AT=0.6`) older turns are summarized by the cheap model; the last 8 turns and all receipt lines stay verbatim. |
| `MINDCLAW_MCP_SERVERS` | no | JSON array of remote MCP servers: `[{"name":"acme","url":"https://...","headers":{"Authorization":"Bearer ..."},"classes":{"search":"read"}}]`. Streamable HTTP. Tools appear as `<name>__<tool>`. `classes` maps a tool (or `"*"`) to `read\|write\|outward\|irreversible\|public`; anything not listed is `outward`, so the danger gate asks before it runs. |
| `MINDCLAW_KERNEL` | no | `1` |
| `MINDCLAW_DAILY_USD_CAP` | no | `5` |
| `MINDCLAW_CLIENT_NAMES` | no | optional comma list of client entity names for the owner gate |
| `NODE_VERSION` | no | `24` |
| `PORT` | auto | set by Render; the service binds `0.0.0.0:$PORT` |

Generate the access code locally and keep it in a password manager: `openssl rand -base64 24`.

## Steps

1. Merge this branch to `main` (the Blueprint reads `render.yaml` from the repo root).
2. Render dashboard: **New > Blueprint**, pick the repo, apply. It creates the `daebot` web service (starter plan, `rootDir: agent`, auto deploy off).
3. In the service **Environment** tab fill every `sync: false` key above (`MIND_API_KEY`, `MIND_SESSION_API_KEY`, `OPENROUTER_API_KEY`, `GATEWAY_TOKEN`, `MINDCLAW_MODEL`, `MINDCLAW_CHEAP_MODEL`). Save; Render redeploys.
4. **Settings > Custom Domains**: add `daebot.live` and `www.daebot.live`. At the DNS provider create the records Render shows (CNAME for `www`, ALIAS/ANAME or the shown A record for the apex). Wait for the certificate to show Verified.
5. Verify: `https://daebot.live/health` returns `{"ok":true,"name":"mindclaw-gateway","hosted":true}`. Open `https://daebot.live/`: you get the sign-in screen. A wrong code is rejected, the right code loads the app. Ask it something that needs MIND (for example "what are my priorities") and confirm a MIND receipt comes back. Ask it to run `printenv`: it must say it has no shell.
6. Check the Render logs once: the start line says `hosted gateway listening` and must not contain the access code.

## Rollback

- **Bad deploy:** Render dashboard > service > **Events/Deploys** > pick the last good deploy > **Rollback**. (Auto deploy is off, so nothing ships without a manual deploy.)
- **Emergency stop:** Settings > **Suspend Service**. The domain then serves nothing.
- **Leaked or lost access code:** change `GATEWAY_TOKEN` in Environment and redeploy. Every existing session cookie is signed with the old value and stops working immediately.
- **Spend running away:** lower `MINDCLAW_DAILY_USD_CAP` and redeploy, or rotate `OPENROUTER_API_KEY` (a provider-side limit is the stronger lever).
- **Remove entirely:** delete the service, remove the two custom domains and their DNS records.

## Notes and limits

- The cost cap and login rate limiter are in memory: a restart or redeploy resets both. The cap guards one process; do not run more than one instance.
- Chats are saved on the persistent disk (`DATA_DIR=/data`, 1 GB, created by the Blueprint) after each completed turn, so a restart or redeploy keeps them and the web UI replays the saved transcript on resume (`GET /sessions/:id/history`). A session is only written once it has a first message. A disk means a single instance and in-place (not zero-downtime) deploys; if the disk is removed, chats fall back to MIND Agent Sessions only.
- Every hosted response carries `X-Robots-Tag: noindex, nofollow` and `/robots.txt` disallows everything.
- The MIND boot context is cached in memory per MIND key for 10 minutes, so new chats open fast after the first.
- Client IP for the login limiter is the right-most `X-Forwarded-For` entry (the one the platform proxy appends).

## Local check without keys

```
cd agent
MINDCLAW_HOSTED=1 GATEWAY_TOKEN=$(openssl rand -hex 18) ALLOWED_HOSTS=localhost PORT=7790 \
  OPENROUTER_API_KEY=x node src/cli.ts serve --hosted
```

## Sign in with MIND (per-user tenancy)

Anyone can sign in with their own MIND account and Daebot then reads and writes THEIR MIND. The owner access code (`GATEWAY_TOKEN`) keeps working and maps to the server `MIND_API_KEY`.

- Set `DAEBOT_SECRET_KEY` (32+ random characters; `openssl rand -base64 48`). Without it only the owner code is offered. Once users are stored, hosted mode refuses to start without it. Losing the key means users must sign in again.
- One data dir: `DATA_DIR` (`/data`, the 1 GB disk in render.yaml). Saved chats are in `DATA_DIR/sessions` (each record carries its owning user id, so chats, history, resume and the boot cache are per user); users are in `DATA_DIR/users/daebot-users.json`, credentials sealed with AES-256-GCM.
- `DAEBOT_ADMINS` (MIND usernames, comma list) get the unrestricted tier; everyone else is "staff" (no outward, irreversible or public tools). Optional `DAEBOT_ALLOWED_USERS` restricts who may sign in.
- `MINDCLAW_USER_DAILY_USD_CAP` (default 1) caps each non-admin user per UTC day, on top of `MINDCLAW_DAILY_USD_CAP`. Admins and the owner login are exempt from both caps and their spend does not count toward the global one, so strangers cannot lock them out.
- **MIND billing** (`DAEBOT_BILLING=mind`, default `openrouter`): every user's LLM calls go to `POST $MIND_BASE_URL/developer/v1/llm/chat/completions` with THEIR OWN MIND key (the owner login uses the server `MIND_API_KEY`), so their MIND plan and credits are the cap: both USD caps above are skipped and `OPENROUTER_API_KEY` is not needed. Explorer (tier `free`) runs on `DAEBOT_FREE_MODEL` (default `nvidia/nemotron-3-super-120b-a12b:free`); a refusal (`model_not_in_plan`, `model_not_available`, `insufficient_credits`) shows the user an upgrade link instead of trying other models. The sidebar shows a usage meter ("Plan usage · 62% left", from `credits_balance` / `credits_limit`; "Usage billed as you go" when there is no limit) and never says "credits"; `/auth/me` carries the numbers. Turn it on only after MIND's proxy is live (a 404 from it is reported as a misconfiguration); turn it off by setting `DAEBOT_BILLING=openrouter`.
- OAuth: Daebot registers itself with MIND as a public PKCE client (RFC 7591, redirect `https://daebot.live/auth/mind/callback`), so no admin action is needed. To pin a client instead, set `MIND_OAUTH_CLIENT_ID` (and optionally `MIND_OAUTH_CLIENT_SECRET`).
- Pasting a `mind_` API key is always available as the fallback; it is checked live against `GET /developer/v1/profile`.

## MIND Voice (mic, spoken answers, hands-free)

The web UI has a mic button (hold to talk, or tap to start and tap to stop), a speaker toggle that reads answers aloud, and a
hands-free conversation button. The gateway exposes `POST /voice/stt` (raw audio body, `audio/webm|mp4|ogg|wav`, up to 10 MB) and
`POST /voice/tts` (`{"text"}`, up to 3000 chars); both need the sign-in session cookie and forward to MIND's
`/developer/v1/audio/transcriptions` and `/audio/speech` with the signed-in user's OWN MIND key (the owner access-code login uses
`MIND_API_KEY`). MIND bills every call to that user's credits; Daebot adds no price and holds no voice key.

- No new Daebot env var. MIND must have `MIND_LLM_PROXY_ENABLED` on (the same flag as the LLM proxy) and an ElevenLabs key.
- Limits per user: 20 STT and 30 TTS calls a minute, 2 in flight. A user with no credits gets a clear message with the upgrade link.
- If MIND answers 404/503 the UI says voice is not switched on and stops retrying until reload.
- The CSP gained `media-src 'self' blob:` (spoken answers play from a blob URL); nothing else was loosened.

## Server-to-server agent API (MIND chat agent mode)

`POST /api/agent/turn` lets MIND's backend run a Daebot turn for an end user. Hosted mode with user sign-in enabled (`DAEBOT_SECRET_KEY`) only.

- Auth: header `X-MIND-Key: <the user's mind_ key>`, validated live against MIND (`GET /profile`). No cookie, no bearer. The turn runs in that user's own runtime and MIND, billed to their MIND usage (`DAEBOT_BILLING=mind`).
- Body: `{ "text": "...", "sessionId": "<from a previous turn, optional>", "surface": "mind-chat" }`.
- Response: `text/event-stream`, the same events as `/sessions/:id/send`. The session id is returned in the `X-Daebot-Session` header and as the first event `{"type":"session","sessionId":"..."}`. Send it back as `sessionId` to continue the conversation.
- Errors (JSON): 400 bad body, 401 missing/invalid key, 403 host/Origin/not allowed/not your session, 409 session busy, 429 rate limited (Retry-After), 502 MIND unreachable.
- Browser-safe by construction: any `Origin` header is refused (server callers send none); the Host allowlist and https rules still apply. Bad keys count against the per-IP login limiter.
- Rate limit: `DAEBOT_AGENT_API_RPM` turns per user per minute (default 30).

## Public website widget (PUBLIC_WIDGET_MODE)

A separate Render web service built from this same repo serves "Daebot for Astra AI" on theastraway.com. With `PUBLIC_WIDGET_MODE` unset (daebot.live) none of this runs: no route, prompt, tool or auth path changes.

- **Service:** Node web service, root directory `agent`, build `npm install --omit=dev --no-audit --no-fund`, start `node src/cli.ts serve`, health check `/health`, `NODE_VERSION=24`. No disk (sessions live in memory only; nothing is written).
- **Do not** set `MINDCLAW_HOSTED`, `GATEWAY_TOKEN` or `DAEBOT_SECRET_KEY` on it: it has no login and no users.
- **Embed:** `<script src="https://<widget-host>/widget.js" async></script>` on theastraway.com.
- **Routes:** `GET /health`, `GET /widget.js`, `GET /widget` (iframe chat page), `GET /brand/daebot-avatar.png`, `POST /api/widget/turn` (SSE). Everything else is 404.

| Key | Secret | Meaning |
|---|---|---|
| `PUBLIC_WIDGET_MODE` | no | `true` turns widget mode on |
| `WIDGET_MIND_API_KEY` | yes | MIND key of the ONE tenant every visitor turn reads (read-only `mind_query` only). Required. |
| `OPENROUTER_API_KEY` | yes | LLM key (same variable the agent already reads). Required. |
| `WIDGET_MODEL` | no | model id; default is `MINDCLAW_MODEL`, else the built-in default |
| `WIDGET_PERSONA_NAME` | no | default `Daebot` |
| `WIDGET_ALLOWED_ORIGINS` | no | CORS and iframe-embedding allowlist, default `https://theastraway.com,https://www.theastraway.com` |
| `WIDGET_RATE_LIMIT_MAX` / `WIDGET_RATE_LIMIT_WINDOW_MIN` | no | per-IP messages per window, default 20 per 10 min |
| `WIDGET_DAILY_USD_CAP` | no | daily LLM spend cap (UTC day, in memory), default 5 |
| `MIND_BASE_URL` | no | defaults to `https://m-i-n-d.ai/developer/v1` |
| `PORT` | auto | set by Render |

Limits: 2,000 characters per message, 12 turns of history per session, sessions expire after 30 minutes idle. Tools are an in-code allowlist (`WIDGET_TOOL_ALLOWLIST` in `src/widget/index.ts`): only `mind_query`.
