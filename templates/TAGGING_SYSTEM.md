# Tagging System

Tags are how MIND turns a flat pile of memories into a graph that can be
sliced, filtered, and traversed. Used well, tags double the recall power of
your knowledge graph. Used carelessly, they make retrieval worse.

## The Three Tag Axes

Every memory should carry tags from at least two of these axes. Three is
better. More than six total tags is usually noise.

### 1. Topic — what is this *about*?

The subject matter. Examples:

- `pricing`, `compensation`, `hiring`, `architecture`, `security`,
  `compliance`, `marketing`, `sales`, `outreach`

### 2. Project / Container — *where* does this belong?

The named project, account, or workspace. Examples:

- `MINDapp`, `MINDClaw`, `KGC-2026`, `Atlas`, `Sei`

### 3. Kind — *what shape* is this memory?

The form, not the topic. Examples:

- `decision`, `lesson`, `blocker`, `outcome`, `commitment`, `idea`, `risk`,
  `competitive`, `incident`, `research`

## Naming Conventions

- **lowercase-with-hyphens.** Always. `kgc-2026`, never `KGC_2026`.
- **Singular nouns** for topics: `competitor`, not `competitors`.
- **Project tags use the project's display name lowercased**: `mindapp`,
  `revolut-demo`, `atlas`.
- **Avoid one-off tags.** If you would only ever apply this tag to a single
  memory, it is not a tag — it is a title.

## Front Layer Type as a Tag

When you save a typed document via the front-layer flow, the system applies
two tags automatically: `front-layer` and the lowercased type
(e.g. `belief`, `policy`, `goal`). You do not need to add these by hand. Do
not strip them either — they are how typed retrieval works.

## Source vs. Tag

`source` is not a tag. It is a separate field. Always set it; never abuse
tags as a stand-in. Common sources:

- `mindclaw` — the MINDClaw wrapper itself
- `claude-code` — Claude Code agent runs
- `chief-ai`, `openclaw`, `mcp-agent` — autonomous agent runs
- `web` — captured from the web app
- `mobile` — captured from the mobile app
- `front-layer-<type>` — typed-document saves (set by the system)

## Querying by Tag

`mind_query` accepts a free-form question; the synthesizer uses tags
internally to pick relevant memories. You can also list/filter directly:

- "show me everything tagged `decision` and `mindapp` from the last 30 days"
- "what's tagged `blocker` that hasn't been resolved?"
- "list every `front-layer-policy` in this tenant"

A consistent tagging discipline is what makes those queries return the right
slice instead of a noisy approximation.
