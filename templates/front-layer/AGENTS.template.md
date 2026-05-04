<!-- ═══════════════════════════════════════════════════════════════════════ -->
<!-- MIND Front Layer Template — AGENTS                                       -->
<!-- This file is part of MIND's typed-document architecture (MIND Sense).   -->
<!-- ═══════════════════════════════════════════════════════════════════════ -->

> **For agents reading this template:** This is a AGENTS document — one of 16
> typed nouns in MIND's Front Layer. The roster of other agents in the network, handoff edges, escalation chain.
>
> **When to create a AGENTS document:**
> - A new agent joins the network the agent collaborates with.
> - A handoff rule is established or changed.
> - Escalation path changes.
>
> **Frequency:** Occasional, as the multi-agent topology evolves.
>
> **How to store:**
> Call `mind_save_typed` with the type, title, subject, slots, and body filled
> in from the schema below. Do not edit this template — copy it, fill it, store
> the filled copy via the API or MCP tool. The system tags the saved document
> with `type=AGENTS` and `source=front-layer-agents` so retrieval can
> filter by type later.
>
> **Always create one of these.** Do not collapse a AGENTS-shaped observation
> into a generic note. The whole point of MIND Sense is that asking "show me
> all AGENTSs" returns every AGENTS the user has accumulated over time, in one
> typed slice.

---

---
type: AGENTS
id: <auto>
title: <network name + " — Agent Roster">
subject: agent_network
created_by: <agent_name>
created_at: <ISO>
updated_at: <ISO>
confidence: 1.0
sources: []
supersedes: []
expires_at: null
tags: [network, agents, topology]

# Type-specific slots
roster: [<agent_name>, ...]
handoffs: [<from> -> <to> on <trigger>, ...]
escalation_chain: [<agent>, ..., <human>]
---

# Agent Network

## Roster
For each agent in the network:

### <Agent Name>
- **Role:** <one phrase>
- **Home:** <where it runs>
- **Reaches me via:** <channel>
- **I reach it via:** <channel>
- **Strengths:** <what to delegate to it>
- **Limits:** <what not to delegate>

## Handoffs
<Explicit triggers. "When the user asks about X, hand to <agent>." "When <condition>, escalate to <agent>." Be specific — vague handoffs cause loops.>

## Escalation Chain
<Final fallback path. Agent → agent → human. Who answers when nobody else can.>
