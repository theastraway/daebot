// Connected MCP servers (web). Two pieces:
//   1. The consent card: shown in the chat when Daebot proposes a server (and from the sidebar). Only the Connect button on it can
//      connect anything. The masked key field posts straight to /mcp/pending/:id/approve; the model never sees it.
//   2. The "Connected MCP servers" sidebar section: list, turn on/off, choose which tools run without asking, refresh, remove.
// DOM is built with createElement + textContent only. Everything a server said (names, descriptions) is untrusted text.

export function publisherLabel(p) {
  return p === "official" ? "Official publisher" : p === "community" ? "Community, listed in the MIND App Store" : "Unknown publisher";
}
export function authLabel(p) {
  if (!p.authRequired) return "No sign-in needed";
  return p.oauth ? "Sign in (OAuth) or paste an API key" : "Needs an API key";
}

export function initMcp({ json, api, h, icon, notify, mount, section, openApps, suspendApps, resumeApps }) {
  const side = mount;           // the sidebar section element
  let servers = [], pending = [], limits = null, enabled = false;
  const shown = new Set();      // pending ids that already have a card in the thread
  const readerOpen = { v: false };

  async function load() {
    try {
      const r = await api("/mcp/servers");
      if (!r.ok) { enabled = false; if (section) section.hidden = true; return; }
      const d = await r.json();
      enabled = true; servers = d.servers || []; pending = d.pending || []; limits = d.limits || null;
      renderSide();
    } catch { /* offline: keep what is shown */ }
  }

  function toolRow(t, box, opts) {
    const row = h("label", "mcp-tool");
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!opts.checked; cb.disabled = !!opts.disabled;
    cb.setAttribute("aria-label", `${t.name} runs without asking`);
    const name = h("span", "mcp-tool-name", t.name);
    const tag = h("span", `mcp-tag ${t.readOnly ? "ro" : "rw"}`, t.readOnly ? "read-only" : t.destructive ? "can delete" : "can change data");
    const desc = h("span", "mcp-tool-desc", t.description || "");
    row.append(cb, name, tag, desc);
    box.append(row);
    return cb;
  }

  // ---- the consent card
  function buildCard(p, onDone) {
    const card = h("div", "confirm mcp-card");
    card.append(h("h3", "", "Connect an MCP server?"));
    const facts = h("dl", "mcp-facts");
    const fact = (k, v, cls) => { facts.append(h("dt", "", k)); facts.append(h("dd", cls || "", v)); };
    fact("Server", p.url, "mono");
    fact("Host", p.host, "mono");
    const pub = h("dd", ""); pub.append(h("span", `mcp-pub ${p.publisher}`, publisherLabel(p.publisher))); facts.append(h("dt", "", "Publisher"), pub);
    fact("Sign-in", authLabel(p));
    card.append(facts);
    if (p.reason) card.append(h("p", "mcp-reason", p.source === "catalog" ? `MIND App Store: ${p.reason}` : `Daebot says: ${p.reason}`));
    if (p.publisher === "unknown") card.append(h("p", "mcp-warn", "Daebot could not verify who runs this server. Connect it only if you trust it. Nothing it returns is treated as an instruction."));

    const allowBoxes = [];
    if (p.tools === null) {
      card.append(h("p", "hint-line", "Its tool list is shown after you sign in."));
    } else {
      card.append(h("h4", "mcp-h", `${p.tools.length} tool${p.tools.length === 1 ? "" : "s"}${p.toolsTruncated ? " (more than your limit; the first ones only)" : ""}`));
      card.append(h("p", "hint-line", "Tools that change data always ask you first. Tick a tool to let it run without asking."));
      const box = h("div", "mcp-tools");
      for (const t of p.tools) {
        const cb = toolRow(t, box, { checked: (p.defaultAllow || []).includes(t.name) });
        allowBoxes.push([t.name, cb]);
      }
      card.append(box);
    }

    let keyInput = null, via = null;
    if (p.authRequired) {
      const sec = h("div", "mcp-auth");
      if (p.oauth) {
        const oauthBtn = h("button", "btn-primary", "Sign in with " + p.host); oauthBtn.type = "button";
        oauthBtn.addEventListener("click", () => submit("oauth"));
        sec.append(oauthBtn, h("span", "mcp-or", "or"));
      }
      const lab = h("label", "fld-label", "API key or bearer token"); lab.htmlFor = `mcp-key-${p.id}`;
      keyInput = document.createElement("input");
      keyInput.type = "password"; keyInput.id = `mcp-key-${p.id}`; keyInput.className = "fld"; keyInput.autocomplete = "off"; keyInput.spellcheck = false;
      keyInput.setAttribute("data-1p-ignore", ""); keyInput.placeholder = "Stored encrypted; Daebot's model never sees it";
      sec.append(lab, keyInput);
      card.append(sec);
      via = "key";
    }

    const status = h("p", "mcp-status"); status.setAttribute("role", "status"); status.hidden = true;
    const row = h("div", "row");
    const go = h("button", "btn-primary", p.authRequired ? "Connect with key" : "Connect"); go.type = "button";
    const no = h("button", "btn-quiet", "Not now"); no.type = "button";
    if (p.authRequired && !p.oauth) go.textContent = "Connect";
    row.append(go, no);
    card.append(row, status);

    function say(msg, bad) { status.hidden = !msg; status.textContent = msg || ""; status.classList.toggle("bad", !!bad); }
    function finish(msg) { card.classList.add("done"); go.disabled = no.disabled = true; if (keyInput) keyInput.disabled = true; say(msg, false); onDone?.(); }
    async function submit(mode) {
      const body = { mode, allow: allowBoxes.filter(([, cb]) => cb.checked).map(([n]) => n), name: p.suggestedName };
      if (mode === "key") {
        body.apiKey = keyInput ? keyInput.value.trim() : "";
        if (!body.apiKey) { say("Paste the key first.", true); keyInput?.focus(); return; }
      }
      go.disabled = true; say("Connecting...", false);
      try {
        const r = await json(`/mcp/pending/${encodeURIComponent(p.id)}/approve`, { method: "POST", body: JSON.stringify(body) });
        if (keyInput) keyInput.value = "";
        if (r.status === "authorize" && typeof r.url === "string" && r.url.startsWith("https://")) { say("Opening the server's sign-in page...", false); location.assign(r.url); return; }
        finish(`Connected. Its tools are named ${r.server.name}__<tool>.`);
        shown.add(p.id); load();
      } catch (e) { go.disabled = false; say(String(e.message || e), true); }
    }
    go.addEventListener("click", () => submit(p.authRequired ? (keyInput && keyInput.value.trim() ? "key" : p.oauth ? "oauth" : "key") : "none"));
    keyInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit("key"); } });
    no.addEventListener("click", async () => { try { await json(`/mcp/pending/${encodeURIComponent(p.id)}/deny`, { method: "POST" }); } catch { /* gone already */ } finish("Dismissed. Nothing was connected."); load(); });
    return card;
  }

  // ---- sidebar section
  function renderSide() {
    if (section) section.hidden = !enabled;
    if (!enabled) return;
    side.replaceChildren();
    const body = h("div", "mcp-body");
    if (!servers.length && !pending.length) body.append(h("p", "empty-side", "None yet. Ask Daebot to find and connect one, e.g. a vendor's docs."));
    for (const p of pending) {
      const r = h("div", "mcp-row pend");
      r.append(h("span", "mcp-host", p.host), h("span", "mcp-state", "Waiting for you"));
      const b = h("button", "btn-quiet sm", "Review"); b.type = "button"; b.addEventListener("click", () => openModal(p));
      r.append(b); body.append(r);
    }
    for (const s of servers) body.append(serverRow(s));
    if (limits) body.append(h("p", "drawer-fine", `Up to ${limits.maxServers} servers and ${limits.maxTools} tools.`));
    side.append(body);
  }

  function serverRow(s) {
    const wrap = h("div", "mcp-srv" + (s.enabled ? "" : " off")); wrap.dataset.srv = s.id;
    const top = h("div", "mcp-row");
    const label = h("div", "mcp-lab"); label.append(h("span", "mcp-host", s.name), h("span", "mcp-sub", `${s.host} · ${s.tools.length} tools${s.truncated ? " (capped)" : ""}`));
    const tog = h("button", "btn-quiet sm", s.enabled ? "On" : "Off"); tog.type = "button"; tog.setAttribute("aria-pressed", String(s.enabled));
    tog.addEventListener("click", async () => { try { await json(`/mcp/servers/${encodeURIComponent(s.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: !s.enabled }) }); } catch (e) { notify(String(e.message || e)); } load(); });
    top.append(label, tog);
    wrap.append(top);
    const det = document.createElement("details"); det.className = "mcp-det";
    det.append(h("summary", "", `${s.publisher} publisher · tools`));
    const box = h("div", "mcp-tools"); const boxes = [];
    for (const t of s.tools) boxes.push([t.name, toolRow(t, box, { checked: t.allowed || t.runsWithoutAsking })]);
    det.append(box);
    const acts = h("div", "row");
    const save = h("button", "btn-quiet sm", "Save tool choices"); save.type = "button";
    save.addEventListener("click", async () => { try { await json(`/mcp/servers/${encodeURIComponent(s.id)}`, { method: "PATCH", body: JSON.stringify({ allow: boxes.filter(([, c]) => c.checked).map(([n]) => n) }) }); notify("Saved."); } catch (e) { notify(String(e.message || e)); } load(); });
    const ref = h("button", "btn-quiet sm", "Refresh tools"); ref.type = "button";
    ref.addEventListener("click", async () => { ref.disabled = true; try { await json(`/mcp/servers/${encodeURIComponent(s.id)}/refresh`, { method: "POST" }); } catch (e) { notify(String(e.message || e)); } load(); });
    const del = h("button", "btn-danger sm", "Remove"); del.type = "button";
    del.addEventListener("click", () => {
      if (del.dataset.sure !== "1") { del.dataset.sure = "1"; del.textContent = "Really remove?"; setTimeout(() => { del.dataset.sure = ""; del.textContent = "Remove"; }, 4000); return; }
      json(`/mcp/servers/${encodeURIComponent(s.id)}`, { method: "DELETE" }).catch((e) => notify(String(e.message || e))).finally(load);
    });
    acts.append(save, ref, del);
    det.append(acts);
    wrap.append(det);
    return wrap;
  }

  function openModal(p) {
    const ov = h("div", "gate-token modal mcp-overlay"); ov.setAttribute("role", "dialog"); ov.setAttribute("aria-modal", "true");
    // If the Apps card is open, it steps aside while this card is up (and comes back, refreshed, when this one closes).
    const hidApps = suspendApps ? suspendApps() : false;
    let closed = false;
    const close = () => { if (closed) return; closed = true; ov.remove(); if (hidApps && resumeApps) resumeApps(); };
    const card = buildCard(p, () => setTimeout(close, 1200));
    const x = h("button", "btn-quiet", "Close"); x.type = "button"; x.addEventListener("click", close);
    const box = h("div", "token-card mcp-modal"); box.append(card, x); ov.append(box);
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    document.body.append(ov);
  }

  return {
    load,
    /** After mcp_connect finished in a turn: returns pending requests that still need a card in the thread. */
    async newPending() {
      await load();
      const fresh = pending.filter((p) => !shown.has(p.id));
      fresh.forEach((p) => shown.add(p.id));
      return fresh;
    },
    buildCard,
    /** Show the consent card for a pending request (from the Apps card's Connectors list). */
    review: openModal,
    /** Bring a connected server's controls into view in the Apps card. */
    manage(id) {
      const row = side.querySelector(`[data-srv="${CSS.escape(String(id))}"]`);
      if (!row) return;
      const det = row.querySelector("details"); if (det) det.open = true;
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      const t = row.querySelector("button"); if (t) t.focus({ preventScroll: true });
    },
    enabled: () => enabled,
    /** Back from an OAuth sign-in (?mcp=connected|failed). */
    returned(q) { if (q) notify(q === "connected" ? "MCP server connected." : "The MCP sign-in did not finish."); },
  };
}
