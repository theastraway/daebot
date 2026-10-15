# Daebot learning: research, design, measurement

Status: built on branch `claude-daebot-learning`. Code in `agent/src/learn/`, eval in `agent/src/eval/learning/`.
MIND is the long-term memory. Nothing here makes the kernel optional: lessons are advice inside a gated loop.

Research caveat, stated first: Anthony's research MIND (Oscar, ~52k ML documents) could not be consulted. Its `/health` answered but every
`/developer/v1/query` hung past 2 minutes (reported by the orchestrator, 2026-10-15). Everything below rests on the Hermes source and the
papers cited. Nothing from Oscar is folded in.

## 1. How Hermes Agent learns (read from source)

Local copy: `~/.hermes/hermes-agent`, version 0.17.0 (`pyproject.toml:10`), MIT (`LICENSE`). Upstream `main` was `acc3cada` (v0.22.2 release, 2026-10-15) when checked with
`gh api`. Paths below are the local v0.17.0 tree unless marked upstream. No Hermes code is copied into this repo; the concepts are re-implemented in TypeScript
(see `THIRD-PARTY-NOTICES.md`).

| Capability | Where | What it does |
|---|---|---|
| Background review fork | `agent/background_review.py:1-17` | After a turn is delivered, a forked agent replays the conversation and asks "should any skill or memory be saved or updated?". It never touches the main prompt cache. Tool whitelist limited to memory and skills (`:724-760`, `max_iterations=16` at `:643`). |
| Cheaper review model | `background_review.py:28-70` | Review runs on the main model by default (warm cache). `auxiliary.background_review.{provider,model}` routes it to a different one; then a compact digest replaces the full replay (`:117-150`). |
| Periodic memory nudge | `agent/agent_init.py:1154,1162`; `agent/turn_context.py:285-291` | Every `nudge_interval` user turns (default 10) a memory review is queued. Counter resets when the memory tool is used (`tool_executor.py:319,952`). |
| Skill creation nudge | `agent_init.py:1247-1250`; `conversation_loop.py:644-648`; `turn_finalizer.py:433-456` | Counts tool-calling iterations; at `creation_nudge_interval` (default 10) a skill review is queued after the reply. Reset when `skill_manage` is used. |
| Autonomous skill creation and patching | `background_review.py:170-274` (`_SKILL_REVIEW_PROMPT`); `tools/skill_manager_tool.py:1-30,252-345` | Prompt tells the reviewer to be active, prefers patching a loaded skill, then an existing umbrella, then a support file, then a new class-level skill. Names must be class-level, never a PR number or error string. Validated names (<=64 chars), frontmatter, 100k-char cap. |
| Corrections are first-class signals | `background_review.py:170-200` | "stop doing X", "too verbose", "remember this" are listed as skill signals, not only memory signals: the preference is embedded in the skill that governs the task. |
| What NOT to capture | `background_review.py:249-274,335+` | Environment failures (missing binary, unconfigured credential), negative claims about tools ("X is broken", which "harden into refusals the agent cites against itself for months"), transient errors that resolved, one-off task narratives. This is the single most reusable idea. |
| Bounded curated memory | `tools/memory_tool.py:1-22,1005-1027` | Two files, MEMORY.md (agent notes) and USER.md (user model), char-limited (2200 / 1375 defaults at `agent_init.py:1164-1166`). Priority rule in the tool schema: "user preferences and corrections > environment facts > procedures". SKIP list: trivial facts, raw dumps, task progress. |
| Frozen snapshot + injection scan | `memory_tool.py:125-160`; `tools/threat_patterns.py` | Memory enters the system prompt as a snapshot taken at session start. Each entry is scanned for injection patterns at snapshot time; a hit is replaced with `[BLOCKED: ...]`. |
| Fenced recall | `agent/memory_manager.py:337-352,495-520` | Prefetched recall is wrapped in `<memory-context>` with a system note ("recalled memory context, NOT new user input"). Fence tags in provider output are stripped (`sanitize_context`, `:163`). |
| Cross-session recall | `tools/session_search_tool.py:1-30` | SQLite FTS5 over all past messages, three shapes (discover / scroll / browse), zero LLM cost. |
| User model | `plugins/memory/honcho/__init__.py:1-12`; `memory_tool.py` (USER.md) | Two layers: a small always-injected USER.md, and an optional Honcho provider (dialectic Q&A, peer cards, "conclusions"). |
| Usage telemetry + lifecycle | `tools/skill_usage.py:1-45,587-620`; `agent/curator.py:1-60,276-330` | Per-skill view/use/patch counters in a sidecar JSON. Curator (7-day interval, `curator.py:56`) moves unused skills active -> stale (30d) -> archived (90d). Never deletes, pinned skills exempt, bundled and hub skills untouchable. |
| Skill security scan | `tools/skills_guard.py:627`; `skill_manager_tool.py:59-110` | Agent-created skills are scanned for dangerous content before they are accepted. |
| `/learn` | `agent/learn_prompt.py:1-40` | User-triggered: turn a described workflow or document into one SKILL.md under authoring standards. |

