# MINDClaw Agent: Architecture Spec (v0)

Our own agent. Own loop, own kernel, own tools, MIND built in. Not a wrapper over OpenClaw or Hermes.
Owner: Anthony Conti / Astra AI. Language: TypeScript (erasable syntax only), Node >= 22.18, run with
`node src/cli.ts` (native type stripping), compile to one binary with `bun build --compile`.
Dependencies: keep near zero (Node built-ins, fetch, WebSocket via `ws` only if needed). No frameworks in core.

## 1. Principle
MIND rules (MIND.md, AGENTS.md, Integration Protocols) are not prose in a prompt. They are Gates in
`kernel/` that run at four hooks in `loop.ts` and can refuse to proceed. Prose is only the system prompt
on top. Shadow mode (MINDCLAW_SHADOW=1) logs violations without blocking, kernel off (MINDCLAW_KERNEL=0)
exists so the eval harness can measure the difference.

## 2. Layout (each directory has ONE owner during the build)
```
src/types.ts          THE CONTRACT (read first, do not break)
src/config.ts         loadConfig()
src/provider/         OpenRouter streaming + model router + cost tracking
src/loop.ts           AgentSession implementation: turn loop, hooks, tool execution
src/tools/            builtin tools + registry (bash, read, write, edit, glob, grep, web_fetch)
src/mind/             MindClient (REST), mind_* tools, SessionSync, boot
src/kernel/           Gates, Kernel, violation log
src/runtime.ts        Runtime implementation: boot, sessions, wiring
src/gateway/          HTTP + WebSocket server, auth, static hosting of web/
src/ui/               terminal client (TUI) that talks to the gateway (or in-process)
src/channels/         ChannelAdapter implementations (telegram, discord, imessage, webhook)
src/eval/             compliance harness: scripted scenarios, kernel on vs off
web/                  web UI (static, served by gateway)
desktop/              desktop app shell wrapping the web UI
test/                 node --test files, mirror the src layout
THIRD-PARTY-NOTICES.md  provenance of any borrowed code (see section 7)
```

## 3. Turn loop (loop.ts)
1. `pre_turn` gates (boot gate). If not booted, runtime already ran `mind_context`; the loop records it as a CallRecord with receipt "mind".
2. Call provider with messages + ToolSpecs (only tools the kernel currently allows are offered).
3. For each toolCall: `pre_tool` gates. block -> return the one-line reason as the tool result (ok:false). needs-confirmation -> emit `confirm` event, stop the turn, wait for the NEXT user message. rewrite -> use rewriteArgs. allow -> run, assign receiptId c1,c2..., push CallRecord, emit toolStart/toolEnd.
4. Loop until the model returns text with no toolCalls or maxToolRoundsPerTurn.
5. `pre_answer` gates on the draft text (receipt gate). block -> append the reason as a system nudge and regenerate (max 2 regenerations, then ship with a visible "unverified" footer and log a violation).
6. `post_turn`: append user+assistant to SessionSync, memory capture, usage event, `done`.

## 4. Kernel gates (v0 set, each is a file in kernel/ plus a test)
- boot: before booted, only mind_context / mind_sense / mind_profile allowed. Everything else blocked with "boot first: call mind_context".
- receipt: claims need receipts. Detect (a) done/built/live/working/deployed/merged claims, (b) existence or non-existence claims ("doesn't exist", "no such", "not supported", "I can't"), (c) emails, prices ($), percentages, long ids. Require in the draft a line `MIND✓ #cN ...` or `SURFACE✓ #cN ...` where cN is a CallRecord id from THIS turn whose `receipt` kind matches. A receipt id that does not exist, or is from an earlier turn, is invalid. Negative claims additionally require >= 2 queries (different wording) or one bare list.
- owner: calls to mind_remember/mind_folders/mind_tags-like writes must include `owner_check` = "A == B" with both named; mismatch or missing -> block. (Tool wrapper in mind/ adds the param to the schema.)
- feed: tools of class "public" are NOT offered unless the latest user message matches /\b(post|share|tweet|feed)\b/i. Otherwise blocked.
- danger: tools of class "outward" or "irreversible" -> needs-confirmation. A Confirmation counts only if grantedAtUserMsg > proposedAtUserMsg and the user message contains an explicit action phrase (send it, do it, yes run it, go ahead and <verb>). Approving a goal never grants an action.
- isolation: write/edit/bash-with-write inside a git repo that is not a worktree under ~/.worktrees -> block with "cut a worktree first (mwt)". Config flag, default on for repos under ~/Documents/GitHub.
- All gates return ONE-line reasons that say what to do next. Shadow mode downgrades block -> log.

