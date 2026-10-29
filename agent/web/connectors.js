// "Connectors": ONE list in the Apps card. It holds every MIND app the user can connect (Google, Microsoft 365, Dropbox, GitHub, Apple
// Calendar ... they sync data into MIND) AND the MIND App Store's remote MCP servers (official vendor servers and approved community
// ones, plus the user's own n8n or custom server). All of them are connectors. Connected ones come first, with their real account
// ("Connected · theastraway"); then the MIND apps that are not connected; then the App Store. One product, one row: GitHub is a MIND app
// AND an App Store server, so the app's row is the one row for it and the server has none of its own. The search box covers the whole list.
//
// The MIND apps come from GET /apps/integrations (the gateway asks MIND with the signed-in user's own key). The App Store list comes from
// the gateway (GET /mcp/catalog), which fetches MIND's list server-side. Connecting an App Store server never sends a URL: it sends the
// connector's id, the gateway looks the address up itself and creates the SAME pending request the consent card is built from
// (POST /mcp/catalog/connect). The user's click on the card is the consent; nothing here connects anything.
// DOM is built by apps.js (createElement + textContent only). Everything in the list is third-party text.

const AUTH_TEXT = { none: "No sign-in", oauth: "Sign in (OAuth)", key: "API key", oauth_or_key: "OAuth or API key", url_token: "Your URL + token" };

export function entryOf(it) {
  const tags = [];
  if (it.category) tags.push({ text: it.category.replace(/-/g, " ") });
  tags.push({ text: it.publisher === "official" ? "Official" : "Community", tone: it.publisher === "official" ? "ok" : "warn" });
  if (AUTH_TEXT[it.auth]) tags.push({ text: AUTH_TEXT[it.auth] });
  return {
    id: it.id, logo: String(it.id || "").replace(/^mcp:/, ""), name: it.name, blurb: it.blurb, tags, connected: !!it.connected, serverId: it.serverId, waiting: !!it.pendingId,
    removeLabel: "Remove", form: it.form && Array.isArray(it.form.fields) ? it.form : undefined,
  };
}

/** A pasted config block (n8n's "Configuration JSON", or "Authorization: Bearer ..." next to a URL) read into { server, token }:
 *  the two values the user pasted, for the form's own boxes. Nothing is sent from here.
 *  Returns null for an ordinary paste, which then lands in the box as usual. The gateway reads the same shapes again. */
