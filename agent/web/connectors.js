// "Connectors" section of the Apps card: the MIND App Store's remote MCP servers (official vendor servers and approved community ones).
// The list comes from the gateway (GET /mcp/catalog), which fetches MIND's list server-side. Connect never sends a URL: it sends the
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

export function initConnectors({ apps, json, getMcp }) {
  apps.addSection({
    id: "connectors", title: "Connectors", search: "Search connectors",
    note: "Servers listed in the MIND App Store. Pick one and Daebot shows you what it can do before anything connects.",
    async load() {
      let r;
      try { r = await json("/mcp/catalog"); }
      catch (e) { if (/not enabled/i.test(String(e && e.message))) return { entries: [], hidden: true }; throw e; }
      const items = Array.isArray(r.items) ? r.items : [];
      if (!items.length) return { entries: [], message: "The MIND App Store list is not available right now. Try again in a moment." };
      return { entries: items.map(entryOf) };
    },
    handlers: {
      readPaste,
      async onConnect(e, ctl, values) {
        if (e.form) {
          // n8n / custom server: the address and token go straight to the gateway, which probes the server with the token before saving.
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
    },
  });
}
