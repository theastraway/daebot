<!-- ═══════════════════════════════════════════════════════════════════════ -->
<!-- MIND Front Layer Template — PREFERENCE                                       -->
<!-- This file is part of MIND's typed-document architecture (MIND Sense).   -->
<!-- ═══════════════════════════════════════════════════════════════════════ -->

> **For agents reading this template:** This is a PREFERENCE document — one of 16
> typed nouns in MIND's Front Layer. A user-specific taste, often inferred. Softer than POLICY, more specific than USER profile.
>
> **When to create a PREFERENCE document:**
> - A pattern of choice is observed (user consistently picks option A over option B).
> - User expresses a preference verbally without making it a hard rule.
> - A prior PREFERENCE is contradicted by new evidence (supersede).
>
> **Frequency:** Continuous. PREFERENCEs accumulate as the agent learns the user's taste landscape.
>
> **How to store:**
> Call `mind_save_typed` with the type, title, subject, slots, and body filled
> in from the schema below. Do not edit this template — copy it, fill it, store
> the filled copy via the API or MCP tool. The system tags the saved document
> with `type=PREFERENCE` and `source=front-layer-preference` so retrieval can
> filter by type later.
>
> **Always create one of these.** Do not collapse a PREFERENCE-shaped observation
> into a generic note. The whole point of MIND Sense is that asking "show me
> all PREFERENCEs" returns every PREFERENCE the user has accumulated over time, in one
> typed slice.

---

---
type: PREFERENCE
id: <auto>
title: <one sentence — the preference>
subject: <user_id>
created_by: <agent_name>
created_at: <ISO>
updated_at: <ISO>
confidence: <0.0–1.0>
sources: [<observation_doc_ids>]
supersedes: [<contradicted_preference_id>]
expires_at: null
tags: [preference, <domain>]

# Type-specific slots
preference: <what they prefer>
strength: <weak | moderate | strong>
confirmed: <true if user confirmed | false if inferred>
context: <when this preference applies — not all preferences are universal>
---

# Preference: <Title>

## What They Prefer
<One sentence. The preference itself.>

## Strength
<How firm this is. A weak preference can be overridden by other factors. A strong preference is near-policy.>

## Context
<When this preference applies. Time of day, situation, mood. Preferences are often context-bound.>

## Evidence
<What observations or statements support this. Cite doc IDs in `sources`. Mark confirmed if user said it directly; inferred if pattern-derived.>

## Conflicts
<Other preferences this conflicts with. How to resolve when both apply.>
