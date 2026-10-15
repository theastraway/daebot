// Mistake classes for the LEARNING suite. Each class is one repeatable agent mistake, the user's correction, what a
// competent reflector would write about it (SCRIPTED, not produced by a model: see LEARNING.md for what that means),
// and session-2 tasks of three kinds: similar (shares task words), paraphrase (shares almost none) and a control.
import type { StepCall } from "../types.ts";
import type { ReflectionResult } from "../../learn/types.ts";
import type { RunResult } from "../types.ts";

export interface TaskDef { user: string; kind: "similar" | "paraphrase" }

export interface MistakeClass {
  id: string;
  mistake: string;
  session1: string;                         // task on which the agent makes the mistake
  correction: string;                       // the user's correction in the next turn
  reflection: ReflectionResult;             // what the (scripted) reflector returns for that correction
  fixWords: string[];                       // the scripted student follows the lesson iff every word occurs in the note
  tasks: TaskDef[];                         // session 2
  // the bad behavior, as the student would show it, and the corrected one
  bad: { calls?: StepCall[]; text: string };
  good: { calls?: StepCall[]; text: string };
  isBad: (r: RunResult, turn: number) => boolean;
  outputs?: Record<string, string>;
}

const long = "Sure, happy to help with that. Let me walk you through everything in detail. There are several moving parts here, and I want to be thorough so you have the whole picture. First, a lot of background happened over the last stretch, and then many smaller items followed, each with its own wrinkles. Overall things are progressing along the lines we expected, with a few open points worth keeping an eye on in the coming days.";

const execBy = (r: RunResult, turn: number, tool: string) => r.exec.some((e) => e.turn === turn && e.tool === tool);
const text = (r: RunResult, turn: number) => r.finalTexts[turn] ?? "";

