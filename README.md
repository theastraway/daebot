# MINDClaw

**OpenClaw with MIND baked in.** One install, one command. Persistent knowledge graph memory wired into every agent turn.

```bash
curl -fsSL https://www.m-i-n-d.ai/install/mindclaw.sh | bash
```

Or with npm directly:

```bash
npm install -g @astramindapp/mind-claw
mindclaw init
```

## What MINDClaw is

MINDClaw is a free, open-source distribution of [OpenClaw](https://github.com/openclaw/openclaw) with the [MIND](https://www.m-i-n-d.ai) knowledge-graph memory layer pre-installed and pre-configured.

You get:

- The OpenClaw runtime, installed automatically on first run.
- The `@astramindapp/openclaw-mind` plugin — 11 tools, 4 skills, lifecycle hooks for auto-recall and auto-capture.
- The 16 MIND Front Layer typed-document templates (SOUL, IDENTITY, BELIEFS, USER, AGENTS, TOOLS, SENSES, SKILLS, BEHAVIOR, LESSON, DECISION, POLICY, WORKFLOW, PREFERENCE, GOAL, RELATIONSHIP) seeded into your knowledge graph on first run.
- The `HOW_TO_THINK`, `HOW_TO_REMEMBER`, and `TAGGING_SYSTEM` operating manuals seeded alongside the templates so any agent can ask MIND how to think in MIND-shaped nouns.

In other words: stock OpenClaw plus everything you'd otherwise spend an hour wiring up by hand.

## How it works

The `mindclaw` CLI is a slim wrapper around the upstream `openclaw` runtime. It owns first-run onboarding and a few native commands; everything else forwards verbatim, so muscle memory carries over.

Native commands:

| Command | What it does |
|---|---|
| `mindclaw` | First-run wizard, then start an interactive session |
| `mindclaw init` | Re-run onboarding (replaces existing config) |
| `mindclaw seed-templates` | Bootstrap the 16 typed-doc templates into your KG |
| `mindclaw status` | Show MIND connection + plugin state |
| `mindclaw upgrade` | Open Stripe checkout for the $10/mo Claw tier |

Anything else is forwarded to `openclaw`. Examples:

```bash
mindclaw run "Plan my Tuesday"
mindclaw plugins list
mindclaw mind search "what did we decide about pricing?"
```

## Pricing

| Tier | Price | What you get |
|---|---|---|
| **Free** | $0 forever | 50 credits/mo for premium MIND features, 10 MB KG storage, all 16 typed templates |
| **Claw** | $10/mo | MCP-host access, 500 MB KG storage, 300 credits/mo, BYO LLM (you pay for inference yourself) |

Need more? The Starter ($49), Professional ($199), Business ($599), and Scale ($1499) tiers on [m-i-n-d.ai](https://www.m-i-n-d.ai) all work seamlessly with MINDClaw.

## First-run wizard

On first launch, `mindclaw` asks how you want to connect:

1. **Paste an existing MIND API key** — fastest path if you already have an account.
2. **Create a free account** — registers a new MIND tenant via the public registration endpoint, issues an API key, and seeds the templates. No card required.
3. **Create an account and upgrade to Claw** — same as #2, then opens Stripe checkout for the $10/mo tier in your browser.

In all three paths the wizard:

- Writes the OpenClaw plugin config to `~/.openclaw/plugins/openclaw-mind.yaml`.
- Writes `MIND_API_KEY` and `MIND_BASE_URL` to `~/.openclaw/.env`.
- Runs `mindclaw seed-templates` automatically.
- Saves wrapper state to `~/.mindclaw/state.json` (so `mindclaw status` works).

Re-run the wizard any time with `mindclaw init`.

## What gets seeded into your knowledge graph

When you run `mindclaw seed-templates` (or first-run, automatically), MINDClaw seeds the following into your MIND tenant:

- **The 16 Front Layer typed-document templates** — augmented markdown specs that tell an agent when and how to create a SOUL doc vs. a BELIEFS doc vs. a POLICY doc, with frontmatter slots and storage protocol.
- **`HOW_TO_THINK.md`** — the six-step loop every agent should follow when its memory layer is MIND.
- **`HOW_TO_REMEMBER.md`** — anatomy of a good memory, what belongs in MIND, and what doesn't.
- **`TAGGING_SYSTEM.md`** — the topic / project / kind axis system that makes retrieval reliable.

After seeding, any agent can ask MIND `"what should I fill out for a BELIEFS document?"` and the spec comes back from the user's own knowledge graph.

## Why a distribution, not just a plugin

The MIND plugin for OpenClaw already exists. MINDClaw goes further: it ships the runtime, the plugin, the templates, the tagging docs, and the onboarding wizard as one package. New users go from `curl … | bash` to a working agent with persistent memory in under two minutes — no API key copy-paste, no config file editing, no plugin install step.

## Configuration

The wrapper writes sensible defaults into `~/.openclaw/plugins/openclaw-mind.yaml`. To override anything, edit that file:

```yaml
apiKey: ${MIND_API_KEY}
baseUrl: https://www.m-i-n-d.ai
autoCapture: true
autoRecall: true
topK: 10
queryMode: hybrid
enableMindsense: true
enableLifeIntegration: true
enableCrmLogging: true
```

Or set env vars: `MIND_API_KEY`, `MIND_BASE_URL`. The plugin reads both.

## Privacy and security

- The `mindclaw` CLI is open source under MIT. No telemetry, no tracking.
- Your MIND API key is stored locally in `~/.mindclaw/state.json` and `~/.openclaw/.env`, both with `0600` permissions.
- All HTTP calls go to `https://www.m-i-n-d.ai` (or your `MIND_BASE_URL` override). No third parties.
- Your knowledge graph is yours. Export it any time from the MIND web app.

## Project layout

```
mindclaw/
├── bin/mindclaw.mjs         CLI entry point
├── src/
│   ├── onboard.mjs           First-run wizard
│   ├── install.mjs           Ensure runtime + plugin are installed
│   ├── seed.mjs              Bootstrap templates into the user's KG
│   ├── status.mjs            Health check
│   ├── upgrade.mjs           $10 tier checkout
│   └── lib/                  state, log, MIND API client, OpenClaw config
├── templates/
│   ├── front-layer/          16 typed-document templates
│   ├── HOW_TO_THINK.md
│   ├── HOW_TO_REMEMBER.md
│   └── TAGGING_SYSTEM.md
├── docs/mindclaw.html        Landing page
├── install.sh                One-line installer
└── backend-changes/          Backend changes the wrapper depends on
```

## Patents pending

MIND's core technology is protected by multiple pending US patent applications.

## License

MIT. Built by [Astra AI](https://www.m-i-n-d.ai).
