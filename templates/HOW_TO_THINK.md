# How to Think with MIND

This file is bundled with MINDClaw and seeded into your MIND knowledge graph
on first run. It is the operating manual that tells an agent how to think when
its memory layer is MIND.

## The Loop

Every non-trivial task follows the same six-step loop:

1. **Load context** — call `mind_context` at the start of every session to read
   identity, user preferences, operating rules, current priorities, and the
   last few days of activity. Without this, you are flying blind.
2. **Query before asserting** — before claiming "X doesn't exist" or "we never
   decided that," call `mind_query` on the specific topic. Local files are not
   authoritative for cross-conversation history. MIND is.
3. **Read the code, not just the memory** — when MIND and the live codebase
   appear to disagree, treat MIND as a snapshot in time. Verify against the
   current files, then update the stale source. Never silently pick one.
4. **Do the work** — root causes only. Workarounds leave scars.
5. **Verify before claiming done** — screenshots beat assumptions, test output
   beats wishful thinking. A passing test is necessary, not sufficient.
6. **Remember the outcome** — after anything non-trivial, call `mind_remember`
   with what worked, what didn't, and what you'd do differently. Tag it.
   Unlogged work is invisible to future sessions.

## When to Use Each Storage Type

| Type        | Use it for                                                     |
|-------------|----------------------------------------------------------------|
| `document`  | Long-form structured content — strategies, specs, research     |
| `entry`     | Medium observations, findings, action logs, session summaries  |
| `thought`   | Quick fleeting ideas, one-liners, reminders                    |
| `front-layer-<TYPE>` | Typed nouns: SOUL, IDENTITY, BELIEFS, USER, BEHAVIOR, LESSON, POLICY, GOAL, etc. Use the typed save flow, not raw `mind_remember`. |

## Storage Triage — The Five Gates

Before writing a memory, run the **memory-triage** gate. Most agent turns
should produce zero memory operations. That is correct. Only store when the
candidate fact passes all five:

1. **Future utility** — will this matter in a future conversation?
2. **Novelty** — is this new information, not a restatement?
3. **Factual** — is it grounded in something said or observed, not invented?
4. **Safe** — does it contain no credentials, secrets, or PII the user wouldn't
   want surfaced later?
5. **Emotional salience** — does it carry signal (a decision, a frustration, a
   commitment, a strong preference)? Pure neutral chitchat doesn't need to be
   stored.

## How to Read MIND Output

`mind_query` returns an AI-synthesized answer plus references. Treat the
answer as a hypothesis. Walk the references when the stakes are high enough
that being wrong matters. Cite the reference IDs in your response so the user
can audit the memory chain.

## Cross-Agent Etiquette

When multiple agents read and write the same MIND tenant, every write is
visible to every other agent. Two consequences:

- Always set a meaningful `source` on writes (e.g. `mindclaw`, `claude-code`,
  `chief-ai`). Source is the only thing that lets future agents distinguish
  who said what.
- Don't rewrite another agent's memory just because you'd phrase it
  differently. Add a new entry that supersedes if needed; don't silently
  overwrite history.
