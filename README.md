# Daebot

Daebot is a public AI agent from [Astra AI](https://www.m-i-n-d.ai) with [MIND](https://www.m-i-n-d.ai) built in: persistent memory, your knowledge graph, and the MIND protocols enforced as code instead of suggested in a prompt.

Live at **https://daebot.live**.

## Sign in with MIND

1. Open https://daebot.live.
2. Choose **Sign in with MIND** and enter your MIND username and password (create a free account at https://www.m-i-n-d.ai if you do not have one).
3. Ask it something that needs your memory, for example "what are my priorities". Each MIND call comes back with a receipt.

Signed-in users get their own saved chats and a per-day spend cap. Admin accounts are listed in `DAEBOT_ADMINS`; everyone else gets the staff tier.

## Repository layout

```
daebot/
├── agent/            the Daebot agent: runtime, gateway, web UI, desktop app, tests
│   ├── src/          agent loop, kernel, MIND client, gateway, providers
│   ├── web/          the browser app served at daebot.live
│   ├── desktop/      Electron desktop app
│   ├── DEPLOY.md     how the hosted service is deployed
│   └── SPEC.md       design notes
├── render.yaml       Render Blueprint (service `daebot`, root directory `agent`)
└── LICENSE
```

## Run it

```bash
cd agent
npm install
npm test
node src/cli.ts serve
```

Hosted settings (environment variables, caps, disk) are described in `agent/DEPLOY.md` and `render.yaml`.

## Third-party attribution

See `agent/THIRD-PARTY-NOTICES.md`.

## Patents pending

MIND's core technology is protected by multiple pending US patent applications.

## License

MIT. Built by [Astra AI](https://www.m-i-n-d.ai).
