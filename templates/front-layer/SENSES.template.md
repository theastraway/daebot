<!-- ═══════════════════════════════════════════════════════════════════════ -->
<!-- MIND Front Layer Template — SENSES                                       -->
<!-- This file is part of MIND's typed-document architecture (MIND Sense).   -->
<!-- ═══════════════════════════════════════════════════════════════════════ -->

> **For agents reading this template:** This is a SENSES document — one of 16
> typed nouns in MIND's Front Layer. Input streams the agent perceives — transaction feed, calendar, location, etc.
>
> **When to create a SENSES document:**
> - A new input stream is wired.
> - A stream's schema or cadence changes.
> - An awareness gap is identified worth recording.
>
> **Frequency:** On stream changes. Code-generated where possible.
>
> **How to store:**
> Call `mind_save_typed` with the type, title, subject, slots, and body filled
> in from the schema below. Do not edit this template — copy it, fill it, store
> the filled copy via the API or MCP tool. The system tags the saved document
> with `type=SENSES` and `source=front-layer-senses` so retrieval can
> filter by type later.
>
> **Always create one of these.** Do not collapse a SENSES-shaped observation
> into a generic note. The whole point of MIND Sense is that asking "show me
> all SENSESs" returns every SENSES the user has accumulated over time, in one
> typed slice.

---

---
type: SENSES
id: <auto>
title: <agent name + " — Senses">
subject: agent_self
created_by: <code_generator>
created_at: <ISO>
updated_at: <ISO>
confidence: 1.0
sources: []
supersedes: [<prior_senses_doc>]
expires_at: null
tags: [perception, inputs, awareness]

# Type-specific slots
streams: [<stream_name>, ...]
polling_intervals: <object: stream -> interval>
last_event_seen: <object: stream -> ISO>
---

# Senses

For each input stream I perceive:

### <stream_name>
- **Source:** <where the data comes from>
- **Cadence:** <real-time | every N min | on-event>
- **Schema:** <one-line description of payload shape>
- **What it tells me:** <what I can learn from this>
- **Latency:** <how fresh the data is>
- **When it goes silent:** <what silence means and how to react>

## Cross-Stream Correlation

<How streams combine. Example: "A calendar event + a location ping at the same place = the user is at the meeting.">

## Awareness Gaps

<What I cannot see. Be honest. Knowing the gaps is part of perception.>
