# Bundled skills

A skill is a `SKILL.md` under `skills/<name>/`: data, not code. The loader (`src/skills/index.ts`) reads every one at start, refuses a body that
carries a secret or tries to override the kernel, and hands the system prompt the full text of a skill only on turns that are about it
(its focus group, its own `triggers`, a tool it names used in the last rounds, or the user naming it). Every other turn carries one index line.

Frontmatter keys: `name` (slug), `description` (one line, the index text), `group` (a focus group from `src/focus.ts`, default the skill's own
name), `triggers` (a case-insensitive regular expression on the message), `tools` (tool names whose recent use loads the skill), `needs` (the
skill is offered only when the session has one of these tools), `priority` (lower loads first and wins the per-turn budget, default 50),
`license` and `source` (provenance). An operator adds a directory of extra skills with `DAEBOT_SKILLS_DIR`; a same-named skill there replaces the bundled one.

Borrowed skills keep their copyright line as the first line of the body and have a row in `THIRD-PARTY-NOTICES.md` (SPEC section 7).
