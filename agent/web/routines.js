// Routines section of the bot settings: the bot's routines (on a clock or when something happens), the built-in Heartbeat, Run now,
// on/off, and the Add / Edit form with friendly presets, a plain-words preview and the next runs.
// DOM is built with createElement + textContent only. The pure helpers are exported and unit tested.

export const PRESETS = [
  { id: "minutes", label: "Every few minutes" },
  { id: "hourly", label: "Every hour" },
  { id: "daily", label: "Every day at…" },
  { id: "weekdays", label: "Weekdays at…" },
  { id: "custom", label: "Custom (5 fields)" },
];
export const TRIGGERS = [
  { id: "webhook", label: "A web address is called (webhook)" },
  { id: "thread_message", label: "I message the bot in any of its threads" },
  { id: "bot_message", label: "Another bot talks to it" },
];

const two = (n) => String(n).padStart(2, "0");

/** The 5-field expression a preset stands for. `p`: { n, minute, time: "HH:MM" } */
export function expressionFor(preset, p = {}) {
  const [hh, mm] = String(p.time || "09:00").split(":").map((x) => Math.max(0, Number(x) || 0));
  const n = Math.min(59, Math.max(1, Number(p.n) || 15));
  const minute = Math.min(59, Math.max(0, Number(p.minute) || 0));
  if (preset === "minutes") return `*/${n} * * * *`;
  if (preset === "hourly") return `${minute} * * * *`;
  if (preset === "daily") return `${Math.min(59, mm)} ${Math.min(23, hh)} * * *`;
  if (preset === "weekdays") return `${Math.min(59, mm)} ${Math.min(23, hh)} * * 1-5`;
  return String(p.expression || "").trim();
}

/** Best guess of the preset + fields for an existing expression (so Edit opens on the friendly picker when it can). */
export function presetOf(expression) {
  const e = String(expression || "").trim();
  let m;
  if ((m = /^\*\/(\d{1,2}) \* \* \* \*$/.exec(e))) return { preset: "minutes", n: Number(m[1]) };
  if ((m = /^(\d{1,2}) \* \* \* \*$/.exec(e))) return { preset: "hourly", minute: Number(m[1]) };
  if ((m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(e))) return { preset: "daily", time: `${two(Number(m[2]))}:${two(Number(m[1]))}` };
  if ((m = /^(\d{1,2}) (\d{1,2}) \* \* 1-5$/.exec(e))) return { preset: "weekdays", time: `${two(Number(m[2]))}:${two(Number(m[1]))}` };
  return { preset: "custom", expression: e };
}

export function lastRunText(r, ago) {
  if (!r.lastRunAt) return "Has not run yet";
  const when = ago(r.lastRunAt);
  if (r.lastStatus === "running") return `Running now (started ${when})`;
  if (r.lastStatus === "idle") return `Checked ${when}: ${r.lastResult || "nothing to do"} (no model call)`;
  if (r.lastStatus === "error") return `Failed ${when}${r.lastResult ? `: ${r.lastResult}` : ""}`;
  if (r.lastStatus === "skipped") return `Skipped ${when}${r.lastResult ? `: ${r.lastResult}` : ""}`;
  return `Ran ${when}${r.lastResult ? `: ${r.lastResult}` : ""}`;
}

export function nextRunText(r, fmt) {
  if (!r.enabled) return "Off";
  if (r.nextRunAt) return `Next run ${fmt(r.nextRunAt)}`;
  return "";
}

const tzList = () => {
  try { return typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []; } catch { return []; }
};