## 5. Gateway protocol (gateway/)
`mindclaw serve` starts the daemon on 127.0.0.1:7777 (configurable). Auth: bearer token in
~/.mindclaw/gateway-token (generated on first run, 0600). HTTP: `GET /health`, `GET /sessions`,
`POST /sessions` {surface,title,resumeId} -> {sessionId}, `POST /sessions/:id/send` {text} -> SSE stream of AgentEvent,
`POST /sessions/:id/abort`, `DELETE /sessions/:id`. WebSocket `/ws` carries ClientFrame/ServerFrame from types.ts.
Static: `/` serves web/. Surfaces connect over this; a surface never imports loop/provider/kernel.
Remote access later via tunnel; bind to localhost by default.

## 6. Surfaces
- Terminal (ui/): full-screen-ish REPL, streaming text, tool lines, gate notices in a distinct style, `/` slash commands (/sessions /model /shadow /violations /cost /quit), works against the gateway or in-process (`--local`).
- Web (web/): static SPA, no build step (vanilla JS or Preact via import map from a pinned CDN is acceptable, prefer zero deps), chat view with streaming, a gate/violations drawer, session list, confirm dialogs for `confirm` events, dark/light. Follow the repo's UI standards (load the `mind-ui-design-standards` skill).
- Desktop (desktop/): thin shell that starts the gateway as a child and shows the web UI in a native window. Pick the lightest option that works on macOS from this repo (Electron is acceptable; keep the app under 300 MB RAM idle). Menu bar item, global shortcut, notifications on confirm events.
- Channels (channels/): Telegram (Bot API long-polling), Discord (gateway websocket via raw API, no heavy SDK), iMessage via SendBlue webhook (inbound webhook route on the gateway + outbound REST), generic webhook. Each maps a chat/thread id to an AgentSession, sets surface name, strips markdown per channel, and routes `confirm` events as a plain-text question. Channel-specific user tiers: unknown senders get a restricted tool set (read-only, no write/outward).

## 7. Licensing and provenance (Anthony's rule)
If a license allows reuse (MIT, Apache-2.0, BSD, ISC), code may be used verbatim: keep the copyright and license header in the file, and add a row to THIRD-PARTY-NOTICES.md (source repo, path, commit, license). If a license does not allow reuse (proprietary, GPL, AGPL, source-available, unknown, or no license), treat the project as workflows and concepts ONLY: read nothing into our tree, re-implement from the concept in our own words and structure. Reference projects: xai-org/grok-build (Apache-2.0), NousResearch/hermes-agent (MIT), openclaw/openclaw (MIT). Claude Code is proprietary: concepts only. Always check the LICENSE file of the specific repo before copying; do not rely on this list.

## 8. Rules for builders
- Code only against src/types.ts. Need a type change? Write the proposal at the end of your report; do not edit types.ts.
- Touch only your assigned directories. No edits to other directories or to the legacy wrapper (bin/, src/ at repo root).
- Tests: `node --test --test-concurrency=2`. Never run the whole repo at default concurrency. No network in unit tests (fake provider/fake fetch).
- Never print or write secrets. API keys come from env (MIND_API_KEY, OPENROUTER_API_KEY) or ~/.mindclaw/config.json.
- Do not launch GUI apps, do not drive the user's mouse/windows, do not run `agent-browser close --all` or any kill-all.
- Do not git commit, push, or run mship. The orchestrator commits.
- Finish by reporting: files created, test results (the summary line, not the exit code of a piped command), open questions, and the exact commands to run it.

## 9. Decisions (decide, mind_decision_record, Decision Protocol)
- `decide` (tools/decide.ts, class read, offered only when OPENROUTER_API_KEY is set, runs hosted, not offered to the public tier): POST https://openrouter.ai/api/alpha/decisions with `typesafe/jev-1.13` (default) or `perplexity/pplx-decider-v1.1-27b`, falling back to the other on any failure. Returns choice, probabilities, confidence. Its cost is reported in `meta.costUsd`; the loop adds it to the turn's usage. TODO: DAEBOT_BILLING=mind does not cover this endpoint yet (MIND proxies chat completions only), so it uses the server key; move it behind MIND when the proxy supports /api/alpha/decisions.
- `mind_decision_record` (mind/tools.ts, class write, owner_check required): files a PRIVATE document "Decision - <subject> - YYYY-MM-DD" via the existing MindClient.remember.
- The Decision Protocol (OOC/EMR) lives in `composeSystemPrompt`. A decide result is advice and never overrides a user instruction or a kernel gate.

