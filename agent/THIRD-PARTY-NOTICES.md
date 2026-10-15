# Third-party notices

Rule (SPEC section 7): code from a permissively licensed project may be used verbatim with its header kept and a row here. Anything else is concepts only.

| Source | Path | Commit / version | License | How used |
|---|---|---|---|---|
| NousResearch/hermes-agent | (none copied) | v0.17.0 local; upstream main acc3cada (v0.22.2) read for newer file names | MIT, Copyright (c) 2025 Nous Research | Concepts only, re-implemented in TypeScript for `agent/src/learn/`: background post-turn review off the reply path, correction-as-signal, a "do not capture" list, bounded curated memory with a user model, fenced recall, usage counters with a lifecycle. No Hermes source or prompt text is reproduced; see `agent/LEARNING.md` section 1 for the file:line references. Because nothing was copied, no license header is carried in any file. |

Papers (Reflexion, Voyager, ExpeL, Generative Agents, MemGPT, A-MEM, AWM, ReasoningBank, SkillWeaver and others listed in `agent/LEARNING.md`) are cited as ideas; no code from them is used.
