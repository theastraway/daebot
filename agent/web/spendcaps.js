// Spend caps: a cap for the whole account (Account menu > Spend caps) and one per bot (that bot's settings).
//   GET /spend-caps[?bot=id] -> { source: "mind", caps: { account, bots: {id: view}, effective, alert, reached } } | { source: "own-key" | "owner" } | { error }
//   PUT /spend-caps          -> the same, after MIND has saved the change. MIND enforces every cap in its LLM proxy before a call is made.
// A view is { cap: {usd, period, alertPct} | null, spentUsd, remainingUsd, pct, reached, alert, resetsAt }. Amounts are USD, never credits.
// DOM is built with createElement + textContent only. Pure helpers are exported for tests.

export const PERIODS = [["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"]];

/** $5, $0.25, $0.0042: whole dollars bare, otherwise at least two decimals. */
export function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "$0";
  if (Number.isInteger(n)) return `$${n}`;
  let s = n.toFixed(4).replace(/0+$/, "");
  if (s.split(".")[1].length < 2) s += "0";
  return `$${s}`;
}

export function resetLabel(iso, locale) {
  const t = Date.parse(iso || "");
  return Number.isNaN(t) ? "" : new Date(t).toLocaleDateString(locale, { month: "short", day: "numeric", timeZone: "America/New_York" });
}

/** "Spent $0.02 of $0.01 daily · resets Nov 12" or, with no cap, "Spent $0.02 this month · no cap". */
export function spendLine(v, locale) {
  if (!v) return "";
  if (!v.cap) return `Spent ${money(v.spentUsd)} this month · no cap`;
  const reset = resetLabel(v.resetsAt, locale);
  return `Spent ${money(v.spentUsd)} of ${money(v.cap.usd)} ${v.cap.period}${reset ? ` · resets ${reset}` : ""}`;
}

/** The bar: width in percent and tone, or null with no cap. */
export function barFor(v) {
  if (!v || !v.cap) return null;
  const pct = Math.max(0, Math.min(100, Math.round(v.pct ?? (v.spentUsd / v.cap.usd) * 100)));
  return { pct, tone: v.reached ? "empty" : v.alert ? "low" : "ok" };
}

