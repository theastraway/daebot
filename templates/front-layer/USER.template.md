<!-- ═══════════════════════════════════════════════════════════════════════ -->
<!-- MIND Front Layer Template — USER                                       -->
<!-- This file is part of MIND's typed-document architecture (MIND Sense).   -->
<!-- ═══════════════════════════════════════════════════════════════════════ -->

> **For agents reading this template:** This is a USER document — one of 16
> typed nouns in MIND's Front Layer. Who the user is — profile, communication style, observed patterns. The agent's understanding of its human.
>
> **When to create a USER document:**
> - Bootstrap — first conversation with a new user.
> - A meaningful refinement to what the agent knows about the user (preferred name, schedule shift, role change).
> - An inferred trait reaches high enough confidence to be promoted from PREFERENCE to USER profile.
>
> **Frequency:** Periodic. The current USER doc supersedes the prior; older versions remain for audit.
>
> **How to store:**
> Call `mind_save_typed` with the type, title, subject, slots, and body filled
> in from the schema below. Do not edit this template — copy it, fill it, store
> the filled copy via the API or MCP tool. The system tags the saved document
> with `type=USER` and `source=front-layer-user` so retrieval can
> filter by type later.
>
> **Always create one of these.** Do not collapse a USER-shaped observation
> into a generic note. The whole point of MIND Sense is that asking "show me
> all USERs" returns every USER the user has accumulated over time, in one
> typed slice.

---

---
type: USER
id: <auto>
title: <user's name>
subject: <user_id>
created_by: <agent_name>
created_at: <ISO>
updated_at: <ISO>
confidence: <0.0–1.0>
sources: [<observation_doc_ids>]
supersedes: []
expires_at: null
tags: [user, profile]

# Type-specific slots
display_name: <preferred name>
full_name: <legal name if relevant>
pronouns: <they/them | she/her | he/him>
timezone: <IANA tz>
locale: <language + region>
communication_style: <terse | detailed | formal | playful>
preferred_channels: [<channel>, ...]
do_not_contact_via: [<channel>, ...]
---

# User Profile

## Who They Are
<2-3 sentences. Role, what they care about, the texture of who they are. Not a LinkedIn bio — what an attentive friend would say.>

## How They Communicate
<Style, register, pace. What gets through. What does not. Examples of phrasing they respond to.>

## Their Day
<Rhythm, peak hours, when not to interrupt. Time zone matters here.>

## What They Want From Me
<Their stated preferences for the assistant. Concrete, not aspirational.>

## What I Have Observed (vs. been told)
<Inferred patterns. Mark each with confidence. These are hypotheses until confirmed.>
