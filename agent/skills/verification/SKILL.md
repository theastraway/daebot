---
name: verification
description: The six checks before a change is called done: build, type check, lint, tests, secret grep, diff read; each reported VERIFIED, FAILED or NOT PERFORMED with its receipt.
group: build
triggers: \b(?:verify|verification|is it done|did it work|before (?:the |a )?pr|ready to (?:ship|merge)|run the (?:tests|checks|suite))\b
tools: bash
needs: bash
priority: 20
license: MIT
source: affaan-m/ECC skills/verification-loop/SKILL.md @ d2ef2680, adapted (Daebot tool names, no coverage gate); Copyright (c) 2026 Affaan Mustafa
---
<!-- Adapted from affaan-m/ECC skills/verification-loop/SKILL.md (MIT License, Copyright (c) 2026 Affaan Mustafa). Commands and the report shape changed for Daebot. -->
# Verification

Run this after a feature, a fix or a refactor, and before any pull request. Each phase is a command you run with bash and a result you quote.
Use `set -o pipefail` so a pipe reports the command's exit status and not `tail`'s, and `sed -n '1,30p'` rather than `head` so a successful
tool is not killed by SIGPIPE.

Find the real commands first: read package.json scripts (or the Makefile, pyproject, go.mod equivalent). Do not assume `npm test`.

1. Build. Run the project's build. If it fails, stop here and fix; nothing below means anything on a broken build.
2. Type check. `npx --no-install tsc --noEmit 2>&1 | sed -n '1,30p'` for TypeScript, `pyright .` for Python. Report every error; fix the ones in your diff.
3. Lint. The project's lint command. Warnings in files you touched are yours.
4. Tests. The project's test command at the project's own concurrency (this repo: `node --test --test-concurrency=2`). Quote the summary line: total, passed, failed.
5. Secrets. `git diff | grep -nE 'sk-[A-Za-z0-9_-]{16,}|mind_[A-Za-z0-9]{12,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|api[_-]?key\s*[:=]'` on the diff. Any hit stops the change.
6. Diff read. `git diff` top to bottom, once, looking for: debug output left in, a catch that swallows, a default that hides a missing value, a changed behaviour with no test, scope that was not asked for.

Report, in this shape, with no phase missing:

```
Verification
- build:     VERIFIED | FAILED | NOT PERFORMED  (<command> -> <summary line>)
- types:     ...
- lint:      ...
- tests:     ...  (N passed, M failed)
- secrets:   ...
- diff read: ...  (findings, or "nothing found")
Verdict: PASS | FAIL (<what blocks>)
```

NOT PERFORMED is an honest answer and must say why (no lint script, no network). A phase you did not run is never reported as passed.
