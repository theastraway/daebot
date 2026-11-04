// The Authorize card Daebot puts in the chat for a MIND app (Google, Dropbox, ...). It reuses the Apps window's connect path
// (apps.mind.handlers.onConnect -> POST /apps/integrations/:provider/connect -> opens MIND's own sign-in in a new tab); there is no second OAuth flow.
// Nothing connects until the user clicks the button. Name and state come from the user's own MIND app list, never from the model.
// DOM is built with the injected `h` (createElement + textContent), so untrusted text is never parsed as HTML.

const PROVIDER_OK = /^[a-z0-9][a-z0-9-]{0,39}$/;
const POLL_MS = 3000, POLL_MAX = 40; // after the click, re-read the user's apps every 3 seconds for about two minutes

export function buildAppCard({ provider, h, apps, onDone, timers = { set: setInterval, clear: clearInterval } }) {
  const card = h("div", "confirm mcp-card app-card");
  const title = h("h3", "", "Connect an app?");
  const body = h("p", "mcp-reason", "");
  const status = h("p", "mcp-status"); status.setAttribute("role", "status"); status.hidden = true;
  const row = h("div", "row");
  const go = h("button", "btn-primary", "Authorize"); go.type = "button";
  const no = h("button", "btn-quiet", "Not now"); no.type = "button";
  row.append(go, no);
  card.append(title, body, row, status);
  let entry = null, poll = null, ticks = 0;

  const say = (msg, bad) => { status.hidden = !msg; status.textContent = msg || ""; status.classList.toggle("bad", !!bad); };
  const stop = () => { if (poll) { timers.clear(poll); poll = null; } };
  function showConnected() {
    stop(); card.classList.add("done"); go.hidden = true; no.hidden = true;
    title.textContent = `${entry.name} is connected`; body.textContent = "";
    say("Connected.", false); onDone && onDone();
  }
  async function read() {
    const d = await apps.cached("/apps/integrations");
    const p = (d && Array.isArray(d.providers) ? d.providers : []).find((x) => x && x.provider === provider);
    return p ? { id: p.provider, name: String(p.name || p.provider), blurb: String(p.blurb || ""), auth: p.auth === "credentials" ? "credentials" : "oauth", connected: !!p.connected, needsReconnect: !!p.needsReconnect, configured: p.configured !== false } : null;
  }
  async function refresh() {
    try {
      const e = await read();
      if (!e) return;
      entry = e;
      if (e.connected && !e.needsReconnect) showConnected();
    } catch { /* offline: the card stays as it is */ }
  }
  function watch() {
    stop(); ticks = 0;
    poll = timers.set(() => { if (++ticks > POLL_MAX) { stop(); return; } refresh(); }, POLL_MS);
  }

  if (!PROVIDER_OK.test(String(provider || ""))) { title.textContent = "App not available"; go.hidden = true; no.hidden = true; return card; }
  go.disabled = true;
  read().then((e) => {
    if (!e) { title.textContent = "App not available"; body.textContent = "Daebot could not find that app in your account."; go.hidden = true; no.hidden = true; return; }
    entry = e;
    if (e.connected && !e.needsReconnect) { showConnected(); return; }
    title.textContent = e.needsReconnect ? `Reconnect ${e.name}?` : `Connect ${e.name}?`;
    body.textContent = e.blurb || "";
    go.textContent = e.needsReconnect ? "Reconnect" : "Authorize"; go.disabled = false;
  }).catch(() => { title.textContent = "Connect an app?"; body.textContent = ""; say("Could not read your apps. Open the Apps window to connect.", true); go.hidden = true; });

  go.addEventListener("click", async () => {
    if (!entry) return;
    go.disabled = true;
    const ctl = { busy: (b) => { go.disabled = !!b; }, say: (m, tone) => say(m, tone === "warn") };
    await apps.mind.handlers.onConnect(entry, ctl);
    say(`Approve ${entry.name} in the new tab, then come back here.`, false);
    go.disabled = false; go.textContent = "Open again";
    watch();
  });
  no.addEventListener("click", () => { stop(); card.classList.add("done"); go.disabled = no.disabled = true; say("Dismissed. Nothing was connected.", false); onDone && onDone(); });
  return card;
}
