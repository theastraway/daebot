// Connections (Account menu > LLM & database; the model menu's "LLM connectors" link): the same three things MIND's settings offer.
//   Your AI        GET/POST/DELETE /byo-llm, POST /byo-llm/test   -> your own provider key (MIND stores it; one setting for MIND and Daebot)
//   Local model    GET/PUT /settings/local-llm, POST /settings/local-llm/detect -> the server on this computer (desktop and self-host)
//   Your database  GET /bridges, PUT/DELETE /bridges/db, POST /bridges/db/test|bootstrap|verify-routing -> your own Postgres (MIND's bridge)
// DOM is built with createElement + textContent only. Keys and passwords are sent once and never shown again. Pure helpers are exported for tests.

export const FALLBACK_PROVIDERS = [
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com/v1" },
  { id: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "xai", label: "xAI", baseUrl: "https://api.x.ai/v1" },
  { id: "ollama", label: "Ollama (local)", baseUrl: "http://127.0.0.1:11434/v1", needsUrl: true, keyOptional: true },
  { id: "openai-compat", label: "OpenAI-compatible", baseUrl: "", needsUrl: true },
];
export const SSL_MODES = [["require", "Require"], ["verify-full", "Verify full"], ["prefer", "Prefer"], ["disable", "Disable"]];

/** "Running on your OpenRouter key (…abcd), model x" or "Daebot runs on MIND's models." */
export function llmLine(st, providers = FALLBACK_PROVIDERS) {
  if (!st) return "";
  if (st.signed_out) return "Sign in with MIND to run Daebot on your own AI key.";
  if (!st.feature_enabled) return "Bring your own AI is not switched on at MIND yet.";
  if (!st.configured) return "Daebot runs on MIND's models and bills your MIND account. Add your own key to run on it instead.";
  const p = providers.find((x) => x.id === st.provider);
  const name = p ? p.label : st.provider || "your provider";
  const tail = [st.key_last4 ? `key …${st.key_last4}` : "", st.model ? `model ${st.model}` : ""].filter(Boolean).join(", ");
  return `Running on your ${name} key${tail ? ` (${tail})` : ""}. Your provider bills you directly.`;
}

/** The form, checked: {body} or {error}. The key is required unless the provider says it is optional; a custom server needs its URL. */
export function llmFromForm({ provider, baseUrl, apiKey, model, configured }, providers = FALLBACK_PROVIDERS) {
  const p = providers.find((x) => x.id === provider);
  if (!p) return { error: "Pick a provider." };
  const key = String(apiKey || "").trim();
  const url = String(baseUrl || "").trim();
  if (p.needsUrl && !url) return { error: "Enter the server's base URL, ending in /v1." };
  if (url && !/^https?:\/\/\S+$/.test(url)) return { error: "Base URL must start with http:// or https://." };
  if (!key && !p.keyOptional && !configured) return { error: "Paste the provider's API key." };
  if (key && key.length < 8) return { error: "That key looks too short." };
  const m = String(model || "").trim();
  if (m && !/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,199}$/.test(m)) return { error: "That model name looks off." };
  return { body: { provider: p.id, base_url: url || p.baseUrl, api_key: key, ...(m ? { model: m } : {}) } };
}