/** The cap the form describes, or an error sentence. Empty amount = no cap (null). */
export function capFromForm({ usd, period, alertPct }) {
  const raw = String(usd ?? "").trim().replace(/^\$/, "");
  if (raw === "") return { cap: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { error: "Enter an amount above $0, or leave it empty for no cap." };
  if (n > 100000) return { error: "That amount is too large." };
  if (!PERIODS.some(([p]) => p === period)) return { error: "Pick daily, weekly or monthly." };
  const a = String(alertPct ?? "").trim().replace(/%$/, "");
  let alert = null;
  if (a !== "") { alert = Number(a); if (!Number.isFinite(alert) || alert < 1 || alert > 100) return { error: "The alert percent must be between 1 and 100." }; alert = Math.round(alert); }
  return { cap: { usd: n, period, alertPct: alert } };
}

/** The banner text for the account-wide state: reached beats the alert threshold. null when nothing to say. */
export function bannerText(caps) {
  if (!caps) return null;
  const parts = [["Your account", caps.account], ...Object.entries(caps.bots || {}).map(([, v]) => ["A bot", v])];
  const hit = parts.find(([, v]) => v && v.reached);
  if (hit) return `${hit[0]} reached its ${money(hit[1].cap.usd)} ${hit[1].cap.period} cap. Daebot has paused those chats. Raise the cap in Settings.`;
  const warn = parts.find(([, v]) => v && v.alert);
  if (warn) return `${warn[0]} has used ${Math.round(warn[1].pct ?? 0)}% of its ${money(warn[1].cap.usd)} ${warn[1].cap.period} cap.`;
  return null;
}

export function initSpendCaps({ json, h, notify, locale }) {
  const $ = (id) => document.getElementById(id);
  let last = null;

  async function load(bot) {
    const r = await json(`/spend-caps${bot ? `?bot=${encodeURIComponent(bot)}` : ""}`);
    return r;
  }
  function paintBanner(caps) {
    const box = $("cap-banner"); if (!box) return;
    const t = bannerText(caps);
    box.hidden = !t;
    box.classList.toggle("reached", !!caps && !!(caps.reached));
    $("cap-banner-text").textContent = t || "";
  }
  async function refresh() {
    try {
      const r = await load();
      last = r && r.caps ? r.caps : null;
      paintBanner(last);
    } catch { /* a failed read leaves the last banner as it was */ }
    return last;
  }

  /** One scope's editor (account or one bot) into `host`. */
  async function mount(host, { scope, botId }) {
    if (!host) return;
    host.replaceChildren(h("p", "drawer-fine", "Loading…"));
    let r;
    try { r = await load(botId); } catch (e) { host.replaceChildren(h("p", "drawer-fine", "Could not load the spend cap.")); return; }
    if (host.dataset.stale === "1") return;
    if (!r || !r.caps) {
      host.replaceChildren(h("p", "drawer-fine", r && r.source === "owner" ? "Spend caps apply to MIND accounts, not the owner access login." : r && r.source === "own-key" ? "You are using your own API key, so your provider's limits apply." : "Spend caps are unavailable right now."));
      return;
    }
    const view = scope === "bot" ? r.caps.bots[botId] || { cap: null, spentUsd: 0 } : r.caps.account;
    paint(host, scope, botId, view, r.caps);
  }

  function paint(host, scope, botId, view, caps) {
    const line = h("p", "cap-line", spendLine(view, locale));
    const bar = barFor(view);
    const track = h("div", `cap-bar${bar ? ` ${bar.tone}` : ""}`); track.hidden = !bar;
    const fill = h("i"); if (bar) fill.style.width = `${bar.pct}%`; track.append(fill);
    const usd = h("input", "fld"); usd.type = "text"; usd.inputMode = "decimal"; usd.placeholder = "No cap"; usd.value = view.cap ? String(view.cap.usd) : ""; usd.setAttribute("aria-label", `${scope === "bot" ? "Bot" : "Account"} cap in US dollars`);
    const per = h("select", "fld"); per.setAttribute("aria-label", "Cap period");
    for (const [v, t] of PERIODS) { const o = h("option", "", t); o.value = v; per.append(o); }
    per.value = view.cap ? view.cap.period : "monthly";
    const alert = h("input", "fld"); alert.type = "text"; alert.inputMode = "numeric"; alert.placeholder = "Off"; alert.value = view.cap && view.cap.alertPct ? String(view.cap.alertPct) : ""; alert.setAttribute("aria-label", "Alert at percent of the cap");
    const lab = (t, n) => { const l = h("label", "cap-f"); l.append(h("span", "fld-label", t), n); return l; };
    const row = h("div", "cap-row"); row.append(lab("Cap (USD)", usd), lab("Period", per), lab("Alert at (%)", alert));
    const save = h("button", "btn-primary sm", "Save"); save.type = "button";
    const clear = h("button", "btn-quiet sm", "Remove cap"); clear.type = "button"; clear.hidden = !view.cap;
    const state = h("span", "inline-state"); state.setAttribute("role", "status"); state.setAttribute("aria-live", "polite");
    const acts = h("div", "cap-acts"); acts.append(save, clear, state);
    const fine = h("p", "drawer-fine", scope === "bot"
      ? "This bot stops at this cap. Your account cap still applies to everything; whichever is lower wins."
      : "Applies to every Daebot device and bot on your account. Periods reset at midnight New York time (weekly on Monday, monthly on the 1st).");
    host.replaceChildren(line, track, row, acts, fine);
    if (scope === "bot" && caps.account && caps.account.cap) fine.textContent += ` Account cap: ${money(caps.account.cap.usd)} ${caps.account.cap.period}.`;
    async function put(cap) {
      const body = scope === "bot" ? { bots: { [botId]: cap } } : { account: cap };
      save.disabled = clear.disabled = true; state.textContent = "Saving…";
      try {
        await json("/spend-caps", { method: "PUT", body: JSON.stringify(body) });
        state.textContent = cap ? "Saved." : "Cap removed.";
        await mount(host, { scope, botId });
        refresh();
      } catch (e) { if (e.message !== "unauthorized") state.textContent = e.message || "Could not save."; save.disabled = clear.disabled = false; }
    }
    save.addEventListener("click", () => {
      const r = capFromForm({ usd: usd.value, period: per.value, alertPct: alert.value });
      if (r.error) { state.textContent = r.error; return; }
      void put(r.cap);
    });
    clear.addEventListener("click", () => void put(null));
  }

  // ---- the account modal
  const modal = $("caps-modal"), body = $("caps-body"), closeBtn = $("caps-close"), open = $("am-caps");
  let isOpen = false, lastFocus = null;
  function setOpen(on) {
    if (!modal) return;
    isOpen = on; modal.hidden = !on;
    if (on) { lastFocus = document.activeElement; if (body) { body.dataset.stale = "0"; void mount(body, { scope: "account" }); } if (closeBtn) closeBtn.focus(); }
    else { if (body) body.dataset.stale = "1"; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
  }
  if (open) open.addEventListener("click", () => setOpen(true));
  if (closeBtn) closeBtn.addEventListener("click", () => setOpen(false));
  if (modal) modal.addEventListener("mousedown", (e) => { if (e.target === modal) setOpen(false); });
  document.addEventListener("keydown", (e) => { if (isOpen && e.key === "Escape") { e.preventDefault(); setOpen(false); } });
  const dismiss = $("cap-banner-x"); if (dismiss) dismiss.addEventListener("click", () => { const b = $("cap-banner"); if (b) b.hidden = true; });

  return {
    refresh,
    view: () => last,
    open: () => setOpen(true),
    mountBot(host, botId) { if (host) { host.dataset.stale = "0"; return mount(host, { scope: "bot", botId }); } },
    unmountBot(host) { if (host) host.dataset.stale = "1"; },
  };
}
