<!-- ═══════════════════════════════════════════════════════════════════════ -->
<!-- MIND Front Layer Template — POLICY                                       -->
<!-- This file is part of MIND's typed-document architecture (MIND Sense).   -->
<!-- ═══════════════════════════════════════════════════════════════════════ -->

> **For agents reading this template:** This is a POLICY document — one of 16
> typed nouns in MIND's Front Layer. A hard rule set by the user that overrides any conflicting BEHAVIOR.
>
> **When to create a POLICY document:**
> - User states 'never do X', 'always do X', or sets a clear constraint.
> - A regulatory or compliance requirement is established.
> - An existing POLICY is tightened or loosened (supersede).
>
> **Frequency:** Rare. POLICY is the smallest-volume, highest-authority type — treat each one with care.
>
> **How to store:**
> Call `mind_save_typed` with the type, title, subject, slots, and body filled
> in from the schema below. Do not edit this template — copy it, fill it, store
> the filled copy via the API or MCP tool. The system tags the saved document
> with `type=POLICY` and `source=front-layer-policy` so retrieval can
> filter by type later.
>
> **Always create one of these.** Do not collapse a POLICY-shaped observation
> into a generic note. The whole point of MIND Sense is that asking "show me
> all POLICYs" returns every POLICY the user has accumulated over time, in one
> typed slice.

---

---
type: POLICY
id: <auto>
title: <imperative — "Never auto-spend more than £100 without confirmation">
subject: <user_id or "agent_self">
created_by: <user_or_agent_name>
created_at: <ISO>
updated_at: <ISO>
confidence: 1.0
sources: [<conversation_doc_id where user set this>]
supersedes: [<weakened_policy_id>]
expires_at: null
tags: [policy, governance, <domain>]

# Type-specific slots
constraint: <the hard rule>
scope: <where this applies>
override_required: <who must approve to break this — usually "user_explicit_confirmation">
overrides: [<behavior_doc_ids this policy supersedes>]
set_by: <user | regulatory | agent>
---

# Policy: <Title>

## The Rule
<One sentence. Crisp. No nuance.>

## Scope
<Where this applies. "All transactions on Revolut accounts." "All outbound messages." Not vague — concrete boundaries.>

## What Triggers Override
<The only conditions under which this policy can be bypassed. Usually: explicit user confirmation in-session. Sometimes: regulatory carve-out, emergency.>

## What This Supersedes
<List the BEHAVIOR docs this policy overrides. Behaviors that conflict are subordinated, not deleted.>

## Why It Exists
<The reason. Often a past incident, a regulatory requirement, a user preference made firm. Reference source doc.>

## How To Verify Compliance
<How an auditor or the agent itself can check that this policy is being honored.>
