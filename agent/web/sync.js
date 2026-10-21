// Live sync of the open conversation with the server's saved history.
//
// A turn can happen outside this tab: a reply typed in MINDbots / MIND Chat is run by the gateway through
// POST /api/agent/turn, or another device sends into the same session. The server history has it; this tab's
// in-memory (and sessionStorage) transcript does not, so the thread looked frozen until the user opened another chat.
// Pure decision logic lives here so it can be unit tested; app.js owns the DOM and the timer.

/** Counts of the events that mark a turn: how many user messages and how many completed turns the history holds. */
export function historyMarks(events) {
  let users = 0, dones = 0;
  for (const e of Array.isArray(events) ? events : []) {
    if (e && e.type === "user") users++;
    else if (e && e.type === "done") dones++;
  }
  return { users, dones };
}

/**
 * Whether the visible transcript is behind the server.
 * - more user messages on the server than shown  -> a message arrived from elsewhere
 * - the completed-turn count moved since the last look (and we had a baseline) -> that turn's answer finished
 * `lastDones` is undefined until the first look at this session (and reset after a local send), in which case only
 * a user-message gap counts so a normal local turn never triggers a rebuild.
 */
export function transcriptBehind({ events, localUsers, lastDones }) {
  const m = historyMarks(events);
  const behind = m.users > localUsers || (lastDones !== undefined && m.dones !== lastDones);
  return { behind, dones: m.dones };
}