/** "qwen3:14b and 1 more served at http://127.0.0.1:11434 · on" */
export function localLine(v) {
  if (!v) return "";
  if (!v.available) return v.reason || "Local models are a desktop app feature.";
  const n = (v.served || []).length;
  const where = v.base || "";
  if (!v.enabled) return `Off. Daebot will not use a model on this computer${where ? ` (${where})` : ""}.`;
  if (!n) return `Nothing served at ${where} yet. Start Ollama, LM Studio or llama.cpp and pull a chat model, then Detect.`;
  const first = String(v.served[0]).replace(/^ollama\//, "");
  return `${n === 1 ? first : `${first} and ${n - 1} more`} served at ${where}. Press Use next to one and your chats run on it, on this computer, for free.`;
}

/** "Your own Postgres at db.example.com:5432/mind · set up, routing pending" or the cloud line. */
export function dbLine(p) {
  if (!p) return "";
  if (p.signed_out) return "Sign in with MIND to connect your own database.";
  if (!p.feature_available) return p.message || "Your own database is not available on MIND yet.";
  const db = p.db || {};
  if (db.mode !== "own" || !db.configured) return "Your MIND data lives in MIND Cloud. Connect your own Postgres to keep it on your database.";
  const where = `${db.host || "?"}:${db.port || 5432}${db.database ? `/${db.database}` : ""}`;
  const state = db.routing === "routed" ? "in use" : db.bootstrapped_at ? "set up, MIND will route to it when routing is switched on" : "saved";
  return `Your own Postgres at ${where}: ${state}.`;
}

export function dbFromForm({ host, port, database, user, password, ssl, passwordSet }) {
  const h = String(host || "").trim();
  if (!h) return { error: "Enter the database host." };
  if (/^(https?:)?\/\//.test(h)) return { error: "The host is a name or address, without http://." };
  const pt = String(port || "").trim();
  const n = pt === "" ? 5432 : Number(pt);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return { error: "Port must be between 1 and 65535." };
  const pw = String(password || "");
  if (!pw && !passwordSet) return { error: "Enter the database password." };
  const body = { host: h, port: n, ssl: SSL_MODES.some(([v]) => v === ssl) ? ssl : "require" };
  const d = String(database || "").trim(); if (d) body.database = d;
  const u = String(user || "").trim(); if (u) body.user = u;
  if (pw) body.password = pw;
  return { body };
}

export function initConnections({ json, h, notify, isHosted, onPick }) {
  const $ = (id) => document.getElementById(id);
  const modal = $("conn-modal"), closeBtn = $("conn-close"), open = $("am-conn");
  const hosts = { llm: $("conn-llm"), local: $("conn-local"), db: $("conn-db") };
  let isOpen = false, lastFocus = null;
  const gens = { llm: 0, local: 0, db: 0 }; // one in-flight generation per section: a close or a re-mount makes the older paint a no-op
  const fine = (t) => h("p", "drawer-fine", t);
  const fld = (label, el) => { const l = h("label", "cap-f"); l.append(h("span", "fld-label", label), el); return l; };
  const input = (type, placeholder, extra = {}) => { const i = h("input", "fld"); i.type = type; i.placeholder = placeholder; i.autocomplete = extra.autocomplete || "off"; i.spellcheck = false; if (extra.value !== undefined) i.value = extra.value; if (extra.label) i.setAttribute("aria-label", extra.label); return i; };
  const status = () => { const s = h("span", "inline-state"); s.setAttribute("role", "status"); s.setAttribute("aria-live", "polite"); return s; };
  const errText = (e) => (e && e.message && e.message !== "unauthorized" ? e.message : "Something went wrong.");

  // ---- Your AI (LLM connectors)
  async function mountLlm(host) {
    if (!host) return;
    const my = ++gens.llm;
    host.replaceChildren(fine("Loading…"));
    let st;
    try { st = await json("/byo-llm"); } catch (e) { host.replaceChildren(fine(`Could not load: ${errText(e)}`)); return; }
    if (my !== gens.llm || !isOpen) return;
    const providers = Array.isArray(st.providers) && st.providers.length ? st.providers : FALLBACK_PROVIDERS;
    const line = h("p", "cap-line", llmLine(st, providers));
    if (!st.feature_enabled) { host.replaceChildren(line); return; }
    const sel = h("select", "fld"); sel.setAttribute("aria-label", "Provider");
    for (const p of providers) { const o = h("option", "", p.label); o.value = p.id; sel.append(o); }
    sel.value = st.configured && providers.some((p) => p.id === st.provider) ? st.provider : providers[0].id;
    const url = input("url", "https://api.example.com/v1", { label: "Base URL", value: st.configured && st.base_url ? st.base_url : "" });
    const key = input("password", st.configured ? "Enter a new key to replace the saved one" : "API key", { label: "API key", autocomplete: "new-password" });
    const model = input("text", "Model id (optional), e.g. openai/gpt-5", { label: "Model", value: st.configured && st.model ? st.model : "" });
    const urlRow = fld("Base URL", url);
    const syncUrl = () => { const p = providers.find((x) => x.id === sel.value); urlRow.hidden = !(p && (p.needsUrl || sel.value === st.provider && st.base_url && st.base_url !== p.baseUrl)); if (p && !url.value && p.needsUrl) url.value = p.baseUrl || ""; key.placeholder = p && p.keyOptional ? "API key (optional for a local server)" : key.placeholder; };
    sel.addEventListener("change", () => { url.value = ""; syncUrl(); });
    syncUrl();
    const rows = h("div", "conn-rows"); rows.append(fld("Provider", sel), urlRow, fld("API key", key), fld("Model", model));
    const save = h("button", "btn-primary sm", st.configured ? "Save" : "Connect"); save.type = "button";
    const test = h("button", "btn-quiet sm", "Test key"); test.type = "button"; test.hidden = !st.configured;
    const clear = h("button", "btn-quiet sm", "Remove"); clear.type = "button"; clear.hidden = !st.configured;
    const state = status();
    const acts = h("div", "cap-acts"); acts.append(save, test, clear, state);
    host.replaceChildren(line, rows, acts, fine("Once saved, every model call from Daebot and MIND runs on your key and your provider bills you. The key is stored encrypted by MIND and never shown again. Remove it to go back to MIND's models."));
    const busy = (on) => { save.disabled = test.disabled = clear.disabled = on; };
    save.addEventListener("click", async () => {
      const r = llmFromForm({ provider: sel.value, baseUrl: urlRow.hidden ? "" : url.value, apiKey: key.value, model: model.value, configured: st.configured && sel.value === st.provider }, providers);
      if (r.error) { state.textContent = r.error; return; }
      if (!r.body.api_key && st.configured && sel.value === st.provider) { state.textContent = "Paste the new key, or leave the saved one as it is."; return; }
      busy(true); state.textContent = "Saving…";
      try { await json("/byo-llm", { method: "POST", body: JSON.stringify(r.body) }); key.value = ""; notify("Your AI key is saved. Daebot now runs on it."); await mountLlm(host); }
      catch (e) { state.textContent = errText(e); busy(false); }
    });
    test.addEventListener("click", async () => {
      busy(true); state.textContent = "Testing…";
      try { const t = await json("/byo-llm/test", { method: "POST", body: "{}" }); state.textContent = t.ok ? `Key accepted. ${t.reason || ""}`.trim() : `Key not accepted. ${t.reason || ""}`.trim(); }
      catch (e) { state.textContent = errText(e); }
      busy(false);
    });
    clear.addEventListener("click", async () => {
      busy(true); state.textContent = "Removing…";
      try { await json("/byo-llm", { method: "DELETE" }); notify("Your AI key is removed. Daebot runs on MIND's models again."); await mountLlm(host); }
      catch (e) { state.textContent = errText(e); busy(false); }
    });
  }

  // ---- Local model server
  async function mountLocal(host) {
    if (!host) return;
    const my = ++gens.local;
    host.replaceChildren(fine("Loading…"));
    let v;
    try { v = await json("/settings/local-llm"); } catch (e) { host.replaceChildren(fine(`Could not load: ${errText(e)}`)); return; }
    if (my !== gens.local || !isOpen) return;
    const line = h("p", "cap-line", localLine(v));
    if (!v.available) {
      const a = h("a", "btn-quiet sm", "Get the desktop app"); a.href = "/download/"; a.target = "_blank"; a.rel = "noopener";
      const acts = h("div", "cap-acts"); acts.append(a);
      host.replaceChildren(line, acts);
      return;
    }
    const sw = h("button", `u-switch${v.enabled ? " on" : ""}`); sw.type = "button"; sw.setAttribute("role", "switch"); sw.setAttribute("aria-checked", String(!!v.enabled)); sw.setAttribute("aria-label", "Use a model on this computer"); sw.append(h("i"));
    const swRow = h("div", "conn-switch"); swRow.append(h("span", "", "Use a model on this computer"), sw);
    const base = input("url", "http://127.0.0.1:11434", { label: "Server address", value: v.source === "panel" ? v.base : "" });
    base.placeholder = v.base || "http://127.0.0.1:11434";
    const model = h("select", "fld"); model.setAttribute("aria-label", "Model for light work");
    const o0 = h("option", "", "First served model"); o0.value = ""; model.append(o0);
    for (const id of v.served || []) { const n = String(id).replace(/^ollama\//, ""); const o = h("option", "", n); o.value = n; model.append(o); }
    if (v.model && !(v.served || []).some((id) => String(id).replace(/^ollama\//, "") === v.model)) { const o = h("option", "", `${v.model} (not served now)`); o.value = v.model; model.append(o); }
    model.value = v.model || "";
    const rows = h("div", "conn-rows"); rows.append(fld("Server address (Ollama, LM Studio, llama.cpp)", base), fld("Model the router sends light work to (automatic)", model));
    const detect = h("button", "btn-quiet sm", "Detect"); detect.type = "button";
    const save = h("button", "btn-primary sm", "Save"); save.type = "button";
    const state = status();
    const acts = h("div", "cap-acts"); acts.append(detect, save, state);
    // The models served right now, each with a Use button: one press and this chat and new chats run on it (the same rule as the model menu).
    const srv = h("div", "conn-served");
    if ((v.served || []).length && v.enabled) {
      srv.append(h("p", "fld-label", "Chat on a model on this computer"));
      for (const id of v.served) {
        const row = h("div", "conn-served-row");
        const use = h("button", "btn-quiet sm", "Use"); use.type = "button"; use.dataset.model = String(id); use.setAttribute("aria-label", `Use ${String(id).replace(/^ollama\//, "")} for your chats`);
        use.addEventListener("click", async () => {
          if (!onPick) return;
          use.disabled = true; state.textContent = "Switching…";
          try { if (await onPick(String(id))) { state.textContent = ""; setOpen(false); } else state.textContent = "Could not switch. Press Detect, then try again."; }
          catch (e) { state.textContent = errText(e); }
          use.disabled = false;
        });
        row.append(h("span", "conn-served-name", String(id).replace(/^ollama\//, "")), use);
        srv.append(row);
      }
    }
    host.replaceChildren(line, swRow, srv, rows, acts, fine("Leave the address empty for the default (OLLAMA_HOST, else 127.0.0.1:11434). LM Studio's server is usually 127.0.0.1:1234. Served models are also in the model menu, under \"This computer\"."));
    const busy = (on) => { detect.disabled = save.disabled = sw.disabled = on; };
    async function put(body) {
      busy(true); state.textContent = "Saving…";
      try { await json("/settings/local-llm", { method: "PUT", body: JSON.stringify(body) }); notify("Local model server saved."); await mountLocal(host); }
      catch (e) { state.textContent = errText(e); busy(false); }
    }
    sw.addEventListener("click", () => void put({ enabled: sw.getAttribute("aria-checked") !== "true" }));
    detect.addEventListener("click", async () => {
      busy(true); state.textContent = "Looking…";
      try { const r = await json("/settings/local-llm/detect", { method: "POST", body: JSON.stringify({ base: base.value.trim() }) }); state.textContent = r.message || (r.ok ? "Found." : "Nothing there."); if (r.ok) { model.replaceChildren(o0); for (const id of r.served) { const n = String(id).replace(/^ollama\//, ""); const o = h("option", "", n); o.value = n; model.append(o); } } }
      catch (e) { state.textContent = errText(e); }
      busy(false);
    });
    save.addEventListener("click", () => void put({ base: base.value.trim() || null, model: model.value || null, enabled: true }));
  }

  // ---- Your database
  async function mountDb(host) {
    if (!host) return;
    const my = ++gens.db;
    host.replaceChildren(fine("Loading…"));
    let p;
    try { p = await json("/bridges"); } catch (e) { host.replaceChildren(fine(`Could not load: ${errText(e)}`)); return; }
    if (my !== gens.db || !isOpen) return;
    const line = h("p", "cap-line", dbLine(p));
    if (p.signed_out || !p.feature_available) { host.replaceChildren(line); return; }
    const db = p.db || {};
    const own = db.mode === "own" && db.configured;
    const hostI = input("text", "db.example.com", { label: "Host", value: own ? db.host || "" : "" });
    const portI = input("text", "5432", { label: "Port", value: own && db.port ? String(db.port) : "" }); portI.inputMode = "numeric";
    const dbI = input("text", "postgres", { label: "Database", value: own ? db.database || "" : "" });
    const userI = input("text", "postgres", { label: "User", value: own ? db.user || "" : "" });
    const pwI = input("password", own && db.password_set ? "password saved" : "Database password", { label: "Password", autocomplete: "new-password" });
    const ssl = h("select", "fld"); ssl.setAttribute("aria-label", "SSL mode");
    for (const [val, t] of SSL_MODES) { const o = h("option", "", t); o.value = val; ssl.append(o); }
    ssl.value = own && SSL_MODES.some(([val]) => val === db.ssl) ? db.ssl : "require";
    const rows = h("div", "conn-rows two"); rows.append(fld("Host", hostI), fld("Port", portI), fld("Database", dbI), fld("User", userI), fld("Password", pwI), fld("SSL mode", ssl));
    const test = h("button", "btn-quiet sm", "Test connection"); test.type = "button";
    const save = h("button", "btn-primary sm", own ? "Save & set up again" : "Save & set up"); save.type = "button";
    const verify = h("button", "btn-quiet sm", "Verify routing"); verify.type = "button"; verify.hidden = !own;
    const remove = h("button", "btn-quiet sm", "Remove"); remove.type = "button"; remove.hidden = !own;
    const state = status();
    const acts = h("div", "cap-acts"); acts.append(test, save, verify, remove, state);
    const extra = h("p", "drawer-fine", own && db.bootstrapped_at ? `Schema ${db.schema || "mind_user"} is set up${db.pgvector ? " with vector search" : ""}. ${db.routing === "routed" ? "MIND reads and writes your data there." : "MIND will read and write there once routing is switched on for your account."}` : "");
    host.replaceChildren(line, rows, acts, extra, fine("Daebot's memory is your MIND. Connect a Postgres you run (pgvector is set up for you) and MIND keeps your knowledge graph on it. Test first; Save creates MIND's tables in a schema of their own. The password goes to MIND encrypted and is never shown again."));
    const busy = (on) => { test.disabled = save.disabled = verify.disabled = remove.disabled = on; };
    const form = () => dbFromForm({ host: hostI.value, port: portI.value, database: dbI.value, user: userI.value, password: pwI.value, ssl: ssl.value, passwordSet: own && db.password_set });
    test.addEventListener("click", async () => {
      const r = form(); if (r.error) { state.textContent = r.error; return; }
      busy(true); state.textContent = "Connecting…";
      try { const t = await json("/bridges/db/test", { method: "POST", body: JSON.stringify(r.body) }); state.textContent = t.ok ? `Connected in ${t.latency_ms ?? "?"} ms. ${t.pgvector ? "pgvector is ready." : "pgvector is not installed yet; Save will try to enable it."}` : `Could not connect. ${t.error || ""}`.trim(); }
      catch (e) { state.textContent = errText(e); }
      busy(false);
    });
    save.addEventListener("click", async () => {
      const r = form(); if (r.error) { state.textContent = r.error; return; }
      busy(true); state.textContent = "Setting up…";
      try { const out = await json("/bridges/db", { method: "PUT", body: JSON.stringify(r.body) }); if (out.feature_available === false) { state.textContent = out.message || "Not available yet."; busy(false); return; } pwI.value = ""; notify("Your database is connected and set up."); await mountDb(host); }
      catch (e) { state.textContent = errText(e); busy(false); }
    });
    verify.addEventListener("click", async () => {
      busy(true); state.textContent = "Verifying…";
      try { const out = await json("/bridges/db/verify-routing", { method: "POST", body: "{}" }); state.textContent = out.routing_check && out.routing_check.ok ? "Rows written and read back on your database." : `Routing check failed. ${(out.routing_check && out.routing_check.error) || ""}`.trim(); }
      catch (e) { state.textContent = errText(e); }
      busy(false);
    });
    remove.addEventListener("click", async () => {
      if (remove.dataset.sure !== "1") { remove.dataset.sure = "1"; remove.textContent = "Remove, really"; state.textContent = "Click again to disconnect your database. Your data on it stays; MIND goes back to MIND Cloud."; return; }
      busy(true); state.textContent = "Removing…";
      try { await json("/bridges/db", { method: "DELETE" }); notify("Your database is disconnected."); await mountDb(host); }
      catch (e) { state.textContent = errText(e); busy(false); }
    });
  }

  function setOpen(on) {
    if (!modal) return;
    isOpen = on; modal.hidden = !on;
    if (on) { lastFocus = document.activeElement; void mountLlm(hosts.llm); void mountLocal(hosts.local); void mountDb(hosts.db); if (closeBtn) closeBtn.focus(); }
    else { gens.llm++; gens.local++; gens.db++; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
  }
  if (open) open.addEventListener("click", () => setOpen(true));
  if (closeBtn) closeBtn.addEventListener("click", () => setOpen(false));
  if (modal) modal.addEventListener("mousedown", (e) => { if (e.target === modal) setOpen(false); });
  document.addEventListener("keydown", (e) => { if (isOpen && e.key === "Escape") { e.preventDefault(); setOpen(false); } });
  void isHosted;
  return { open: () => setOpen(true), close: () => setOpen(false) };
}
