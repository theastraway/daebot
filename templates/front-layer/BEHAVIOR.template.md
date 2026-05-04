<!-- ═══════════════════════════════════════════════════════════════════════ -->
<!-- MIND Front Layer Template — BEHAVIOR                                       -->
<!-- This file is part of MIND's typed-document architecture (MIND Sense).   -->
<!-- ═══════════════════════════════════════════════════════════════════════ -->

> **For agents reading this template:** This is a BEHAVIOR document — one of 16
> typed nouns in MIND's Front Layer. A situational action rule — 'when X, do Y' — born from LESSONs and constrained by POLICY.
>
> **When to create a BEHAVIOR document:**
> - A LESSON crosses confidence ≥0.7 and suggests a repeatable action.
> - User states a contingent rule ('whenever this happens, do that').
> - An existing BEHAVIOR is refined (supersede the prior).
>
> **Frequency:** Frequent. Behaviors accumulate as the agent learns the user's situational patterns.
>
> **How to store:**
> Call `mind_save_typed` with the type, title, subject, slots, and body filled
> in from the schema below. Do not edit this template — copy it, fill it, store
> the filled copy via the API or MCP tool. The system tags the saved document
> with `type=BEHAVIOR` and `source=front-layer-behavior` so retrieval can
> filter by type later.
>
> **Always create one of these.** Do not collapse a BEHAVIOR-shaped observation
> into a generic note. The whole point of MIND Sense is that asking "show me
> all BEHAVIORs" returns every BEHAVIOR the user has accumulated over time, in one
> typed slice.

---

---
type: BEHAVIOR
id: <auto>
title: <short imperative — "Flag unused subscriptions over 60 days">
subject: <user_id or "agent_self">
created_by: <agent_name>
created_at: <ISO>
updated_at: <ISO>
confidence: <0.0–1.0>
sources: [<lesson_doc_ids that birthed this>]
supersedes: [<old_behavior_doc_id>]
expires_at: <ISO or null>
tags: [behavior, <domain>]

# Type-specific slots
trigger: <when this behavior fires — be specific and machine-checkable>
action: <what to do when triggered>
exceptions: [<situation where behavior should NOT fire>, ...]
priority: <low | normal | high>
override_by: [POLICY]      # POLICY always wins
---

# Behavior: <Title>

## Trigger
<Concrete condition. "Subscription line item with last_use_date > 60 days ago AND amount > £5/month." Avoid vague language.>

## Action
<What to do. Step-by-step if multi-stage. Include who is notified, what is logged, what is changed.>

## Exceptions
<Numbered list. Each exception is a specific situation where this behavior must not fire even if the trigger matches.>

## Why This Exists
<Source LESSONs that birthed this behavior. Reference doc IDs in `sources`. One sentence on the pattern observed.>

## Supersedes
<If this replaces a prior behavior, link it in `supersedes` and explain the change in one line.>