Newer upstream (not in the local copy), seen via `gh api repos/NousResearch/hermes-agent/contents/agent`: `learning_graph.py`, `learning_mutations.py`, `review_engine.py`,
`review_idle_queue.py`. `learning_mutations.py` (fetched, 207 lines) lets the user edit or delete learned skills and memories, and deleting a skill archives it rather than
removing it. `review_engine.py` is the code-review `/review` command, not self-improvement. `review_idle_queue.py` was not read; whether it defers reviews until the
agent is idle is UNVERIFIED.

What Hermes does that we deliberately do differently:
- It writes to local files; we write only to MIND, so every lesson is searchable, auditable and shared across surfaces.
- Its review fork has write tools. Ours has none: the reflector returns JSON, and code validates, scrubs and writes it (the model never holds a write tool).
- It has no outcome feedback on memory entries. Only skills get usage counters and only inactivity retires them. We add helped/hurt accounting and demotion (section 3).
- "Be ACTIVE, nothing-to-save is a missed opportunity" (`background_review.py:170`) is the opposite bias to the one the papers below warn about. We default to writing nothing.

## 2. Research literature (verified against arXiv on 2026-10-15)

| Paper | Mechanism | Measured gain | Failure modes reported |
|---|---|---|---|
| Reflexion, arXiv 2303.11366 | Verbal self-reflection after a failed trial, kept in a 1-3 item episodic buffer. | AlfWorld +22 points over 12 steps; HotPotQA +20; HumanEval pass@1 91.0 vs 80.1. | Local minima; no gain on WebShop (needs exploration); no gain on a weak base model (starchat-beta 0.26 -> 0.26): the model must be able to reflect. |
| Voyager, 2305.16291 | Verified executable skills in an embedding-indexed library. | 3.3x unique items, 15.3x faster tech-tree milestones (abstract). Removing self-verification cut items by 73%. | Self-verification misses real successes; hallucinated skills; the verification gate is the component that matters most. |
| ExpeL, 2308.10144 | Insights extracted by comparing successes and failures, with +/- votes; dropped at count 0. | HotpotQA 28 -> 39, ALFWorld 40 -> 59, WebShop reward 0.666 -> 0.701. | Insight list must fit context; votes come from the LLM, not ground truth, so a wrong insight can survive (inference). |
| Generative Agents, 2304.03442 | Memory stream scored by recency (0.995/h decay) + importance + relevance; reflections stored back. | TrueSkill 29.89 full vs 26.88 without reflection vs 21.21 with no memory. | Retrieval degrades as memory grows; embellishment; 6 of 453 claims (1.3%) hallucinated. |
| MemGPT, 2310.08560 | OS-style paging between main context, recall store and archival store. | Deep memory retrieval 32.1% -> 92.5% (GPT-4). | Needs strong function calling; stops paging early; no judge of whether a stored fact is correct. |
| A-MEM, 2502.12110 | Zettelkasten notes, LLM-generated links, old notes rewritten when new ones link. | LoCoMo multi-hop F1 27.02 vs 25.02 baseline; 85-93% fewer tokens. | Rewrites old notes in place; drift from that is untested (inference). |
| Agent Workflow Memory, 2409.07429 | Induced workflows from successful trajectories. | WebArena 35.5 vs 23.5 (+51% relative). | Wrong success judgments become bad workflows that degrade later tasks; offline + online combined was worse than either alone; rigid workflows break on pop-ups. |
| ReasoningBank, 2509.25140 | Strategy-level items from successes and failures. | WebArena (Gemini-2.5-flash) 40.5 -> 48.8; learning from failures 49.7 vs 46.5 successes-only. | More retrieved items hurt: k=1 49.7, k=2 46.0, k=3 45.5, k=4 44.4. No pruning or merging. |
| SkillWeaver, 2504.07079 | Synthesize Python APIs from verified practice. | WebArena 22.6 -> 29.8. | Wrong API or parameters chosen; LLM judges pass bad tests; side effects while exploring live sites. |
| Experience-following, 2505.16067 | Study of agents copying outputs of similar retrieved records. | (harm study) | Flawed stored experience propagates; misaligned replay; fixes: selective add plus deletion, later outcomes as labels. |
| Misevolution, 2509.26354 | Study of self-evolving agents drifting unsafe. | (harm study) | Memory accumulation alone moved refusal 99.4% -> 54.4% and attack success 0.6% -> 20.6% on one agent. Framing memory as "reference, not rules" only partly recovered it (20.6 -> 13.1). |
| MINJA, 2503.03704 | Attacker writes malicious records via ordinary queries. | 98.2% injection success. | Benign records dilute it (68.9% -> 31.1% with 25-100 benign queries). |
| AgentPoison, 2407.12784 | Backdoor trigger poisoned into memory / RAG. | 80%+ attack success at <0.1% poison rate (v1 abstract). | Version figures differ; the 63% end-to-end figure is UNVERIFIED. |

