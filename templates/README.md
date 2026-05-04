# MINDClaw Bundled Templates

Two kinds of templates ship with MINDClaw:

- **`HOW_TO_*.md` and `TAGGING_SYSTEM.md`** — the operating manual. These
  describe how an agent should think, remember, and tag when its memory layer
  is MIND. Seeded into your knowledge graph as `document` type so any agent
  can ask "how should I tag this?" and get the answer from MIND itself.
- **`front-layer/*.template.md`** — the 16 canonical typed-document templates
  (SOUL, IDENTITY, BELIEFS, USER, AGENTS, TOOLS, SENSES, SKILLS, BEHAVIOR,
  LESSON, DECISION, POLICY, WORKFLOW, PREFERENCE, GOAL, RELATIONSHIP).
  Seeded as typed `front-layer-<type>` documents. Once seeded, an agent that
  asks "show me the spec for a BELIEFS document" can pull it from the user's
  own KG without round-tripping to a server.

## Seeding

Run automatically on `mindclaw init`. To re-seed after changes, run:

```bash
mindclaw seed-templates
```

The seed call is idempotent at the document-type level — re-running creates
fresh copies and the most recent version wins on retrieval. To prune older
copies, use the MIND web app or `mind_remember` with `action=delete`.

## Customizing

You can edit any of these markdown files locally before seeding. The CLI
reads them from this directory at run time. To override per-user, copy to
`~/.mindclaw/templates/` — the wrapper prefers the user copy when present.
