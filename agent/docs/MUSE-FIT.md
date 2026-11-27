# Muse (Meta's agent) and what Daebot takes from it

Source: public reporting summarised on Wikipedia ("Muse (AI agent)", read 2026-11-20). No Meta code or assets were used; this is a feature comparison.

## What Muse does well

| Muse | What it means for the user | Daebot today |
| --- | --- | --- |
| Long-running tasks on the user's behalf, not single answers | Hand off a job and come back to it done | Turns run until done with check-ins; routines; the portal engineer; **new: /loop runs until the work clears 9/10** |
| Runs in its own cloud VM; a browser the user can watch | Trust comes from watching the agent work | Live browser pane, screen feed, terminal pane; **new: the Live room shows every helper and loop at work** |
| "Sentinel" permissions: per service, read vs write | Clear limits the user sets once | Kernel gates on tool classes (read, write, outward, irreversible, public), permission cards, guard rules |
| Name, avatar and communication style | It feels like your agent | Faces, names, personalities, DAEBOT.md instructions |
| Realtime avatar video, glasses, a palm device | Reach it everywhere | Voice agent, iPhone and Mac apps, Telegram, Discord, iMessage |
| Controls macOS apps | Does the clicks for you | computer, app and screen tools on the desktop |
| Its own email address | Forward work to it | MIND Email Manager tools (mind_mail) |
| Commerce partners, a fee per transaction | Buys and books for you | Not in Daebot (outward actions always need the user's go) |
| Hands hard calls to human agents (reported) | A job still gets finished | Not in Daebot |

## Where Daebot is different (the pitch)

- **MIND at the core.** Muse's memory is the product's own; Daebot's is the user's knowledge graph, with sources and trust labels on every memory, shared by every helper, bot and session.
- **It builds.** Dae is the Builder: it builds software, other agents, workflows and loops, and it designs how the account learns.
- **It grades itself.** /loop studies MIND, builds, checks, scores itself against a rubric like a tough editor, fixes the weakest part and repeats until it clears the bar, then remembers the win.
- **Proof, not trust.** Every claim needs a receipt from this turn; gates are code, not prompt text.

## Next steps worth taking from Muse

1. An agent inbox address per account that wakes Dae (MIND Email Manager is the base).
2. A watch-it-work timeline per helper (the tools it ran, in order) in the Live room.
3. A one-page "what my Daebot may touch" view: the permission classes, guard rules and connected apps, read vs write, in one place.
