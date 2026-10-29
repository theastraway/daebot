// Routines section of the bot settings: the bot's routines (on a clock or when something happens), the built-in Heartbeat, Run now,
// on/off, and the Add / Edit form: "How often" with a real time picker, day buttons and a monthly day; one "Weekdays only" switch and
// optional active hours that work with every timing and every trigger; the trigger list comes from the server (only what this
// deployment can really detect); a plain-words summary and the next three runs, in the routine's time zone.
// DOM is built with createElement + textContent only. The pure helpers are exported and unit tested.

export const PRESETS = [
  { id: "m15", label: "Every 15 minutes" },
  { id: "m30", label: "Every 30 minutes" },
  { id: "hourly", label: "Every hour" },
  { id: "nhours", label: "Every few hours" },
  { id: "daily", label: "Every day" },
  { id: "multi", label: "Several times a day" },
  { id: "weekly", label: "Weekly, on chosen days" },
  { id: "monthly", label: "Monthly, on a day" },
  { id: "minutes", label: "Every N minutes" },
  { id: "custom", label: "Custom (advanced, cron)" },
];
export const HOUR_STEPS = [2, 3, 4, 6, 8, 12];
export const DAYS = [{ v: 1, t: "Mon" }, { v: 2, t: "Tue" }, { v: 3, t: "Wed" }, { v: 4, t: "Thu" }, { v: 5, t: "Fri" }, { v: 6, t: "Sat" }, { v: 0, t: "Sun" }];

const two = (n) => String(n).padStart(2, "0");
const hm = (time) => {
  const [hh, mm] = String(time || "09:00").split(":").map((x) => Math.max(0, Number(x) || 0));
  return [Math.min(23, hh), Math.min(59, mm)];
};

