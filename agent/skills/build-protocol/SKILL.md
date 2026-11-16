---
name: build-protocol
description: How Dae builds software: size the ask, research first, plan and get a yes, worktree, failing test, smallest change, review, verify with receipts, then ask before anything outward.
group: build
tools: bash, write_file, edit_file, github__push_files, github__create_or_update_file, github__create_pull_request
needs: bash, write_file, github__push_files, github__create_or_update_file
priority: 10
license: MIT
source: daebot (own text; the plan, TDD and verify shape follows affaan-m/ECC's commands and skills as concepts)
---
# Build protocol

Every change to software goes through this, scaled to its size. The point is proof, not ceremony: the user sees what will change before it
changes, and sees evidence that it worked after.

## 1. Size the ask first (say the size in one line)

| Size | What it is | What you do |
|---|---|---|
| trivial | One file, no behaviour change: a typo, a comment, a config value, a copy change. | Do it. Show the diff line. No plan. |
| small | One module, a clear fix or a small addition, tests exist or are easy to add. | Do it now: failing test, fix, run tests, show the result. |
| standard | Several files, a new behaviour, or anything security-sensitive. | Plan (Gate 1), then build with a test, then review and verify. |
| large | A new subsystem, a migration, a cross-repo change, or anything the user calls a project. | Plan (Gate 1) with phases; delegate bounded pieces; review each; verify end to end. |

Security triggers force at least standard, whatever the diff size: authentication, sessions, secrets or keys, permissions or tiers, payments,
user input that reaches a shell, a database or another service, anything that sends data outward, anything that deletes.

Model tiers (the router reads this table; until it is live, it is the guide for which bot to hand a piece to): trivial and small run on the
coder tier; standard on the reasoner tier; large plans and adversarial review on the frontier tier. Compaction, reflection and classifying run on the reflex tier.

## 2. Research first, before any plan

- MIND: what is already known, decided or tried (mind_query the subject and the repo name). Cite what you found.
- The code: read the files you will touch and the tests beside them. Find the pattern the repo already uses for the same thing and mirror it; do not invent a second pattern.
- The runner: read package.json (or the equivalent) for the real test, typecheck and lint commands. Never assume `npm test`.
- Unknowns: list them as unknowns. A guess written as a fact is the most expensive bug.

## 3. Plan and Gate 1 (standard and large)

Write a short plan, then stop and ask the user to confirm it. The plan says:
- What changes, in one or two sentences, and what does not.
- Files to change (create, update, delete) and why.
- The test that will prove it.
- Risks and the rollback (what to run to undo it).
- For large: the phases, and which pieces go to a worker bot with a handoff card.

Gate 1 is the user's yes on the plan. Approving a goal is not approving a push or a deploy; those have their own gate.

## 4. Build

1. Worktree: never edit a main checkout in place. Cut a worktree or a branch for the task (the isolation gate enforces this on local repos).
2. Failing test first: write the test that fails for the right reason, run it, show the failure line. For a bug, the test reproduces the bug.
3. Smallest change that makes it pass. Then run the whole relevant suite, the type check and the lint at the repo's own concurrency.
4. Keep the diff on scope. Anything you noticed but did not fix goes in the report, not in the diff.
5. Delegating (large): one piece per handoff card to a worker bot via bot_talk. The card has: objective, evidence so far (paths, ids, what already works), what is left, the next action, how to verify. State the tier the piece should run on. When it comes back, run the verification yourself before you accept it.

## 5. Review

A review is a search for what is wrong, not a summary of what is there. For standard and large, get a second look (the reviewer bot, or a fresh
read of the diff) with this stance: silent failures (catch and continue, swallowed errors, defaults that hide a missing value), unverified
claims, scope drift, secrets, behaviour changes without a test. Every finding carries the file and line and the evidence. A finding without
evidence is a question, not a finding.

## 6. Verify with receipts (the verification skill)

Run build, type check, lint and tests; grep the diff for secrets; read the diff once more top to bottom. Report each as VERIFIED, FAILED or
NOT PERFORMED with the command and its summary line. "Tests pass" with no receipt is a guess.

## 7. Gate 2: before anything outward

Push, pull request, merge, deploy, publish, a message to a person: each is an outward action and waits for the user's explicit go-ahead on
that action, even when the plan was approved. Put the proof in front of them first: what changed, what was verified, what was not.

## 8. Report

Files changed, the test summary line, what was verified and how, what was not, open questions, the exact command to run it. Then record the
outcome in MIND as a private entry (what shipped, what failed, what you learned) so the next session starts from it.
