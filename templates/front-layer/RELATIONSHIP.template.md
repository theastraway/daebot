<!-- ═══════════════════════════════════════════════════════════════════════ -->
<!-- MIND Front Layer Template — RELATIONSHIP                                       -->
<!-- This file is part of MIND's typed-document architecture (MIND Sense).   -->
<!-- ═══════════════════════════════════════════════════════════════════════ -->

> **For agents reading this template:** This is a RELATIONSHIP document — one of 16
> typed nouns in MIND's Front Layer. An entity ↔ entity edge with context — family, employer, recurring counterparty.
>
> **When to create a RELATIONSHIP document:**
> - A recurring counterparty is identified in the data (e.g. monthly transfer to a named person).
> - A new named relationship is established (new employer, new landlord, new partner).
> - A relationship's nature changes (e.g. a friend becomes a co-investor — supersede).
>
> **Frequency:** Occasional. RELATIONSHIPs are the long edges of the user's life graph.
>
> **How to store:**
> Call `mind_save_typed` with the type, title, subject, slots, and body filled
> in from the schema below. Do not edit this template — copy it, fill it, store
> the filled copy via the API or MCP tool. The system tags the saved document
> with `type=RELATIONSHIP` and `source=front-layer-relationship` so retrieval can
> filter by type later.
>
> **Always create one of these.** Do not collapse a RELATIONSHIP-shaped observation
> into a generic note. The whole point of MIND Sense is that asking "show me
> all RELATIONSHIPs" returns every RELATIONSHIP the user has accumulated over time, in one
> typed slice.

---

---
type: RELATIONSHIP
id: <auto>
title: <subject + " ↔ " + counterparty>
subject: <user_id>
created_by: <agent_name>
created_at: <ISO>
updated_at: <ISO>
confidence: <0.0–1.0>
sources: [<observation_doc_ids>]
supersedes: [<old_relationship_doc_id>]
expires_at: null
tags: [relationship, <kind>]

# Type-specific slots
counterparty: <name or entity_id of the other party>
kind: <family | friend | colleague | service-provider | employer | landlord | etc>
direction: <bidirectional | subject-to-counterparty | counterparty-to-subject>
established: <ISO date if known>
last_interaction: <ISO>
financial_flow: <none | inbound | outbound | bidirectional>
typical_amount: <if financial>
typical_cadence: <weekly | monthly | irregular | one-time>
---

# Relationship: <subject> ↔ <counterparty>

## Who They Are
<One paragraph on the counterparty as it relates to the subject. Not a profile — a relationship sketch.>

## How They Interact
<What kind of contact, how often, through what channels. Concrete — "calls every Sunday afternoon," not "regularly.">

## Financial Pattern
<If money flows between them: direction, amount, cadence, purpose. Critical for banking-domain agents.>

## Significance
<How important this relationship is to the subject. Affects how the agent handles communication, money flows, alerts.>

## Recent Touchpoints
<Latest interactions, mood, any context the agent should remember next time.>

## Related Behaviors
<BEHAVIORs the agent should run when this counterparty appears in events.>