/** The 5-field expression a preset stands for ("" when the choice is incomplete, like a week with no day picked). */
export function expressionFor(preset, p = {}) {
  const n = Math.min(59, Math.max(1, Number(p.n) || 15));
  const minute = Math.min(59, Math.max(0, Number(p.minute) || 0));
  const [hh, mm] = hm(p.time);
  if (preset === "m15") return "*/15 * * * *";
  if (preset === "m30") return "*/30 * * * *";
  if (preset === "minutes") return `*/${n} * * * *`;
  if (preset === "hourly") return `${minute} * * * *`;
  if (preset === "nhours") return `${minute} */${HOUR_STEPS.includes(Number(p.hours)) ? Number(p.hours) : 2} * * *`;
  if (preset === "daily") return `${mm} ${hh} * * *`;
  if (preset === "multi") {
    const times = [...new Set((p.times || []).filter(Boolean).map((t) => hm(t)).map(([h, m]) => h * 60 + m))].sort((a, b) => a - b).slice(0, 12);
    return times.map((t) => `${t % 60} ${Math.floor(t / 60)} * * *`).join(";");
  }
  if (preset === "weekly") {
    const days = [...new Set((p.days || []).map(Number).filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b);
    return days.length ? `${mm} ${hh} * * ${days.join(",")}` : "";
  }
  if (preset === "monthly") return `${mm} ${hh} ${Math.min(31, Math.max(1, Number(p.dom) || 1))} * *`;
  if (preset === "weekdays") return `${mm} ${hh} * * 1-5`;   // older callers
  return String(p.expression || "").trim();
}

const dayList = (field) => {
  const out = new Set();
  for (const part of field.split(",")) {
    const m = /^(\d)(?:-(\d))?$/.exec(part);
    if (!m) return null;
    const lo = Number(m[1]), hi = m[2] === undefined ? lo : Number(m[2]);
    if (hi < lo) return null;
    for (let d = lo; d <= hi; d++) out.add(d % 7);
  }
  return [...out].sort((x, y) => x - y);
};

/** Best guess of the preset + fields for an existing expression (so Edit opens on the friendly picker when it can). */
export function presetOf(expression) {
  const e = String(expression || "").trim();
  let m;
  if (e.includes(";")) {
    const times = [];
    for (const part of e.split(";")) {
      const x = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(part.trim());
      if (!x) return { preset: "custom", expression: e };
      times.push(`${two(Number(x[2]))}:${two(Number(x[1]))}`);
    }
    return { preset: "multi", times };
  }
  if (e === "*/15 * * * *") return { preset: "m15" };
  if (e === "*/30 * * * *") return { preset: "m30" };
  if ((m = /^\*\/(\d{1,2}) \* \* \* \*$/.exec(e))) return { preset: "minutes", n: Number(m[1]) };
  if ((m = /^(\d{1,2}) \* \* \* \*$/.exec(e))) return { preset: "hourly", minute: Number(m[1]) };
  if ((m = /^(\d{1,2}) \*\/(\d{1,2}) \* \* \*$/.exec(e)) && HOUR_STEPS.includes(Number(m[2]))) return { preset: "nhours", minute: Number(m[1]), hours: Number(m[2]) };
  if ((m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(e))) return { preset: "daily", time: `${two(Number(m[2]))}:${two(Number(m[1]))}` };
  if ((m = /^(\d{1,2}) (\d{1,2}) \* \* ([0-7,\-]+)$/.exec(e))) { const days = dayList(m[3]); if (days && days.length) return { preset: "weekly", time: `${two(Number(m[2]))}:${two(Number(m[1]))}`, days }; }
  if ((m = /^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \*$/.exec(e))) return { preset: "monthly", time: `${two(Number(m[2]))}:${two(Number(m[1]))}`, dom: Number(m[3]) };
  return { preset: "custom", expression: e };
}

/** The filter the form describes: weekdays switch + optional active hours. null = nothing restricted. */
export function filterOf({ weekdays, windowOn, from, to }) {
  const f = {};
  if (weekdays) f.weekdays = true;
  if (windowOn && from && to) { f.from = from; f.to = to; }
  return f.weekdays || f.from ? f : null;
}

const words12 = (t) => { const [h, m] = hm(t); return `${h % 12 === 0 ? 12 : h % 12}${m ? ":" + two(m) : ""} ${h < 12 ? "AM" : "PM"}`; };
/** "Weekdays · 9 AM–5 PM" for the filter alone (what a trigger shows; a clock gets the whole summary from the server). */
export function filterText(f) {
  if (!f) return "";
  return [f.weekdays ? "Weekdays" : "", f.from && f.to ? `${words12(f.from)}–${words12(f.to)}` : ""].filter(Boolean).join(" · ");
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

/** The status line of a polled trigger: how often it looks, when it last looked, or why the look failed. */
export function pollText(r, ago) {
  const every = r.trigger && r.trigger.every;
  if (!every || !r.enabled) return "";
  const p = r.poll || {};
  const cadence = every === 60 ? "every hour" : `every ${every} minutes`;
  if (p.error) return `Looks ${cadence}. Last look failed: ${p.error}`;
  if (!p.lastPollAt) return `Looks ${cadence}. First look is coming up.`;
  return `Looks ${cadence}. Last look ${ago(p.lastPollAt)}.`;
}

const tzList = () => {
  try { return typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []; } catch { return []; }
};
export const tzName = (tz) => String(tz || "").split("/").pop().replace(/_/g, " ");

export function initRoutines(ctx) {
  const { json, api, h, ago, notify, confirmDialog, openThread } = ctx;
  const $ = (id) => document.getElementById(id);
  const el = {
    sec: $("bd-routines"), list: $("rt-list"), add: $("rt-add"), state: $("rt-state"), form: $("rt-form"),
    name: $("rt-name"), prompt: $("rt-prompt"), type: $("rt-type"), clockBox: $("rt-clock"), trigBox: $("rt-trig"),
    preset: $("rt-preset"), n: $("rt-n"), hours: $("rt-hours"), minute: $("rt-minute"), time: $("rt-time"), times: $("rt-times"), addTime: $("rt-addtime"),
    days: $("rt-days"), dom: $("rt-dom"), expr: $("rt-expr"), tz: $("rt-tz"), tzNote: $("rt-tznote"),
    weekdays: $("rt-weekdays"), windowOn: $("rt-window-on"), from: $("rt-from"), to: $("rt-to"), windowBox: $("rt-window"),
    preview: $("rt-preview"), pvSummary: $("rt-pv-summary"), pvNext: $("rt-pv-next"),
    trig: $("rt-trigger"), trigDesc: $("rt-trig-desc"), trigFields: $("rt-trig-fields"),
    save: $("rt-save"), cancel: $("rt-cancel"), err: $("rt-err"), title: $("rt-form-title"),
  };
  if (!el.sec) return null;
  const st = { bot: "", routines: [], running: new Set(), editing: "", timer: 0, pv: 0, loadSeq: 0, catalog: [], catalogSeq: 0, days: new Set([1, 2, 3, 4, 5]), pvT: 0 };
  const userTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York"; } catch { return "America/New_York"; } })();
  const fmt = (ms, tz) => {
    try { return new Date(ms).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz || undefined, timeZoneName: "short" }); }
    catch { return new Date(ms).toLocaleString(); }
  };

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
    const when = h("div", "rt-when", r.kind === "timed" ? r.summary || r.when || "" : r.when || "");
    if (r.timing && r.timing.tz) when.append(h("span", "rt-tzlabel", ` · ${tzName(r.timing.tz)}`));
    li.append(when);
    if (r.kind === "trigger") {
      const ft = filterText(r.trigger && r.trigger.filter);
      if (ft) li.append(h("div", "rt-next", `Only ${ft}${r.trigger.tz ? ` (${tzName(r.trigger.tz)})` : ""}`));
      const pt = pollText(r, ago);
      if (pt) { const d = h("div", "rt-next", pt); if (r.poll && r.poll.error) d.classList.add("warn"); li.append(d); }
    }
    const nx = nextRunText(r, (ms) => fmt(ms, r.timing && r.timing.tz));
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

  // ---------------------------------------------------------------- trigger catalog (what this deployment can really detect)
  async function loadCatalog() {
    const seq = ++st.catalogSeq;
    try {
      const r = await json("/routines/triggers");
      if (seq !== st.catalogSeq) return;
      st.catalog = Array.isArray(r.triggers) ? r.triggers : [];
    } catch { st.catalog = st.catalog.length ? st.catalog : []; }
    fillTriggerSelect();
  }
  const GROUPS = { messages: "Messages", daebot: "Daebot", web: "Web", mind: "Your MIND and mail", desktop: "This computer" };
  function fillTriggerSelect(keep) {
    const cur = keep || el.trig.value;
    el.trig.replaceChildren();
    for (const g of Object.keys(GROUPS)) {
      const items = st.catalog.filter((t) => t.group === g);
      if (!items.length) continue;
      const og = document.createElement("optgroup"); og.label = GROUPS[g];
      for (const t of items) { const o = document.createElement("option"); o.value = t.type; o.textContent = t.label; og.append(o); }
      el.trig.append(og);
    }
    if (cur && [...el.trig.options].some((o) => o.value === cur)) el.trig.value = cur;
  }
  const def = () => st.catalog.find((t) => t.type === el.trig.value);
  function renderTriggerFields(values = {}) {
    const d = def();
    el.trigDesc.textContent = d ? d.description : "";
    el.trigFields.replaceChildren();
    if (!d) return;
    for (const f of d.fields) {
      const wrap = document.createElement("div");
      const id = `rt-f-${f.key}`;
      const lab = h("label", "fld-label", f.label); lab.htmlFor = id;
      let inp;
      if (f.kind === "select") {
        inp = document.createElement("select"); inp.className = "fld";
        for (const o of f.options || []) { const op = document.createElement("option"); op.value = o.value; op.textContent = o.label; inp.append(op); }
        inp.value = values[f.key] !== undefined ? String(values[f.key]) : f.default || (f.options && f.options[0] && f.options[0].value) || "";
      } else {
        inp = document.createElement("input"); inp.type = "text"; inp.className = "fld"; inp.spellcheck = false; inp.placeholder = f.placeholder || "";
        inp.value = values[f.key] !== undefined ? String(values[f.key]) : "";
      }
      inp.id = id; inp.dataset.key = f.key;
      inp.addEventListener("input", schedulePreview);
      wrap.append(lab, inp);
      if (f.help) wrap.append(h("p", "drawer-fine", f.help));
      el.trigFields.append(wrap);
    }
  }
  function triggerValues() {
    const out = { type: el.trig.value };
    for (const inp of el.trigFields.querySelectorAll("[data-key]")) {
      const v = inp.value.trim();
      if (v !== "") out[inp.dataset.key] = inp.tagName === "SELECT" && /^\d+$/.test(v) ? Number(v) : v;
    }
    return out;
  }

  // ---------------------------------------------------------------- clock form
  function timeRow(value) {
    const r = h("div", "rt-timerow");
    const t = document.createElement("input"); t.type = "time"; t.className = "fld rt-timeinp"; t.value = value || "09:00"; t.setAttribute("aria-label", "Time of day");
    t.addEventListener("input", schedulePreview);
    const x = h("button", "btn-quiet rt-btn", "Remove"); x.type = "button";
    x.addEventListener("click", () => { if (el.times.children.length > 1) { r.remove(); schedulePreview(); } });
    r.append(t, x);
    return r;
  }
  const timesNow = () => [...el.times.querySelectorAll("input")].map((i) => i.value).filter(Boolean);
  function dayButtons() {
    el.days.replaceChildren(...DAYS.map((d) => {
      const b = h("button", "rt-day", d.t); b.type = "button"; b.dataset.d = String(d.v);
      b.setAttribute("aria-pressed", st.days.has(d.v) ? "true" : "false");
      b.addEventListener("click", () => { if (st.days.has(d.v)) st.days.delete(d.v); else st.days.add(d.v); b.setAttribute("aria-pressed", st.days.has(d.v) ? "true" : "false"); schedulePreview(); });
      return b;
    }));
  }
  function currentExpression() {
    return expressionFor(el.preset.value, { n: el.n.value, hours: el.hours.value, minute: el.minute.value, time: el.time.value, times: timesNow(), days: [...st.days], dom: el.dom.value, expression: el.expr.value });
  }
  const windowIncomplete = () => el.windowOn.checked && !(el.from.value && el.to.value);
  const currentFilter = () => filterOf({ weekdays: el.weekdays.checked, windowOn: el.windowOn.checked, from: el.from.value, to: el.to.value });

  const SHOW = { hours: ["nhours"], n: ["minutes"], minute: ["hourly", "nhours"], time: ["daily", "weekly", "monthly"], multi: ["multi"], days: ["weekly"], dom: ["monthly"], custom: ["custom"] };
  function syncVisible() {
    const timed = el.type.value === "timed";
    el.clockBox.hidden = !timed; el.trigBox.hidden = timed;
    const p = el.preset.value;
    for (const sub of el.clockBox.querySelectorAll("[data-for]")) sub.hidden = !(SHOW[sub.dataset.for] || []).includes(p);
    el.windowBox.hidden = !el.windowOn.checked;
    el.tzNote.textContent = `Times are in ${tzName(el.tz.value.trim() || userTz)} time.`;
    const tzNeeded = timed || !!currentFilter();
    el.tz.closest(".rt-tzbox").hidden = !tzNeeded;
    if (!timed) renderTriggerDesc();
    schedulePreview();
  }
  function renderTriggerDesc() {
    const d = def();
    el.trigDesc.textContent = d ? d.description : "";
  }
  function schedulePreview() {
    clearTimeout(st.pvT);
    const timed = el.type.value === "timed";
    el.tzNote.textContent = `Times are in ${tzName(el.tz.value.trim() || userTz)} time.`;
    if (!timed) {
      const f = currentFilter();
      el.preview.classList.toggle("warn", windowIncomplete());
      if (windowIncomplete()) { el.pvSummary.textContent = "Pick a start and an end time for the active hours."; el.pvNext.replaceChildren(); return; }
      el.pvSummary.textContent = f ? `Reacts only: ${filterText(f)}` : "";
      el.pvNext.replaceChildren();
      return;
    }
    st.pvT = setTimeout(async () => {
      const seq = ++st.pv, expression = currentExpression(), tz = el.tz.value.trim() || userTz;
      if (windowIncomplete()) { el.preview.classList.add("warn"); el.pvSummary.textContent = "Pick a start and an end time for the active hours."; el.pvNext.replaceChildren(); return; }
      if (!expression) { el.preview.classList.add("warn"); el.pvSummary.textContent = el.preset.value === "weekly" ? "Pick at least one day." : "Add a time."; el.pvNext.replaceChildren(); return; }
      try {
        const r = await json("/routines/preview", { method: "POST", body: JSON.stringify({ expression, tz, filter: currentFilter() }) });
        if (seq !== st.pv) return;
        el.preview.classList.toggle("warn", !r.ok);
        if (!r.ok) { el.pvSummary.textContent = r.error; el.pvNext.replaceChildren(); return; }
        el.pvSummary.textContent = r.summary || r.human;
        el.pvNext.replaceChildren(...(r.next.length ? [h("div", "rt-pv-h", "Next runs"), ...r.next.map((ms) => h("div", "rt-pv-run", fmt(ms, tz)))] : [h("div", "rt-pv-h", "No run in the next few years with these limits.")]));
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
    const t = r && r.timing ? r.timing : { expression: "0 * * * *", tz: userTz, filter: null };
    const pr = presetOf(t.expression);
    el.preset.value = pr.preset;
    el.n.value = pr.n || 15; el.hours.value = String(pr.hours || 2); el.minute.value = pr.minute || 0; el.time.value = pr.time || "09:00";
    el.times.replaceChildren(...(pr.times && pr.times.length ? pr.times : ["09:00", "13:00"]).map(timeRow));
    st.days = new Set(pr.days || [1, 2, 3, 4, 5]); dayButtons();
    el.dom.value = pr.dom || 1; el.expr.value = t.expression;
    el.tz.value = (r && r.trigger && r.trigger.tz) || t.tz || userTz;
    const f = (r && r.kind === "trigger" ? r.trigger && r.trigger.filter : t.filter) || null;
    el.weekdays.checked = !!(f && f.weekdays); el.windowOn.checked = !!(f && f.from && f.to);
    el.from.value = (f && f.from) || "09:00"; el.to.value = (f && f.to) || "17:00";
    fillTriggerSelect(r && r.trigger ? r.trigger.type : "thread_message");
    renderTriggerFields(r && r.trigger ? r.trigger : {});
    el.trig.disabled = !!r;
    el.form.hidden = false; el.add.hidden = true;
    syncVisible();
    el.name.disabled ? el.preset.focus() : el.name.focus();
  }
  function closeForm() { el.form.hidden = true; el.add.hidden = false; st.editing = ""; }

  el.add.addEventListener("click", () => openForm(null));
  el.cancel.addEventListener("click", closeForm);
  el.addTime.addEventListener("click", () => { if (el.times.children.length < 12) { el.times.append(timeRow("17:00")); schedulePreview(); } });
  for (const n of [el.type, el.preset, el.windowOn, el.weekdays]) n.addEventListener("change", syncVisible);
  el.trig.addEventListener("change", () => { renderTriggerFields(); syncVisible(); });
  for (const n of [el.n, el.hours, el.minute, el.time, el.dom, el.expr, el.tz, el.from, el.to]) { n.addEventListener("input", schedulePreview); n.addEventListener("change", schedulePreview); }
  el.tz.addEventListener("input", () => { el.tzNote.textContent = `Times are in ${tzName(el.tz.value.trim() || userTz)} time.`; });
  el.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const timed = el.type.value === "timed";
    const body = {};
    const tz = el.tz.value.trim() || userTz;
    if (windowIncomplete()) { el.err.textContent = "Pick a start and an end time for the active hours."; el.err.hidden = false; return; }
    if (!st.editing) { body.name = el.name.value.trim(); body.prompt = el.prompt.value; body.kind = el.type.value; }
    else if (!el.name.disabled) { body.name = el.name.value.trim(); body.prompt = el.prompt.value; }
    if (timed) {
      const expression = currentExpression();
      if (!expression) { el.err.textContent = el.preset.value === "weekly" ? "Pick at least one day." : "Add a time."; el.err.hidden = false; return; }
      body.timing = { expression, tz, filter: currentFilter() };
    } else {
      const f = currentFilter();
      body.trigger = { ...triggerValues(), ...(f ? { filter: f, tz } : {}) };
    }
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
    open(botId) { st.bot = botId; st.routines = []; closeForm(); say(""); el.list.replaceChildren(h("div", "drawer-fine", "Loading…")); loadCatalog(); load(); },
    close() { clearTimeout(st.timer); st.loadSeq++; st.bot = ""; },
  };
}
