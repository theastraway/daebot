<!-- ═══════════════════════════════════════════════════════════════════════ -->
<!-- MIND Front Layer Template — GOAL                                       -->
<!-- This file is part of MIND's typed-document architecture (MIND Sense).   -->
<!-- ═══════════════════════════════════════════════════════════════════════ -->

> **For agents reading this template:** This is a GOAL document — one of 16
> typed nouns in MIND's Front Layer. A target state with milestones and a deadline — the user's stated aspirations.
>
> **When to create a GOAL document:**
> - User states an aspiration with a measurable target ('I want £5,000 saved by year-end').
> - A goal is achieved, abandoned, or restated (supersede or mark status).
> - A milestone is reached or missed and the goal needs updating.
>
> **Frequency:** Periodic. One GOAL per stated aspiration; updated through milestones rather than recreated.
>
> **How to store:**
> Call `mind_save_typed` with the type, title, subject, slots, and body filled
> in from the schema below. Do not edit this template — copy it, fill it, store
> the filled copy via the API or MCP tool. The system tags the saved document
> with `type=GOAL` and `source=front-layer-goal` so retrieval can
> filter by type later.
>
> **Always create one of these.** Do not collapse a GOAL-shaped observation
> into a generic note. The whole point of MIND Sense is that asking "show me
> all GOALs" returns every GOAL the user has accumulated over time, in one
> typed slice.

---

---
type: GOAL
id: <auto>
title: <short name — "Build £5,000 emergency fund">
subject: <user_id>
created_by: <user_or_agent>
created_at: <ISO>
updated_at: <ISO>
confidence: 1.0
sources: [<conversation_or_decision_doc_ids>]
supersedes: [<replaced_goal_id>]
expires_at: <target_date_ISO>
tags: [goal, <domain>]

# Type-specific slots
target_state: <what "done" looks like — measurable>
current_state: <where we are now>
deadline: <ISO>
priority: <low | normal | high | top>
status: <active | paused | achieved | abandoned>
milestones: [<milestone>, ...]
related_behaviors: [<behavior_doc_ids that serve this goal>]
---

# Goal: <Title>

## Target State
<What "achieved" means. Concrete and measurable. "£5,000 in the Revolut savings vault by Dec 31 2026.">

## Current State
<Where we are right now. Refresh on each review.>

## Why This Matters
<The reason behind the goal. Not optional — without this, the agent can't make tradeoffs when goals conflict.>

## Milestones
For each milestone:

### <Milestone — by when>
- **Target:** <number or state>
- **Status:** <not started | on track | at risk | hit>
- **Notes:** <any relevant context>

## Behaviors That Serve This
<Link BEHAVIOR doc IDs that exist to advance this goal. Goal-aligned behaviors get priority when behaviors conflict.>

## Review Cadence
<How often to revisit. Weekly, monthly, quarterly. Set a reminder.>
