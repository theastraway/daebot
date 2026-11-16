---
name: review
description: How to review a diff, a plan or an action: findings with file, line and the concrete failure; dedupe by evidence; then try to refute each one, defaulting to refuted; a clean review is a valid review.
group: build
triggers: \b(?:review (?:this|the|my|that)?\s*(?:code|diff|pr|change|changes|branch|plan|design)?|code ?review|second (?:pair of eyes|opinion|look)|silent failures?|find (?:bugs|problems|issues) in|adversarial|refute)\b
tools: bot_talk
priority: 15
license: MIT
source: daebot (own text; the stance follows affaan-m/ECC's code-reviewer and silent-failure-hunter agents as concepts)
---
# Review

A review is a search for what is wrong, not a summary of what is there. It ends with a verdict a person can act on.

## 1. Gather

- The diff (`git diff`, `git diff --staged`, or the PR) and the ask it answers. For a plan: the plan and the code it will touch.
- Read the surrounding code, not just the changed lines: callers, the types, the tests beside it. Many apparent issues are handled one frame up.
- Note the project's own patterns for the same thing. A change that invents a second pattern is a finding.

## 2. Hunt, in this order

1. Silent failures: an empty catch, a catch that logs and continues, `.catch(() => [])`, a default that hides a missing value, a timeout with no error, a promise nobody awaits.
2. Correctness: the off-by-one, the wrong boundary, the state that is read before it is set, the race.
3. Security: user input that reaches a shell, a query or another service; secrets in code; a permission or tier check missing or widened; anything outward with no confirmation.
4. Scope: changes nobody asked for; a behaviour change with no test; a test that was weakened or skipped to pass.
5. Tests: does the test fail for the right reason without the fix? Does it prove the claim in the ask?

## 3. Write each finding with proof

```
- <file>:<line> [<severity>] <what is wrong>
  failure: <input or state> -> <bad outcome>
  evidence: <the snippet, the caller, the test that shows it>
  fix: <the smallest change that resolves it>
```

Severity needs proof: a HIGH or CRITICAL finding carries the exact snippet, the failure scenario and why the existing guards do not catch it. No line, no finding. A style preference is not a finding unless it breaks the project's own convention.

## 4. Dedupe by evidence

One cause, one finding. Five functions missing the same check is one finding that lists five places. Two findings that share the same evidence are the same finding.

## 5. Verify adversarially, defaulting to refuted

Take each finding and try to refute it: read the caller, the type, the test, the framework default. Run the failing input if you can. A finding you cannot reproduce or trace to a real path is refuted and dropped; say in one line what refuted it. Only what survives goes in the report. Starting from refuted is what keeps a review honest: manufactured findings cost more than missed ones.

## 6. Report

```
Review: <what was reviewed, one line>
Verdict: APPROVE | APPROVE WITH FIXES | REQUEST CHANGES
Findings (<n>, after verification):
- ...
Refuted (<n>): <one line each, what refuted it>
Checked: <what you read and ran>   Not checked: <what you could not>
```

Zero findings is a valid review: say APPROVE and what you checked. When the ask was to review before an outward action (a push, a merge, a message), the verdict is advice for the person who decides; it never lifts a gate.