export function readPaste(text) {
  const t = String(text || "");
  const tok = /Bearer\s+([^\s"'`,\]}]+)/i.exec(t);
  const addr = /https?:\/\/[^\s"'`,\]}]+/i.exec(t);
  if (!tok || !addr) return null;
  return { server: addr[0], token: tok[1] };
}

// The gateway marks an App Store server that is the same product as a MIND app the user can see (`foldedInto`).
// The list leaves it out: the app's row is the one row for that product, and a row never has a second row inside it.

/** The App Store servers that are not folded into a MIND app's row. */
export function connectorRows(items) { return (Array.isArray(items) ? items : []).filter((it) => !it || !it.foldedInto); }

/** An app the user can see: connected, or one MIND has set up. An app MIND has not set up and the user has not connected is not listed at all. */
export function connectableApp(p) { return !!(p.connected || p.configured !== false); }

/** A MIND app as a connector row. It shows the real state MIND reports: connected, on which account, needs reconnect.
 *  `linked` is the connection that rides on this app (MIND links GitHub's own MCP server with the app's token): it is the SAME row, with a tag saying how many tools
 *  Daebot has through it and a Manage button for them. It never becomes a second row. */
export function mindEntry(p, linked) {
  const e = {
    id: p.provider, kind: "mind", provider: p.provider, logo: p.provider, name: p.name, blurb: p.blurb, connected: !!p.connected,
    needsReconnect: !!p.needsReconnect, account: p.account, auth: p.auth, manageable: false,
  };
  if (linked && p.connected && linked.serverId) {
    const n = Number(linked.tools) || 0;
    e.serverId = linked.serverId;
    e.manageable = true;
    e.tags = [{ text: linked.enabled === false ? `Actions off (${n} tool${n === 1 ? "" : "s"})` : `Actions on: ${n} tool${n === 1 ? "" : "s"}`, tone: linked.enabled === false ? undefined : "ok" }];
  }
  return e;
}

/** The MIND apps as rows. An App Store server that is the same product as one of them has no row of its own (the gateway marks it `foldedInto`);
 *  the app's row is the one row for that product. */
export function appEntries(providers, toEntry = mindEntry) { return providers.map((p) => toEntry(p)); }

/** The one list: everything connected first (MIND apps, then App Store servers), then the MIND apps not connected yet, then the rest of the App Store. */
export function orderRows(mind, mcp) {
  return [...mind.filter((e) => e.connected), ...mcp.filter((e) => e.connected), ...mind.filter((e) => !e.connected), ...mcp.filter((e) => !e.connected)];
}

/** Builds the unified list from MIND's providers and the gateway's App Store items (either may be empty). `linked` (optional) are the connections that ride on a MIND app:
 *  each one is shown inside that app's one row, never as its own. */
export function connectorList(providers, items, linked) {
  const byProvider = {};
  for (const l of Array.isArray(linked) ? linked : []) if (l && l.provider && !byProvider[l.provider]) byProvider[l.provider] = l;
  return orderRows(appEntries(providers, (p) => mindEntry(p, byProvider[p.provider])), connectorRows(items).map((it) => ({ ...entryOf(it), kind: "mcp" })));
}

export function initConnectors({ apps, json, getMcp }) {
  const get = (path) => (apps.cached ? apps.cached(path) : json(path));
  /** Opens the server's sign-in in a new tab (the tab is opened here, inside the click, so the browser allows it), then watches for the connection to appear. */
  async function signInWithOAuth(e, ctl, values) {
    let win = null;
    try { win = window.open("about:blank", "_blank"); if (win) win.opener = null; } catch { win = null; }
    ctl.busy(true);
    let r;
    try {
      r = await json("/mcp/catalog/connect-oauth", { method: "POST", body: JSON.stringify({ id: e.id, url: values && values.url, name: values && values.name }) });
    } catch (err) { if (win) win.close(); ctl.busy(false); ctl.say(err && err.message ? err.message : `Could not connect ${e.name}.`, "warn"); return false; }
    if (r.status === "token_needed") {
      if (win) win.close();
      ctl.busy(false); if (ctl.needToken) ctl.needToken();
      ctl.say(r.message || "This server has no OAuth sign-in. Use an access token instead.", "warn");
      return false;
    }
    if (r.status === "connected") { apps.say(`Connected ${e.name}.`); const mcp = getMcp(); if (mcp) mcp.load(); apps.refresh(); return true; }
    if (!r.url || !/^https:\/\//.test(r.url)) { if (win) win.close(); ctl.busy(false); ctl.say("The server sent back a sign-in address Daebot will not open.", "warn"); return false; }
    if (win) win.location.href = r.url; else { location.assign(r.url); return true; }
    ctl.say(`Finish signing in on ${e.name}'s page in the new tab. This turns to Connected when you approve.`, "off");
    watchConnection(e, ctl, win);
    return true;
  }

  function watchConnection(e, ctl, win) {
    const until = Date.now() + 10 * 60_000; let closedPolls = 0;
    const tick = async () => {
      let found = null;
      try { const r = await json("/mcp/servers"); found = (r.servers || []).find((s) => s.preset === e.id); } catch { /* try again */ }
      if (found) {
        const n = Array.isArray(found.tools) ? found.tools.length : 0;
        apps.say(n ? `Connected ${e.name}: ${n} tool${n === 1 ? "" : "s"} ready. Ask Daebot to use them.` : `Connected ${e.name}.`);
        const mcp = getMcp(); if (mcp) mcp.load();
        apps.refresh();
        return;
      }
      if (win && win.closed) closedPolls++;
      if (Date.now() > until || closedPolls >= 5) { ctl.busy(false); ctl.say(`The ${e.name} sign-in did not finish. Select Connect to try again.`, "warn"); return; }
      setTimeout(tick, 2000);
    };
    setTimeout(tick, 2000);
  }

  const mcpHandlers = {
    readPaste,
    async onConnect(e, ctl, values) {
      if (e.form) {
        // OAuth first: with no token typed, the address alone starts the standard MCP sign-in (the gateway finds the server's sign-in, registers Daebot, and
        // returns the server's own authorization page to open in a new tab). A server with no OAuth turns on the access-token box.
        if (e.form.oauth && !(values && values.token && String(values.token).trim())) return signInWithOAuth(e, ctl, values);
        // With a token: the address and token go straight to the gateway, which probes the server with the token before saving.
        ctl.busy(true);
        try {
          const r = await json("/mcp/catalog/connect-token", { method: "POST", body: JSON.stringify({ id: e.id, url: values && values.url, token: values && values.token, name: values && values.name }) });
          const n = r && r.server && Array.isArray(r.server.tools) ? r.server.tools.length : 0;
          apps.say(n ? `Connected ${e.name}: ${n} tool${n === 1 ? "" : "s"} ready. Ask Daebot to use them.` : `Connected ${e.name}.`);
          const mcp = getMcp(); if (mcp) mcp.load();
          apps.refresh();
          return true;
        } catch (err) { ctl.busy(false); ctl.say(err && err.message ? err.message : `Could not connect ${e.name}.`, "warn"); return false; }
      }
      ctl.busy(true);
      try {
        const r = await json("/mcp/catalog/connect", { method: "POST", body: JSON.stringify({ id: e.id }) });
        const mcp = getMcp();
        if (mcp && r.pending) mcp.review(r.pending);
      } catch (err) { ctl.say(err && err.message ? err.message : `Could not start ${e.name}.`, "warn"); }
      finally { ctl.busy(false); }
    },
    async onDisconnect(e, ctl) {
      ctl.busy(true);
      try {
        await json(`/mcp/servers/${encodeURIComponent(e.serverId)}`, { method: "DELETE" });
        apps.say(`Removed ${e.name}.`);
        const mcp = getMcp(); if (mcp) mcp.load();
        apps.refresh();
      } catch (err) { ctl.busy(false); ctl.say(err && err.message ? err.message : `Could not remove ${e.name}.`, "warn"); }
    },
    onManage(e) { const mcp = getMcp(); if (mcp && e.serverId) mcp.manage(e.serverId); },
    confirmText: (e) => `Remove ${e.name}? Daebot stops using it and its stored sign-in is deleted.`,
  };
  const mind = apps.mind;
  // One list, two kinds of row: a MIND app is connected and disconnected at MIND (apps.mind), an App Store server through the gateway's MCP routes.
  const handlers = {
    readPaste, // the n8n / custom server form fills both boxes from one pasted config block
    onConnect: (e, ctl, values) => (e.kind === "mind" ? mind.handlers.onConnect(e, ctl) : mcpHandlers.onConnect(e, ctl, values)),
    onDisconnect: (e, ctl) => (e.kind === "mind" ? mind.handlers.onDisconnect(e, ctl) : mcpHandlers.onDisconnect(e, ctl)),
    onManage: (e) => { if (e.kind !== "mind" || e.serverId) mcpHandlers.onManage(e); },
    confirmText: (e) => (e.kind === "mind" ? `Disconnect ${e.name}? Anything already synced to MIND stays.` : mcpHandlers.confirmText(e)),
  };
  apps.addSection({
    id: "connectors", title: "Connectors", search: "Search connectors",
    note: "Your MIND apps and the MIND App Store, in one list. What is connected comes first. Pick a connector and Daebot shows you what it can do before anything connects.",
    async load() {
      const [m, c] = await Promise.allSettled([get("/apps/integrations"), get("/mcp/catalog")]);
      let providers = [], message = "";
      if (m.status === "fulfilled") {
        const r = m.value || {};
        if (r.signedIn === false) message = r.message || "Sign in with MIND to connect your MIND apps.";
        else if (r.enabled !== false) providers = (Array.isArray(r.providers) ? r.providers : []).filter(connectableApp);
      }
      let items = [], linked = [], storeOff = false;
      if (c.status === "fulfilled") { items = Array.isArray(c.value && c.value.items) ? c.value.items : []; linked = Array.isArray(c.value && c.value.linked) ? c.value.linked : []; }
      else if (/not enabled/i.test(String(c.reason && c.reason.message))) storeOff = true;
      // Nothing could be read at all: the card's own "Try again".
      if (m.status === "rejected" && c.status === "rejected" && !storeOff) throw c.reason;
      if (m.status === "rejected" && !providers.length) message = "Your MIND apps could not be loaded right now. Try again in a moment.";
      const entries = connectorList(providers, items, linked);
      if (!entries.length) return storeOff ? { entries: [], hidden: true } : { entries: [], message: message || "The MIND App Store list is not available right now. Try again in a moment." };
      return message ? { entries, message } : { entries };
    },
    handlers,
  });
}
