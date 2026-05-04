<!-- ═══════════════════════════════════════════════════════════════════════ -->
<!-- MIND Front Layer Template — WORKFLOW                                       -->
<!-- This file is part of MIND's typed-document architecture (MIND Sense).   -->
<!-- ═══════════════════════════════════════════════════════════════════════ -->

> **For agents reading this template:** This is a WORKFLOW document — one of 16
> typed nouns in MIND's Front Layer. A versioned multi-step process the agent (or user) executes to accomplish a recurring task.
>
> **When to create a WORKFLOW document:**
> - A repeatable multi-step process is identified (monthly close, quarterly review, weekly summary).
> - A workflow's steps change — supersede the prior version.
> - User describes a SOP and asks the agent to follow it.
>
> **Frequency:** Occasional. WORKFLOWs are versioned — most updates supersede a prior version.
>
> **How to store:**
> Call `mind_save_typed` with the type, title, subject, slots, and body filled
> in from the schema below. Do not edit this template — copy it, fill it, store
> the filled copy via the API or MCP tool. The system tags the saved document
> with `type=WORKFLOW` and `source=front-layer-workflow` so retrieval can
> filter by type later.
>
> **Always create one of these.** Do not collapse a WORKFLOW-shaped observation
> into a generic note. The whole point of MIND Sense is that asking "show me
> all WORKFLOWs" returns every WORKFLOW the user has accumulated over time, in one
> typed slice.

---

---
type: WORKFLOW
id: <auto>
title: <short name — "Monthly budget close">
subject: <user_id or domain>
created_by: <agent_name>
created_at: <ISO>
updated_at: <ISO>
confidence: <0.0–1.0>
sources: [<observation_doc_ids>]
supersedes: [<prior_workflow_version_id>]
expires_at: null
tags: [workflow, sop, <domain>]

# Type-specific slots
version: <semver — 1.0.0>
trigger: <what kicks this off>
estimated_duration: <e.g., "5 minutes">
owners: [<agent_or_human_role>, ...]
dependencies: [<workflow_id or doc_id>, ...]
---

# Workflow: <Title>

## Trigger
<What starts this workflow. Cron, event, manual invocation.>

## Steps

### 1. <Step name>
- **Owner:** <who runs this>
- **Inputs:** <what's needed>
- **Action:** <what happens>
- **Output:** <what's produced>
- **Failure:** <what to do if it fails>

### 2. <Step name>
…

## Success Criteria
<How we know the workflow completed correctly. Measurable.>

## Failure Modes
<What goes wrong, who is alerted, what the rollback looks like.>

## Version Notes
<What changed in this version vs. the prior. Link the supersedes ID.>
