<!-- ═══════════════════════════════════════════════════════════════════════ -->
<!-- MIND Front Layer Template — DECISION                                       -->
<!-- This file is part of MIND's typed-document architecture (MIND Sense).   -->
<!-- ═══════════════════════════════════════════════════════════════════════ -->

> **For agents reading this template:** This is a DECISION document — one of 16
> typed nouns in MIND's Front Layer. A choice made between alternatives, with reasoning and reversibility.
>
> **When to create a DECISION document:**
> - A weighted choice is made (by agent, user, or jointly) where alternatives existed.
> - A prior DECISION is reversed (supersede the prior).
> - A planned decision is deferred — record it as a DECISION with chose='defer' and a review trigger.
>
> **Frequency:** Continuous. Every meaningful choice is a DECISION — append-only audit trail.
>
> **How to store:**
> Call `mind_save_typed` with the type, title, subject, slots, and body filled
> in from the schema below. Do not edit this template — copy it, fill it, store
> the filled copy via the API or MCP tool. The system tags the saved document
> with `type=DECISION` and `source=front-layer-decision` so retrieval can
> filter by type later.
>
> **Always create one of these.** Do not collapse a DECISION-shaped observation
> into a generic note. The whole point of MIND Sense is that asking "show me
> all DECISIONs" returns every DECISION the user has accumulated over time, in one
> typed slice.

---

---
type: DECISION
id: <auto>
title: <one sentence — the decision>
subject: <user_id or domain>
created_by: <agent_name>
created_at: <ISO>
updated_at: <ISO>
confidence: 1.0
sources: [<senses_or_lesson_doc_ids>]
supersedes: [<reversed_decision_id>]
expires_at: null
tags: [decision, <domain>]

# Type-specific slots
chose: <the option taken>
alternatives: [<option_a>, <option_b>, ...]
made_by: <agent | user | joint>
reversible: <true | false>
review_at: <ISO or null>
---

# Decision: <Title>

## What Was Decided
<One sentence. The chosen path.>

## Alternatives Considered
For each alternative:

### <Alternative>
- **Pros:** <list>
- **Cons:** <list>
- **Why not chosen:** <one sentence>

## Reasoning
<The actual argument. Not "because it was best" — the specific reasoning that tipped the choice.>

## Who Decided
<Agent, user, or both. If user — what they said verbatim.>

## Reversibility
<If reversing this is possible, how. If not, what is locked in.>

## Review Trigger
<When this decision should be re-examined. A date, a metric, a counter-event.>