export function initRoutines(ctx) {
  const { json, api, h, ago, notify, confirmDialog, openThread } = ctx;
  const $ = (id) => document.getElementById(id);
  const el = {
    sec: $("bd-routines"), list: $("rt-list"), add: $("rt-add"), state: $("rt-state"), form: $("rt-form"),
    name: $("rt-name"), prompt: $("rt-prompt"), type: $("rt-type"), clockBox: $("rt-clock"), trigBox: $("rt-trig"),
    preset: $("rt-preset"), n: $("rt-n"), minute: $("rt-minute"), time: $("rt-time"), expr: $("rt-expr"), tz: $("rt-tz"), preview: $("rt-preview"),
    trig: $("rt-trigger"), from: $("rt-from"), save: $("rt-save"), cancel: $("rt-cancel"), err: $("rt-err"), title: $("rt-form-title"),
  };
  if (!el.sec) return null;
  const st = { bot: "", routines: [], running: new Set(), editing: "", timer: 0, pv: 0, loadSeq: 0 };
  const fmt = (ms) => new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  const userTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York"; } catch { return "America/New_York"; } })();

  // time zone picker: a datalist keeps it typeable and short
  const dl = document.createElement("datalist"); dl.id = "rt-tz-list";
  for (const z of tzList()) { const o = document.createElement("option"); o.value = z; dl.append(o); }
  el.sec.append(dl);

  const say = (t, warn) => { el.state.textContent = t || ""; el.state.classList.toggle("warn", !!warn); };
  const base = () => `/bots/${encodeURIComponent(st.bot)}/routines`;

  async function load() {
    const id = st.bot, seq = ++st.loadSeq;
    if (!id) return;
    try {
      const r = await json(base());
      if (id !== st.bot || seq !== st.loadSeq) return;
      st.routines = Array.isArray(r.routines) ? r.routines : [];
      st.running = new Set(Array.isArray(r.running) ? r.running : []);
      render();
      clearTimeout(st.timer);
      if (st.routines.some((x) => x.lastStatus === "running" || st.running.has(x.id))) st.timer = setTimeout(load, 3000);
    } catch (e) { if (e.message !== "unauthorized") say("Could not load the routines.", true); }
  }

  function row(r) {
    const li = h("div", "rt-row"); li.dataset.id = r.id;
    const head = h("div", "rt-head");
    const nm = h("strong", "rt-name", r.name); head.append(nm);
    if (r.builtin) head.append(h("span", "rt-tag", "Built in"));
    const sw = h("label", "rt-switch"); const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!r.enabled;
    cb.setAttribute("aria-label", `${r.name} on or off`);
    sw.append(cb, h("span", "rt-switch-t", r.enabled ? "On" : "Off"));
    cb.addEventListener("change", async () => {
      cb.disabled = true;
      try { await json(`${base()}/${r.id}`, { method: "PATCH", body: JSON.stringify({ enabled: cb.checked }) }); say(cb.checked ? "Turned on." : "Turned off."); }
      catch (e) { cb.checked = !cb.checked; if (e.message !== "unauthorized") say("Could not change it.", true); }
      cb.disabled = false; load();
    });
    head.append(sw);
    li.append(head);
    li.append(h("div", "rt-when", r.when || ""));
    const nx = nextRunText(r, fmt);
    if (nx) li.append(h("div", "rt-next", nx));
    const last = h("div", "rt-last", lastRunText(r, ago)); li.append(last);
    if (r.kind === "trigger" && r.trigger && r.trigger.type === "webhook" && r.webhookUrl) {
      const u = h("div", "rt-url");
      const code = h("code", "rt-code", r.webhookUrl); code.title = "Anyone with this address can run the routine. Keep it private.";
      const cp = h("button", "btn-quiet rt-btn", "Copy"); cp.type = "button";
      cp.addEventListener("click", async () => { try { await navigator.clipboard.writeText(r.webhookUrl); cp.textContent = "Copied"; setTimeout(() => { cp.textContent = "Copy"; }, 1500); } catch { notify("Copy failed. Select the address and copy it."); } });
      const rot = h("button", "btn-quiet rt-btn", "New address"); rot.type = "button";
      rot.addEventListener("click", async () => {
        if (!(await confirmDialog({ title: "Make a new address?", body: "The old address stops working at once.", yes: "New address", danger: false }))) return;
        try { await json(`${base()}/${r.id}/rotate`, { method: "POST" }); say("New address made."); load(); } catch (e) { if (e.message !== "unauthorized") say("Could not make a new address.", true); }
      });
      u.append(code, cp, rot); li.append(u);
    }
    const acts = h("div", "rt-acts");
    const run = h("button", "btn-quiet rt-btn", st.running.has(r.id) || r.lastStatus === "running" ? "Running…" : "Run now"); run.type = "button";
    run.disabled = st.running.has(r.id) || r.lastStatus === "running";
    run.addEventListener("click", async () => {
      run.disabled = true; run.textContent = "Starting…"; say("");
      try { const res = await json(`${base()}/${r.id}/run`, { method: "POST" }); say(res.running ? "Running. The result lands in its thread." : "Done."); }
      catch (e) { if (e.message !== "unauthorized") say(/still going/.test(e.message) ? "It is already running." : "Could not start it.", true); }
      load();
    });
    acts.append(run);
    if (r.lastThreadId) {
      const open = h("button", "btn-quiet rt-btn", "Open thread"); open.type = "button";
      open.addEventListener("click", () => openThread({ id: r.lastThreadId, title: r.thread, bot: st.bot, surface: "routine" }));
      acts.append(open);
    }
    const ed = h("button", "btn-quiet rt-btn", "Edit"); ed.type = "button"; ed.addEventListener("click", () => openForm(r)); acts.append(ed);
    if (!r.builtin) {
      const del = h("button", "btn-quiet rt-btn rt-del", "Delete"); del.type = "button";
      del.addEventListener("click", async () => {
        if (!(await confirmDialog({ title: `Delete "${r.name}"?`, body: "It stops running. Its past runs stay in the thread.", yes: "Delete routine" }))) return;
        try { await json(`${base()}/${r.id}`, { method: "DELETE" }); say("Deleted."); } catch (e) { if (e.message !== "unauthorized") say("Could not delete it.", true); }
        load();
      });
      acts.append(del);
    }
    li.append(acts);
    return li;
  }

  function render() {
    el.list.replaceChildren(...st.routines.map(row));
  }

  // ---------------------------------------------------------------- form
  function currentExpression() {
    return expressionFor(el.preset.value, { n: el.n.value, minute: el.minute.value, time: el.time.value, expression: el.expr.value });
  }
  function syncVisible() {
    const timed = el.type.value === "timed";
    el.clockBox.hidden = !timed; el.trigBox.hidden = timed;
    const p = el.preset.value;
    el.n.parentElement.hidden = p !== "minutes";
    el.minute.parentElement.hidden = p !== "hourly";
    el.time.parentElement.hidden = p !== "daily" && p !== "weekdays";
    el.expr.parentElement.hidden = p !== "custom";
    el.from.parentElement.hidden = el.trig.value !== "bot_message";
    if (p !== "custom") el.expr.value = currentExpression();
    schedulePreview();
  }
  function schedulePreview() {
    clearTimeout(st.pvT);
    if (el.type.value !== "timed") { el.preview.textContent = ""; return; }
    st.pvT = setTimeout(async () => {
      const seq = ++st.pv, expression = currentExpression(), tz = el.tz.value.trim() || userTz;
      try {
        const r = await json("/routines/preview", { method: "POST", body: JSON.stringify({ expression, tz }) });
        if (seq !== st.pv) return;
        el.preview.classList.toggle("warn", !r.ok);
        el.preview.textContent = r.ok ? `Runs ${r.human}. Next: ${r.next.map(fmt).join(", ")}.` : r.error;
      } catch { /* the preview is a courtesy */ }
    }, 250);
  }
  function openForm(r) {
    st.editing = r ? r.id : "";
    el.title.textContent = r ? `Edit ${r.name}` : "Add a routine";
    el.err.hidden = true;
    const hb = r && r.builtin;
    el.name.value = r ? r.name : ""; el.prompt.value = r ? (r.prompt || "") : "";
    el.name.disabled = !!hb; el.prompt.disabled = !!hb; el.type.disabled = !!r;
    el.prompt.parentElement.hidden = !!hb;
    el.type.value = r ? r.kind : "timed";
    const t = r && r.timing ? r.timing : { expression: "0 9 * * 1-5", tz: userTz };
    const pr = presetOf(t.expression);
    el.preset.value = pr.preset; el.n.value = pr.n || 15; el.minute.value = pr.minute || 0; el.time.value = pr.time || "09:00"; el.expr.value = t.expression; el.tz.value = t.tz || userTz;
    el.trig.value = r && r.trigger ? r.trigger.type : "webhook"; el.from.value = r && r.trigger && r.trigger.from ? r.trigger.from : "";
    el.trig.disabled = !!r;
    el.form.hidden = false; el.add.hidden = true;
    syncVisible();
    el.name.disabled ? el.preset.focus() : el.name.focus();
  }
  function closeForm() { el.form.hidden = true; el.add.hidden = false; st.editing = ""; }

  el.add.addEventListener("click", () => openForm(null));
  el.cancel.addEventListener("click", closeForm);
  for (const n of [el.type, el.preset, el.trig]) n.addEventListener("change", syncVisible);
  for (const n of [el.n, el.minute, el.time, el.expr, el.tz]) n.addEventListener("input", syncVisible);
  el.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const timed = el.type.value === "timed";
    const body = {};
    if (!st.editing) { body.name = el.name.value.trim(); body.prompt = el.prompt.value; body.kind = el.type.value; }
    else if (!el.name.disabled) { body.name = el.name.value.trim(); body.prompt = el.prompt.value; }
    if (timed) body.timing = { expression: currentExpression(), tz: el.tz.value.trim() || userTz };
    else if (!st.editing) body.trigger = { type: el.trig.value, ...(el.trig.value === "bot_message" && el.from.value.trim() ? { from: el.from.value.trim() } : {}) };
    else if (el.trig.value === "bot_message") body.trigger = { type: "bot_message", ...(el.from.value.trim() ? { from: el.from.value.trim() } : {}) };
    el.save.disabled = true; el.err.hidden = true;
    try {
      const res = await api(st.editing ? `${base()}/${st.editing}` : base(), { method: st.editing ? "PATCH" : "POST", body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { el.err.textContent = out.message || "Could not save the routine."; el.err.hidden = false; el.save.disabled = false; return; }
      closeForm(); say("Saved."); load();
    } catch (err) { if (err.message !== "unauthorized") { el.err.textContent = "Could not save the routine."; el.err.hidden = false; } }
    el.save.disabled = false;
  });

  return {
    /** Show the routines of this bot. */
    open(botId) { st.bot = botId; st.routines = []; closeForm(); say(""); el.list.replaceChildren(h("div", "drawer-fine", "Loading…")); load(); },
    close() { clearTimeout(st.timer); st.loadSeq++; st.bot = ""; },
  };
}
