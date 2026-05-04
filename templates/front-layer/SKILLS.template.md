<!-- ═══════════════════════════════════════════════════════════════════════ -->
<!-- MIND Front Layer Template — SKILLS                                       -->
<!-- This file is part of MIND's typed-document architecture (MIND Sense).   -->
<!-- ═══════════════════════════════════════════════════════════════════════ -->

> **For agents reading this template:** This is a SKILLS document — one of 16
> typed nouns in MIND's Front Layer. Repeatable task templates and how-to guides the agent has learned.
>
> **When to create a SKILLS document:**
> - A new task pattern proves repeatable (succeeded ≥3 times across ≥2 sessions).
> - User explicitly teaches a skill ('do X like this').
> - A WORKFLOW is decomposed and one of its steps becomes a reusable skill.
>
> **Frequency:** Continuous as skills accumulate over the agent's lifetime.
>
> **How to store:**
> Call `mind_save_typed` with the type, title, subject, slots, and body filled
> in from the schema below. Do not edit this template — copy it, fill it, store
> the filled copy via the API or MCP tool. The system tags the saved document
> with `type=SKILLS` and `source=front-layer-skills` so retrieval can
> filter by type later.
>
> **Always create one of these.** Do not collapse a SKILLS-shaped observation
> into a generic note. The whole point of MIND Sense is that asking "show me
> all SKILLSs" returns every SKILLS the user has accumulated over time, in one
> typed slice.

---

---
type: SKILLS
id: <auto>
title: <skill name>
subject: agent_self
created_by: <agent_name>
created_at: <ISO>
updated_at: <ISO>
confidence: <0.0–1.0>
sources: [<observation_doc_ids>]
supersedes: [<prior_version_id>]
expires_at: null
tags: [skill, how-to]

# Type-specific slots
skill_name: <short identifier>
trigger_phrases: [<phrase>, ...]
inputs_required: [<input>, ...]
outputs_produced: [<output>, ...]
estimated_duration: <e.g., "30 seconds", "2 minutes">
---

# Skill: <skill_name>

## Purpose
<One sentence — what this skill accomplishes.>

## When To Use This
<Specific triggers. Trigger phrases, situations, upstream events.>

## Steps
1. <Concrete step>
2. <Concrete step>
3. <Concrete step>

## Inputs
<What I need before I can run this skill.>

## Outputs
<What I produce. Where it goes.>

## Failure Modes
<What goes wrong, how I recover.>

## Related Skills
<Skills that pair with this one, or supersede it in specific cases.>
