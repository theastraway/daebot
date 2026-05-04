<!-- ═══════════════════════════════════════════════════════════════════════ -->
<!-- MIND Front Layer Template — TOOLS                                       -->
<!-- This file is part of MIND's typed-document architecture (MIND Sense).   -->
<!-- ═══════════════════════════════════════════════════════════════════════ -->

> **For agents reading this template:** This is a TOOLS document — one of 16
> typed nouns in MIND's Front Layer. The APIs and capabilities the agent can call, with auth scopes and failure modes.
>
> **When to create a TOOLS document:**
> - A new tool is wired to the agent's runtime.
> - Auth scope or rate limits change.
> - A tool is removed or deprecated.
>
> **Frequency:** On every tool sync. Code-generated, not hand-edited.
>
> **How to store:**
> Call `mind_save_typed` with the type, title, subject, slots, and body filled
> in from the schema below. Do not edit this template — copy it, fill it, store
> the filled copy via the API or MCP tool. The system tags the saved document
> with `type=TOOLS` and `source=front-layer-tools` so retrieval can
> filter by type later.
>
> **Always create one of these.** Do not collapse a TOOLS-shaped observation
> into a generic note. The whole point of MIND Sense is that asking "show me
> all TOOLSs" returns every TOOLS the user has accumulated over time, in one
> typed slice.

---

---
type: TOOLS
id: <auto>
title: <agent name + " — Tools">
subject: agent_self
created_by: <code_generator>
created_at: <ISO>
updated_at: <ISO>
confidence: 1.0
sources: []
supersedes: [<prior_tools_doc>]
expires_at: null
tags: [capabilities, tools, apis]

# Type-specific slots
tools: [<tool_name>, ...]
auth_scopes: [<scope>, ...]
rate_limits: <object describing limits>
last_synced: <ISO>
---

# Tools

For each tool I can call:

### <tool_name>
- **What it does:** <one phrase>
- **When to use:** <triggers — be specific>
- **When not to use:** <anti-triggers>
- **Cost / latency:** <if relevant>
- **Auth scope:** <what it can access>
- **Failure mode:** <what to do when it errors>

## Tool Boundaries

<Categories of action that require user confirmation regardless of tool capability. Examples: "Sending external messages" "Moving money" "Modifying production infrastructure".>

## Tool Sync

This document is regenerated on every tool sync. Do not hand-edit slots — edit the sync source instead.