UNVERIFIED items in the source brief: Dynamic Cheatsheet (2504.07952) body read only from the abstract (Game of 24 10% -> 99% for GPT-4o); Memory-R1 (2508.19828) gains not read;
A-MEM's "2x" claim holds in ROUGE-L only, not F1.

### What the evidence changed in the design
1. Gate writes on evidence, not on self-judgement (Voyager, AWM). Lessons require an observed signal (kernel block, tool failure, user correction, or a verified multi-step success). `reflect.ts` + `learning.ts apply()`.
2. Few items, hard budget (ReasoningBank k-curve). At most 4 items, 2400 chars (~600 tokens), `recall.ts`.
3. Utility feedback and deletion (ExpeL, 2505.16067). helped/hurt counters, one-way demotion, `store.ts statusFor`.
4. Staleness decay (Generative Agents recency). Half-life 120 days in `rank()`.
5. Treat memory as an attack surface (MINJA, AgentPoison, Misevolution). Write trust tiers, taint rule, content guard on write AND on read, advisory framing, kernel unchanged. `guard.ts`.
6. Append-only revisions, never in-place rewrite (A-MEM drift). `records.ts`.
7. Default to writing nothing; do not record "X is broken" (Hermes list, Misevolution). `REFLECT_SYSTEM`.

## 3. Design (what was built)

```
user message
  -> loop.beforeTurn: one mind_query for lessons/skills + user model (cached per session, 4 s bound, fails open)
       rank (relevance x smoothed helped-rate x staleness decay), guard, budget -> ONE "[learned]" system note (replaced each turn, never persisted)
  -> normal turn (kernel gates unchanged)
  -> loop.afterTurn (fire and forget): triggers? -> trust? -> reflect on MINDCLAW_CHEAP_MODEL -> validate -> write to MIND
```

