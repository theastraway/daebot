<!-- ═══════════════════════════════════════════════════════════════════════ -->
<!-- MIND Front Layer Template — LESSON                                       -->
<!-- This file is part of MIND's typed-document architecture (MIND Sense).   -->
<!-- ═══════════════════════════════════════════════════════════════════════ -->

> **For agents reading this template:** This is a LESSON document — one of 16
> typed nouns in MIND's Front Layer. A learned pattern from observed events — the raw material BEHAVIORs are made of.
>
> **When to create a LESSON document:**
> - Three or more similar events are observed and a generalization becomes credible.
> - A counter-example forces an existing lesson to be refined (supersede).
> - User states 'I learned that X' or equivalent reflective statement.
>
> **Frequency:** Continuous. LESSONs are the bread and butter of MIND Sense — they accumulate forever.
>
> **How to store:**
> Call `mind_save_typed` with the type, title, subject, slots, and body filled
> in from the schema below. Do not edit this template — copy it, fill it, store
> the filled copy via the API or MCP tool. The system tags the saved document
> with `type=LESSON` and `source=front-layer-lesson` so retrieval can
> filter by type later.
>
> **Always create one of these.** Do not collapse a LESSON-shaped observation
> into a generic note. The whole point of MIND Sense is that asking "show me
> all LESSONs" returns every LESSON the user has accumulated over time, in one
> typed slice.

---

---
type: LESSON
id: <auto>
title: <one sentence — the lesson itself>
subject: <user_id or "agent_self" or domain>
created_by: <agent_name>
created_at: <ISO>
updated_at: <ISO>
confidence: <0.0–1.0>
sources: [<senses_event_ids or other observation doc_ids>]
supersedes: [<contradicted_lesson_id>]
expires_at: null
tags: [lesson, <domain>]

# Type-specific slots
observation: <what was observed — the raw pattern>
generalization: <what we now believe is true>
sample_size: <how many events support this>
counter_examples: [<event_id>, ...]
---

# Lesson: <Title>

## Observation
<The pattern as observed. "Across 4 of the last 5 months, Pavel cancelled subscriptions within 2 weeks of crossing 60 days unused.">

## Generalization
<The lesson distilled. "Pavel reliably cancels subscriptions after ~60 days of non-use.">

## Confidence
<Why this confidence level. What would raise it. What would lower it.>

## Counter-Examples
<Cases where the pattern did NOT hold. Each counter-example is a chance to refine the generalization.>

## Spawned Behaviors
<List BEHAVIOR doc IDs that were born from this lesson. Forward link.>
