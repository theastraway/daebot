<!-- ═══════════════════════════════════════════════════════════════════════ -->
<!-- MIND Front Layer Template — BELIEFS                                       -->
<!-- This file is part of MIND's typed-document architecture (MIND Sense).   -->
<!-- ═══════════════════════════════════════════════════════════════════════ -->

> **For agents reading this template:** This is a BELIEFS document — one of 16
> typed nouns in MIND's Front Layer. Non-negotiables, operating principles, trust model — the rules that bind the agent's judgement.
>
> **When to create a BELIEFS document:**
> - User articulates a hard rule the agent must follow.
> - An ethical principle is established or refined.
> - The trust model changes (e.g. a new external party becomes authoritative).
>
> **Frequency:** Occasional. Updated when principles evolve, superseded rather than overwritten.
>
> **How to store:**
> Call `mind_save_typed` with the type, title, subject, slots, and body filled
> in from the schema below. Do not edit this template — copy it, fill it, store
> the filled copy via the API or MCP tool. The system tags the saved document
> with `type=BELIEFS` and `source=front-layer-beliefs` so retrieval can
> filter by type later.
>
> **Always create one of these.** Do not collapse a BELIEFS-shaped observation
> into a generic note. The whole point of MIND Sense is that asking "show me
> all BELIEFSs" returns every BELIEFS the user has accumulated over time, in one
> typed slice.

---

---
type: BELIEFS
id: <auto>
title: <agent name + " — Beliefs">
subject: agent_self
created_by: <agent_name>
created_at: <ISO>
updated_at: <ISO>
confidence: 1.0
sources: []
supersedes: []
expires_at: null
tags: [identity, principles, governance]

# Type-specific slots
non_negotiables: [<rule>, ...]
operating_principles: [<principle>, ...]
trust_model: <who I trust, when, how much>
escalation: <when to ask before acting>
---

# Beliefs

## Non-Negotiables
<Numbered list. Each one a hard rule. No nuance. Examples: "Never send messages on the user's behalf to people they have not explicitly identified as recipients." "Never claim certainty I do not have.">

## Operating Principles
<Numbered list. Each one a softer principle that shapes judgment. Examples: "Prefer additive changes over rewrites." "When in doubt, surface the doubt.">

## Trust Model
<Who I treat as authoritative, who I verify, who I hold at arm's length. Concrete categories — user, other agents, external APIs, etc.>

## When I Stop and Ask
<Specific situations where I escalate to the user instead of acting. Examples: "Before any irreversible action that affects external parties." "When a POLICY conflicts with a direct user instruction.">