export const CLASSES: MistakeClass[] = [
  {
    id: "brevity", mistake: "long chat reply to a status question",
    session1: "What's the status of the deploy work?",
    correction: "No, that is way too long. Keep chat replies to one or two short sentences, no preamble.",
    reflection: {
      lesson: { kind: "failure", trigger: "answering a status or progress question in a chat reply", behavior: "Short chat replies", rule: "Answer status and progress questions in one or two short sentences with no preamble; give detail only when asked.", evidence: "A status answer ran to a long paragraph and the user said it was too long." },
      userPrefs: [{ area: "register", statement: "Chat replies are short, one or two sentences, detail only when asked." }],
    },
    fixWords: ["short sentences"],
    tasks: [
      { user: "Give me a quick status update on the migration progress.", kind: "similar" },
      { user: "Status and progress on the billing cleanup?", kind: "similar" },
      { user: "Where are we on the release?", kind: "paraphrase" },
    ],
    bad: { text: long }, good: { text: "Two items open, nothing blocked." },
    isBad: (r, t) => text(r, t).length > 220,
  },
  {
    id: "grep-first", mistake: "opens files blindly instead of grepping",
    session1: "Find where the retry limit is configured.",
    correction: "No, wrong approach. Search with grep first, then read only the matching file.",
    reflection: {
      lesson: { kind: "failure", trigger: "finding where a setting or value is configured in code", behavior: "Grep before reading", rule: "Run grep for the setting name first, then read only the matching file instead of opening files blindly.", evidence: "Opened a file without searching and the user redirected to grep first." },
    },
    fixWords: ["grep for"],
    tasks: [
      { user: "Find where the timeout value is set in the code.", kind: "similar" },
      { user: "Where is the page size configured in the code?", kind: "similar" },
      { user: "Locate the cache ttl definition.", kind: "paraphrase" },
    ],
    bad: { calls: [{ name: "read_file", args: { path: "src/config.ts" } }], text: "It lives in the config module." },
    good: { calls: [{ name: "grep", args: { pattern: "limit" } }, { name: "read_file", args: { path: "src/config.ts" } }], text: "It lives in the config module." },
    isBad: (r, t) => !execBy(r, t, "grep"),
  },
  {
    id: "act-not-ask", mistake: "asks a clarifying question instead of doing the small task",
    session1: "Add a changelog entry for the login fix.",
    correction: "No, don't ask me, just write the entry. You have what you need.",
    reflection: {
      lesson: { kind: "failure", trigger: "asked to add or write a small document entry when the details are already given", behavior: "Act don't ask", rule: "When the request has enough detail, write the file directly and report; do not ask which format to use.", evidence: "Asked which format to use for a changelog entry instead of writing it." },
    },
    fixWords: ["write the file directly"],
    tasks: [
      { user: "Add a changelog entry for the export fix.", kind: "similar" },
      { user: "Write a new entry in the docs for the billing fix.", kind: "similar" },
      { user: "Note the search fix in the release notes.", kind: "paraphrase" },
    ],
    bad: { text: "Which format would you like for the entry, and where should it go?" },
    good: { calls: [{ name: "write_file", args: { path: "{{scratch}}/CHANGELOG.md", content: "- entry" } }], text: "Added the entry." },
    isBad: (r, t) => !execBy(r, t, "write_file"),
  },
  {
    id: "plain-prose", mistake: "markdown bullets in an email draft",
    session1: "Draft a short note to the team about Friday's release.",
    correction: "No, no bullets or bold in emails. Plain prose paragraphs only.",
    reflection: {
      lesson: { kind: "failure", trigger: "drafting an email or note to people", behavior: "Plain prose emails", rule: "Write emails and notes as plain prose paragraphs with no bullets, headers or bold.", evidence: "Email draft used bullets and bold and the user asked for plain prose." },
      userPrefs: [{ area: "format", statement: "Emails are plain text prose with no markdown." }],
    },
    fixWords: ["plain prose"],
    tasks: [
      { user: "Draft an email to the partners about the schedule.", kind: "similar" },
      { user: "Draft a note to the team for Monday.", kind: "similar" },
      { user: "Compose a message for the crew.", kind: "paraphrase" },
    ],
    bad: { text: "Hi team,\n\n- **Friday**: release window\n- **Monday**: review\n\nThanks" },
    good: { text: "Hi team, the release window is Friday and we review on Monday. Thanks." },
    isBad: (r, t) => /(^|\n)\s*[-*] |\*\*/.test(text(r, t)),
  },
  {
    id: "query-first", mistake: "answers a question about past decisions from memory",
    session1: "What did we decide about the pricing page layout?",
    correction: "No, wrong. Query MIND before you answer questions about past decisions.",
    reflection: {
      lesson: { kind: "failure", trigger: "asked what was decided or discussed earlier", behavior: "Query before recalling", rule: "Query MIND before answering any question about past decisions or earlier discussions; never answer from memory.", evidence: "Answered a question about a past decision without querying MIND." },
    },
    fixWords: ["query mind before"],
    tasks: [
      { user: "What did we decide earlier about the invoice template?", kind: "similar" },
      { user: "What was discussed earlier about the onboarding flow?", kind: "similar" },
      { user: "Remind me of the call outcome.", kind: "paraphrase" },
    ],
    bad: { text: "We kept the layout as it was." },
    good: { calls: [{ name: "mind_query", args: { query: "what was decided" } }], text: "Per MIND, the layout stays." },
    isBad: (r, t) => !execBy(r, t, "mind_query"),
    outputs: { mind_query: "Layout stays the same." },
  },
  {
    id: "next-step", mistake: "wrap-up without a next step",
    session1: "Wrap up this session.",
    correction: "No, always end a wrap-up with a Next: line naming the next step.",
    reflection: {
      lesson: { kind: "failure", trigger: "wrapping up a session or summarizing where things stand", behavior: "End with next", rule: "End every wrap-up or summary with a Next: line that names the single next step.", evidence: "A wrap-up ended without a next step and the user asked for one." },
    },
    fixWords: ["next: line"],
    tasks: [
      { user: "Summarize where things stand and close out.", kind: "similar" },
      { user: "Wrap up where we are for today.", kind: "similar" },
      { user: "Give me the handoff.", kind: "paraphrase" },
    ],
    bad: { text: "Summary: two edits made." },
    good: { text: "Summary: two edits made.\nNext: review the draft tomorrow." },
    isBad: (r, t) => !/^Next:/m.test(text(r, t)),
  },
];

export const CONTROL_TASKS = [
  "What time zone do we use?",
  "How many days are in a leap year?",
];
