/** Three lines in the system prompt. A summary is a cue; exact words come back through session_recall. */
export const RECALL_POLICY = [
  "Recall: a summary of earlier turns is a cue, not evidence. It can drop exact words, numbers and tool output.",
  "When the exact wording or a value from earlier in this chat matters, call session_recall (grep, then expand) and cite the turn.",
  "A large tool result is a short view plus a [ref:…] line. session_recall expand with that ref pages the original text.",
].join("\n");
