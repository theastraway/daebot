// The usage line under the name in the account menu, its detail, and the one-click Additional usage switch.
//   GET /usage            -> { source: "mind", planName, percentLeft, resetAt, state, additional } | { source: "own-key" } | { source: "owner" } | { error }
//   PUT /usage/additional -> the same view, after MIND has changed the switch
// DOM is built with textContent only. Pure helpers are exported for tests. Usage language only: never credits.

/** "Nov 1" for an ISO date, or "" when there is none. */
export function resetLabel(iso, locale) {
  const t = Date.parse(iso || "");
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleDateString(locale, { month: "short", day: "numeric" });
}

/** The one line under the name. */
export function usageLine(u, locale) {
  if (!u) return "";
  if (u.source === "own-key") return "Using your own API key";
  if (u.source === "owner") return "Owner access";
  if (u.error) return "Usage unavailable";
  const reset = resetLabel(u.resetAt, locale);
  const parts = [u.planName];
  if (u.state === "unlimited") parts.push("Unlimited");
  else if (u.percentLeft === null || u.percentLeft === undefined) parts.push("Usage billed as you go");
  else if (u.state === "empty") parts.push(u.additional?.active || u.additional?.automatic ? "Past your limit" : "Limit reached");
  else parts.push(`${u.percentLeft}% left`);
  if (reset && u.state !== "unlimited" && u.percentLeft !== null && u.percentLeft !== undefined) parts.push(`resets ${reset}`);
  return parts.join(" · ");
}

/** The bar: width in percent, or null when there is nothing to measure. */
export function barFor(u) {
  if (!u || u.source !== "mind" || u.error || u.state === "unlimited" || typeof u.percentLeft !== "number") return null;
  return { pct: Math.max(0, Math.min(100, u.percentLeft)), tone: u.state === "empty" ? "empty" : u.state === "low" ? "low" : "ok" };
}

/** The detail rows (Used / Left / Resets). */
export function detailRows(u, locale) {
  if (!u || u.source !== "mind" || u.error || typeof u.percentLeft !== "number") return [];
  const rows = [["Used", `${100 - u.percentLeft}%`], ["Left", `${u.percentLeft}%`]];
  const reset = resetLabel(u.resetAt, locale);
  if (reset) rows.push(["Resets", reset]);
  return rows;
}

/**
 * The Additional usage row. { show, on, canToggle, note }:
 *   on + canToggle  : the switch, flipping it asks MIND
 *   automatic       : the plan already keeps going past its limit and there is no switch to flip
 *   neither         : nothing to flip (free plan, or MIND has not enabled it yet); the note says which
 * MIND's own price line is shown as it came; if MIND sent none, no price is shown.
 */
export function extraState(u) {
  if (!u || u.source !== "mind" || u.error || !u.additional) return { show: false, on: false, canToggle: false, note: "" };
  const a = u.additional;
  if (a.automatic) return { show: true, on: true, canToggle: false, note: "On for your plan. Usage past your limit is billed as you go." };
  if (a.available) {
    const price = a.rateNote ? ` ${a.rateNote}` : "";
    return a.enabled
      ? { show: true, on: true, canToggle: true, note: `On. You keep going past your plan limit.${price}` }
      : { show: true, on: false, canToggle: true, note: `Off. Usage stops at your plan limit.${a.rateNote ? ` Turn on to keep going. ${a.rateNote}` : ""}` };
  }
  return { show: true, on: false, canToggle: false, note: u.plan === "free" ? "Off. Paid plans can keep going past the limit." : "Not available on your plan yet." };
}

export function initUsage({ json, notify, locale }) {
  const $ = (id) => document.getElementById(id);
  const box = $("usage"), head = $("usage-head"), line = $("usage-line"), bar = $("usage-bar"), fill = $("usage-fill");
  const detail = $("usage-detail"), rows = $("usage-rows"), extra = $("usage-extra"), sw = $("usage-switch"), note = $("usage-extra-note"), link = $("plan-link");
  if (!box || !head || !sw) return { refresh() {}, view: () => null };
  let view = null, open = false, busy = false;

  function paint() {
    const u = view;
    const t = usageLine(u, locale);
    $("am-sub").hidden = !!t;
    box.hidden = !t;
    line.textContent = t;
    const b = barFor(u);
    bar.hidden = !b;
    bar.classList.toggle("low", !!b && b.tone === "low");
    bar.classList.toggle("empty", !!b && b.tone === "empty");
    if (b) { fill.style.width = `${b.pct}%`; bar.setAttribute("aria-valuenow", String(b.pct)); }
    const r = detailRows(u, locale);
    rows.replaceChildren(...r.map(([k, v]) => { const d = document.createElement("div"); const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = k; dd.textContent = v; d.append(dt, dd); return d; }));
    rows.hidden = !r.length;
    const e = extraState(u);
    extra.hidden = !e.show;
    sw.setAttribute("aria-checked", String(e.on));
    sw.disabled = !e.canToggle || busy;
    sw.classList.toggle("on", e.on);
    note.textContent = e.note;
    let href = "";
    try { const m = new URL(u?.manageUrl || "https://m-i-n-d.ai"); if (m.protocol === "https:") href = m.href; } catch { /* no link */ }
    link.hidden = !(u && u.source === "mind" && !u.error && href);
    if (href) link.href = href;
    const expandable = !!(u && u.source === "mind" && !u.error);
    head.disabled = !expandable;
    head.classList.toggle("static", !expandable);
    if (!expandable) setOpen(false);
    head.title = t;
  }
  function setOpen(on) { open = on; detail.hidden = !on; head.setAttribute("aria-expanded", String(on)); }
  head.addEventListener("click", () => setOpen(!open));
  setOpen(false);

  async function refresh() {
    try { view = await json("/usage"); } catch { view = view?.source === "mind" && !view.error ? view : { source: "mind", error: "unavailable" }; }
    paint();
  }
  sw.addEventListener("click", async () => {
    const e = extraState(view);
    if (!e.canToggle || busy) return;
    busy = true; paint();
    try { view = await json("/usage/additional", { method: "PUT", body: JSON.stringify({ enabled: !e.on }) }); }
    catch (err) { notify(err?.message || "Could not change Additional usage."); }
    busy = false; paint();
  });
  return { refresh, view: () => view };
}
