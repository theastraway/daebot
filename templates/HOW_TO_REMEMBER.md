# How to Remember with MIND

A memory in MIND is not a paragraph of text. It is a node in your knowledge
graph, surrounded by relationships, weighted by emotional signal, scoped to a
source. The way you write it determines whether future-you can find it.

## Anatomy of a Good Memory

A good memory has:

- **A clear title.** The title is what your future self will skim. Lead with
  the noun: "Decision: switched provider X to Y" beats "Notes from Tuesday."
- **A short body.** One screenful at most. If it needs more, it is a
  `document`, not an `entry`.
- **Tags.** Use 2–6 tags. Tags should describe the topic (`pricing`,
  `outreach`), the project (`MINDapp`, `KGC-2026`), and the kind (`decision`,
  `lesson`, `blocker`). Avoid one-off tags that will never repeat.
- **A `source`.** Who is writing this? `mindclaw`, `claude-code`, `chief-ai`,
  `mcp-agent`. Future agents filter by source to disambiguate.

## What Belongs in MIND

Store, with confidence:

- Decisions you made and why
- Outcomes you observed and what surprised you
- People and how you know them
- Tasks, goals, and milestones
- Lessons you do not want to learn twice
- Strategic context — competitor intel, market data, investor feedback
- Anything the user says they care about

Do **not** store:

- Code that already lives in a repo (the repo is authoritative)
- Git history (`git log` is authoritative)
- Conversational filler with no decision or outcome
- Credentials, API keys, secrets — ever

## Use the Right Store

- **`document`** — for things meant to persist for months. Strategies, specs,
  research write-ups, postmortems.
- **`entry`** — for things that matter for weeks. Findings, session summaries,
  action logs, observations.
- **`thought`** — for things that matter for hours. One-liners, reminders,
  fleeting ideas you want surfaced later if they recur.
- **Typed `front-layer-<TYPE>`** — for the 16 canonical nouns. Always use the
  typed save flow for these, not raw `mind_remember`. The type tag is what
  lets future queries return "show me every BELIEFS document" cleanly.

## Updating, Not Duplicating

If a memory becomes stale, do not write a new one and leave the old one
floating. Either:

- Update it in place if the change is small (a corrected detail, a refined
  decision), or
- Write a new one with `supersedes: [<old-id>]` in its frontmatter, and treat
  the old one as historical.

Stale duplicates poison retrieval.