## 10. Sessions and Bots (src/bots/)
- A bot is a named persistent agent: its own MIND (a graph workspace inside the user's account, addressed with the user's MAIN key plus the header `X-MIND-Bot: <slug>`; there are no bot keys), its own `DAEBOT.md` (8 KB cap) and its own threads. Sessions and bots get the same tools; they differ only in prompt, home MIND and instructions. A bot session runs INSIDE the user's runtime (`openSession({botId})`), so the provider key and billing stay on the MAIN account. Learning is off for bots. MIND Chat sync uses the MAIN key with source `daebot-bot-<slug>`.
- Store: `DATA_DIR/bots/<ownerId>/bots.json` (+ `<botId>/DAEBOT.md`), one store per owner (another owner's id is "not found"). Create/delete call MIND first (`POST/GET/DELETE /developer/v1/bots`); MIND is the source of truth for existence and the list reconciles with it.
- Tools (`mind/tools.ts`): every READ tool takes an optional `mind` ("main" or a bot slug) that becomes the `X-MIND-Bot` header and never reaches a body. WRITE tools always go to the home MIND and have no `mind` argument (naming another MIND is refused). `mind_tenants` lists the live roster. At most 3 cross-MIND reads in flight. MIND answers `400 bot_unsupported` for routes a bot MIND lacks (only query, context, documents, entries, graph, profile work); that becomes a clear tool error. Negative claims (receipt gate) need two differently worded queries on EACH tenant queried.
- `bot_talk({to, message})` (class write, no receipt): the in-process bus (`bots/bus.ts`, set by `startGateway`) runs the recipient's turn through `SessionManager.turn` on a DM thread keyed (recipient, sender) with `origin:"bot"`. Limits: depth 3, no revisiting a bot in the chain, 10 bot turns per root user message, 5 bot_talk calls per turn, 90 s then the recipient is aborted, per-user rate limit, no queueing (busy DM thread = "busy, try again shortly"), reply capped at 8k chars and quoted as untrusted data. SECURITY: a turn with `origin:"bot"` never calls `kernel.onUserMessage` and never exposes its text as `TurnState.userMessage`, so a bot can never grant a pending outward/irreversible confirmation or unlock the feed.
- Model per session: `StoredSession.model`, read per turn by the loop (`AgentSession.setModel`). `GET /models` proxies MIND's `GET /developer/v1/profile/models` (falls back to the configured models + the free model); free plan = free models only (402 `model_not_in_plan`). The per-user default model lives in `DATA_DIR/settings/<ownerId>.json`.
- REST (cookie/bearer auth like `/sessions`): `GET/POST /bots`, `GET/PATCH/DELETE /bots/:id`, `GET/PUT /bots/:id/instructions`, `GET /sessions?bot=<id>` (bot threads are excluded from the default list), `POST /sessions {bot, model}`, `PATCH /sessions/:id {model}`, `GET /models`, `PUT /models/default {model|null}`. Keys are never returned.
- Feature flag: env `DAEBOT_BOTS_ENABLED` (default OFF, read on every use). Off: `/bots*` and `POST /sessions {bot}` answer 404, `bot_talk` and `mind_tenants` are not offered, bot sessions cannot be opened, and `GET /health` and `/auth/me` carry `bots:false` so the web UI hides the Sessions|Bots toggle. The model picker (`/models`) does not depend on it.
- Transcript sync: human <-> bot threads sync to MAIN agent-sessions under source `daebot-bot-<slug>` (the user's own chat history; MAIN is readable by design). Bot-to-bot DM threads (`peer` set, origin bot) are NOT synced to MAIN.
- Bot sessions have no `bash`, `write_file` or `edit_file` in any mode (a bot's writes go only to its own MIND); `web_fetch` with a query string, fragment, body or non-GET counts as outward there. The shell tool itself runs with an allowlisted env (PATH, HOME, LANG, TMPDIR, USER, SHELL).
- Peer turns (`origin:"bot"`) cannot request outward/irreversible/public tools (refused outright, no confirmation is created), start with no pending confirmations, and a granted confirmation is valid for one turn only. The DM recipient runs at the lower of the caller's and the owner's tier (the tier is part of the DM thread id).