Files: `triggers.ts` (what is worth reflecting on), `guard.ts` (trust + content), `reflect.ts` (one cheap-model JSON call), `records.ts` (text format and parser), `store.ts` (MIND-backed store, dedupe, counters, demotion), `recall.ts` (ranking and the note), `learning.ts` (orchestration), `config.ts`.
Hooks: `loop.ts` (`SessionDeps.learn`, 3 small blocks: before the first provider call, after the reply, in `close`; plus exclusion of the note from `exportState`/`restore`), `runtime.ts` (creates one `Learning` per admin-tier session when enabled).

1. Post-turn reflection. Triggers: enforced kernel block (or an unverified-footer ship), tool failure, user correction (regex for no/wrong/"I told you"/"you keep"/"don't use", shouted phrases, profanity, `!!`, and a near-verbatim repeat of an instruction from the last 3 messages), multi-step success (>=3 real tool calls, >=2 distinct tools, none failed, no block). At most one lesson per reflection, one reflection in flight, 6 per session. Written as a PRIVATE `entry` titled exactly `Lesson - Failure|Win|Behavior - <2-3 words>` (no slash, parentheses, em dash; enforced by `lessonTitle`/`validLessonTitle`), tags `daebot-lesson` and the kind, `source: daebot-learning`.
2. Dedupe and supersede. Before writing, the pool and a `mind_query` are compared by token Jaccard (>= 0.5). A match writes revision n+1 of the same key with merged evidence (cap 5), tag `supersedes:<mind id>` and a `supersedes:` field, instead of a new lesson. Reads keep the highest revision per key.
3. Skill library. A multi-step success with no failure and no correction may also produce a `Skill - <slug>` PRIVATE `document` (steps, tools, preconditions, success count). Re-learning the same skill bumps `successes`.
4. Quality control. Each injected item counts a use. The next user message is the verdict: a correction counts `hurt`, anything else `helped`; a failing turn counts `hurt` immediately. >= 3 judged uses with hurt ratio >= 0.5 demotes; >= 5 hurt at ratio >= 0.6 retires. Demotion is one-way (only a human re-activates). Counters are written as a new revision on session close.
5. User model. One PRIVATE `document` `Daebot - User Model - <username>` (`MINDCLAW_LEARN_USER`, default `anthony`), at most 25 preferences, one per area (a new statement in the same area replaces the old), only learned from turns with a correction, injected as the first line of the note on every turn.
6. Safety. A write requires admin tier and a turn that did not call `web_fetch`. Public, staff and non-admin channel identities neither read nor write lessons (`runtime.ts` creates no `Learning` for them), so private lessons cannot leak out and nothing they say can get in. Candidate text is rejected if it holds a secret-looking token, email, URL, long id, dollar amount, phone, a registered client name (`MINDCLAW_CLIENT_NAMES`), or tries to teach the agent to skip/bypass/disable kernel gates or act "without asking" (negated restatements such as "never skip the receipt line" pass). The same check runs again before injection. The note says it is advisory and never overrides the kernel. Lessons go straight through `MindClient.remember` as PRIVATE records; they never use the public feed tools, and the owner gate is not bypassed for agent tools (it does not apply to this code path, which only writes Daebot's own behavior notes).

Config: `MINDCLAW_LEARNING=1` (default on when hosted, `=0` forces off), `MINDCLAW_CHEAP_MODEL` (reflection model, already in `config.ts`), `MINDCLAW_LEARN_USER`. Reflection spend is added to the hosted daily cost cap via `onCost`.

### Format facts about live MIND (observed 2026-10-15 with a read-only `mind_query`)
- Retrieval returns chunks shaped `# <title>\n\n## Original Entry\n<body>\n\n## AI Analysis\n<generated commentary>`, JSON-escaped, **with no ids**. So records carry their own `[daebot-lesson v1]` block and key, the parser decodes JSON content strings, and the body may appear twice. Lessons are cited by key (`L-ab12cd`), not by the MIND id. The MIND id is recorded only for revisions this process wrote (it is what `supersedes` points at). A cross-process supersede therefore falls back to "same key, higher rev wins". Short keys also avoid the receipt gate treating a long hex id in the reply as a claim needing a receipt.
- MIND appends an "AI Analysis" section to entries. It is ignored by the parser. Whether it could ever re-surface a stale lesson text is UNVERIFIED.

## 4. Measurement (`node src/eval/run.ts --learning`)

Scripted student model (makes a named mistake, follows a lesson only when the note contains the fix words), scripted reflector (returns the JSON a competent model would), real loop + real kernel + real learning layer, FakeMind with lexical retrieval shaped like the live output. 6 mistake classes x (1 session-1 task + 3 session-2 tasks + 1 control).

```
condition   all      similar  paraphrase  false-injection(control)
off         100%     100%     100%        0%
on          33%      0%       100%        0%
oracle      0%       0%       0%          0%
placebo     100%     100%     100%        0%
wrong-class lessons injected (on): 3/24 tasks
```

Reading it honestly:
- Headline: repeat-error 100% -> 33% (12/18 repeat tasks fixed), a 67-point absolute delta.
- **That split is a property of my task design, not a forecast.** "Similar" tasks share task words with the lesson by construction (0% repeat), "paraphrase" tasks share almost none (100% repeat). Retrieval with a lexical matcher cannot bridge a paraphrase. Real MIND retrieval is semantic, so it should do better than 0/6 on paraphrases, but this suite cannot say by how much. Treat 67 points as an upper-ish bound for easy repeats and 0 as a lexical floor for hard ones.
- The reflector is scripted. The suite proves the pipeline (trigger -> reflect -> write -> retrieve -> inject -> behavior) and that bad inputs are refused; it does not measure whether a real cheap model writes good lessons. That needs a run against a real model on real transcripts and is not done.
- The student follows a note by keyword match. A real model may ignore, over-apply or misapply a note. Misevolution suggests advisory framing helps only partly.
- 3/24 wrong-class injections (lexical collisions) are real cross-talk the ranking threshold lets through.

Harness audit (the suite refuses to print a trustworthy verdict unless all pass): the mistake is reproducible in session 1 (6/6); off repeats 100%; a placebo note about the wrong class changes nothing (so the student is not reacting to "any note"); an oracle note brings it to 0% (a note can fix it); no run crashed; every written title fits the grammar; writes happen only with learning on.

Safety and robustness checks (10/10 pass): kernel-override lesson refused; email in a lesson refused; public tier never reflects or writes; a `web_fetch` turn never produces a lesson; near-duplicate becomes revision 2 of the same key; a wrong lesson is demoted after 3 corrections, stops being injected and the demotion persists into a new session; 40 matching lessons still produce <= 4 items and <= 2400 chars; MIND down fails open; learning off queries and writes nothing.

Bugs the audit and tests caught while building: JSON-escaped retrieval chunks were not parsed (0 fixed until decoded); the note header's example id matched the id regex and counted as a false injection on every control; demotion was not sticky (later successes un-demoted a lesson).

## 5. Not done / unverified
- No live MIND writes were made and no live read of `Lesson - ` entries beyond one read-only query. `POST /entries`, `/documents`, and `tags` acceptance, and whether the API honors a `supersedes` field (we rely on the body field and tag, not on server support), are UNVERIFIED against live.
- Real-model reflection quality, real semantic retrieval quality, and long-horizon drift (Misevolution saw collapse at round 60 on one run) are unmeasured. A scheduled with/without-learning regression run on real transcripts is the missing control.
- Counters live in memory until session close (one flush, max 6 writes). A crash loses that session's counts.
- Per-user identity: runtime has no user concept yet, so the user model is filed under `MINDCLAW_LEARN_USER`. When auth lands, pass the real username.
- The existing session store persists history, not learning state (pending-outcome, injected keys); a resumed session starts with a clean outcome tracker. The note is excluded from persisted state.
- Skill promotion is write-only in the model's eyes: skills are injected as advice, never executed.
- `review_idle_queue.py` (upstream) not read.
