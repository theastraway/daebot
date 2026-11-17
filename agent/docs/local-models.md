# Local models (desktop and self-host)

Daebot can send light work to a model running on the same computer, at zero credit spend. Hosted Daebot (daebot.live) never does this.

## The panel (0.3.51 and later)

Account menu > **LLM & database** > **Local model server** (also the "LLM connectors" link at the bottom of the model menu). Type the server address (empty = `OLLAMA_HOST`, else `http://127.0.0.1:11434`; LM Studio is usually `http://127.0.0.1:1234`), click **Detect** to see what it serves, pick the model the router should prefer for light work, **Save**. No restart: the next turn uses it and the model menu lists the served models as "(this computer)". The switch at the top turns local use off without forgetting the address. Saved in `~/.daebot/data/local-llm.json`. On daebot.live the section explains that a model on your computer is reached by the desktop app on that computer.

## How it works

- At start the desktop gateway probes one local server: the panel's address if saved, else `OLLAMA_HOST` if set, else `http://127.0.0.1:11434`. It asks Ollama (`GET /api/tags`) and, if that is not Ollama, any OpenAI-compatible server (`GET /v1/models`: LM Studio, llama.cpp `llama-server`, vLLM). Embedding and rerank models are ignored.
- Served models are listed in `GET /models` (and the model picker) as `ollama/<name>`, always allowed, so a bot or the default model can be pinned to one. Calls are sent to `<base>/v1/chat/completions` with the `ollama/` prefix removed.
- The router uses the local model for reflex and light turns only when `DAEBOT_ROUTER=enforce`. The default is `shadow` (decisions are logged, not applied). A bot with its own pinned model, or a chat with a model picked by the user, is never re-routed.
- The local model is picked once at start: `DAEBOT_TIER_LOCAL` (for example `ollama/qwen3:14b`) if served, else the first served chat model. Install or start the server before Daebot, or restart Daebot after.
- Turn it off entirely: `DAEBOT_LOCAL_LLM=off`.

## Steps (Windows)

1. Install Ollama and pull a tool-capable model, for example `ollama pull qwen3:14b`. Check `ollama show <model>` lists `tools` under Capabilities.
2. Optional: set user environment variables `DAEBOT_ROUTER=enforce` and `DAEBOT_TIER_LOCAL=ollama/qwen3:14b`, then quit Daebot from the tray and start it again.
3. To use a model for one bot only: pick `<name> (this computer)` in the bot model picker (it reads GET /models), or PATCH the bot with model `ollama/<name>`.
4. LM Studio or llama.cpp: start its server, set `OLLAMA_HOST=127.0.0.1:1234` (LM Studio default port) and restart Daebot.

Heavy work (builds, review, plans) stays on the cloud tiers; a local model never takes coder, reasoner or frontier work through the router.
