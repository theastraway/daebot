// The sidebar's bottom bar and the account menu behind the avatar.
//   bar   : [avatar + name] opens the menu · [connection dot] · [Apps icon] opens the Apps and connectors card
//   menu  : who you are (+ plan), update banner (desktop), Permissions, Apps and connectors, Get the apps, Switch account, Sign out
//   accounts: hosted keeps a signed list of the accounts signed in on this browser (POST /auth/switch swaps the active one, no re-login);
//             the desktop app keeps every account's key in its own secure file and restarts the gateway as the chosen one.
// DOM is built with createElement + textContent only. Pure helpers are exported for tests.

/** The device kind from a user agent: where to point "Get the app". Mirrors login.js, kept here so the app page does not import the sign-in script. */
export function deviceKind(ua, platform = "", touchPoints = 0) {
  const u = String(ua || "");
  if (/android/i.test(u)) return "android";
  if (/iphone|ipad|ipod/i.test(u) || (/macintosh/i.test(u) && touchPoints > 1)) return "ios";
  if (/windows/i.test(u)) return "windows";
  if (/mac os x|macintosh/i.test(u) || /mac/i.test(platform)) return "mac";
  if (/linux|x11|cros/i.test(u)) return "linux";
  return "unknown";
}

/** Which "Get the app" rows to show. Nothing inside a Daebot app of that kind; no desktop app offered on a phone. */
export function appLinks({ desktopShell, mobileShell, kind }) {
  if (mobileShell) return { mobile: false, desktop: false };
  const phone = kind === "ios" || kind === "android";
  return { mobile: true, desktop: !desktopShell && !phone };
}

/** First letter for the avatar. */
export function initialOf(name) {
  const m = /[\p{L}\p{N}]/u.exec(String(name || ""));
  return m ? m[0].toUpperCase() : "D";
}

/** What the update banner says for a desktop updater state (the banner shows only when there is something to do). */
export function updateBanner(s) {
  if (!s || !s.enabled) return null;
  if (s.status === "downloaded") return { text: `New update available${s.nextVersion ? ` (${s.nextVersion})` : ""}`, action: "Restart to update" };
  if (s.status === "available" || s.status === "downloading") return { text: `Downloading ${s.nextVersion || "the update"}${s.percent ? ` ${s.percent}%` : ""}`, action: "" };
  return null;
}

export function initAccount({ json, h, icon, notify, desktop, isHosted, closeSidebar, openApps, openPermissions, onOpen }) {
  const $ = (id) => document.getElementById(id);
  const bar = $("side-bar"), btn = $("acct-btn"), menu = $("acct-menu"), sub = $("am-accounts"), switchBtn = $("am-switch");
  if (!bar || !btn || !menu) return { setIdentity() {}, setOnline() {}, setUpdate() {} };
  let open = false, subOpen = false;
  let me = { name: "", owner: false };

  // ---- identity
  function setIdentity({ username, owner, planName, sub: subText }) {
    me = { name: owner ? "Owner" : username || "", owner: !!owner };
    const shown = me.name || "Account";
    $("acct-name").textContent = shown;
    $("acct-avatar").textContent = initialOf(me.name);
    $("am-avatar").textContent = initialOf(me.name);
    $("am-name").textContent = shown;
    $("am-sub").textContent = subText || (owner ? "Owner access" : planName ? `${planName} plan` : "Signed in with MIND");
    btn.title = shown;
    btn.setAttribute("aria-label", `Account menu, signed in as ${shown}`);
  }

  // ---- connection dot (title only; the hidden text keeps screen readers informed)
  function setOnline(on) {
    const dot = $("conn-dot"), t = on ? "Connected" : "Offline";
    dot.title = t; dot.setAttribute("aria-label", t);
    $("conn-text").textContent = on ? "Connected" : "Gateway offline";
  }

  // ---- get the apps (device-aware, hidden in the apps themselves)
  function paintLinks() {
    const shell = typeof window !== "undefined" ? window : {};
    const mobileShell = !!(shell.DaebotAndroid || shell.Capacitor || /DaebotApp/i.test(navigator.userAgent));
    const kind = deviceKind(navigator.userAgent, navigator.platform, navigator.maxTouchPoints || 0);
    const l = appLinks({ desktopShell: !!desktop(), mobileShell, kind });
    $("am-mobile").hidden = !l.mobile;
    $("am-desktop").hidden = !l.desktop;
  }

  // ---- update banner + "Check for updates" (desktop shell only)
  function setUpdate(s) {
    const box = $("upd"), text = $("upd-text"), b = $("upd-btn"), chk = $("am-check");
    const d = desktop();
    chk.hidden = !d || !s || !s.enabled;
    $("am-check-text").textContent = s && s.status === "checking" ? "Checking for updates" : "Check for updates";
    $("am-check-ver").textContent = s && s.currentVersion ? `v${s.currentVersion}` : "";
    const bn = updateBanner(s);
    box.hidden = !bn;
    $("acct-badge").hidden = !(bn && bn.action);
    if (!bn) return;
    text.textContent = bn.text;
    b.hidden = !bn.action;
    b.textContent = bn.action;
    b.disabled = false;
    b.onclick = () => { b.disabled = true; b.textContent = "Restarting"; try { d.updates.install(); } catch { /* shell going away */ } };
  }
  $("am-check").addEventListener("click", async () => {
    const d = desktop();
    if (!d || !d.updates) return;
    $("am-check-text").textContent = "Checking for updates";
    try { setUpdate(await d.updates.check()); } catch { notify("Could not check for updates."); }
  });

  // ---- open / close
  function items() { return [...menu.querySelectorAll('.am-item:not([hidden]), .am-acct')].filter((e) => !e.closest("[hidden]")); }
  function toggleMenu(on, focus = true) {
    open = on;
    menu.hidden = !on;
    btn.setAttribute("aria-expanded", String(on));
    if (!on) toggleSub(false);
    if (on) {
      paintLinks();
      if (onOpen) onOpen();
      // Switching accounts needs hosted sign-in or the desktop app's account store; a plain local browser has one gateway token.
      const canSwitch = !!(isHosted() || desktop());
      switchBtn.hidden = !canSwitch;
      // "Sign out of all" only makes sense with more than one account remembered.
      listAccounts().then((l) => { $("am-logout-all").hidden = l.length < 2; }).catch(() => { $("am-logout-all").hidden = true; });
      const first = items()[0]; if (focus && first) first.focus();
    }
  }
  btn.addEventListener("click", () => toggleMenu(!open));
  document.addEventListener("click", (e) => { if (open && !menu.contains(e.target) && !btn.contains(e.target)) toggleMenu(false); });
  document.addEventListener("keydown", (e) => {
    if (!open) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (subOpen) { toggleSub(false); switchBtn.focus(); } else { toggleMenu(false); btn.focus(); } return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const list = items();
      const i = list.indexOf(document.activeElement);
      list[(i + (e.key === "ArrowDown" ? 1 : list.length - 1) + (i < 0 ? 1 : 0)) % list.length].focus();
    }
    if (e.key === "ArrowRight" && document.activeElement === switchBtn) { e.preventDefault(); toggleSub(true); sub.querySelector(".am-acct")?.focus(); }
    if (e.key === "ArrowLeft" && subOpen) { e.preventDefault(); toggleSub(false); switchBtn.focus(); }
    if (e.key === "Tab") toggleMenu(false, false);
  }, true);
  // Any plain menu action closes the menu (the Switch account row opens its list instead).
  menu.addEventListener("click", (e) => {
    const t = e.target.closest(".am-item");
    if (t && t !== switchBtn && t.id !== "am-check") { toggleMenu(false, false); if (closeSidebar) closeSidebar(); }
  });
  $("btn-apps").addEventListener("click", () => { toggleMenu(false, false); });
  $("am-apps").addEventListener("click", () => { if (openApps) openApps(); });
  $("btn-perms").addEventListener("click", () => { /* the Permissions panel's own listener opens it */ });

  // ---- switch account
  function acctRow(a) {
    const b = h("button", "am-acct"); b.type = "button"; b.setAttribute("role", "menuitemradio"); b.setAttribute("aria-checked", String(!!a.active));
    const av = h("span", "avatar", initialOf(a.name)); av.setAttribute("aria-hidden", "true");
    b.append(av, h("span", "nm", a.name));
    if (a.active) b.append(icon("i-check"));
    b.addEventListener("click", () => { if (a.active) { toggleMenu(false); return; } void switchTo(a); });
    return b;
  }
  async function listAccounts() {
    const d = desktop();
    if (d && d.accounts) return (await d.accounts.list()) || [];
    if (!isHosted()) return me.name ? [{ id: "me", name: me.name, active: true }] : [];
    const r = await json("/auth/accounts");
    return (r.accounts || []).map((a) => ({ id: a.id, name: a.username, active: a.active }));
  }
  async function paintSub() {
    sub.replaceChildren();
    let list = [];
    try { list = await listAccounts(); } catch { notify("Could not load your accounts."); }
    for (const a of list) sub.append(acctRow(a));
    const add = h("button", "am-acct add"); add.type = "button"; add.setAttribute("role", "menuitem");
    const plus = h("span", "plus"); plus.append(icon("i-plus"));
    add.append(plus, h("span", "nm", "Add another account"));
    add.addEventListener("click", () => { toggleMenu(false); void addAccount(); });
    sub.append(add);
    $("am-logout-all").hidden = list.length < 2;
  }
  function toggleSub(on) {
    subOpen = on;
    sub.hidden = !on;
    switchBtn.setAttribute("aria-expanded", String(on));
    if (on) void paintSub();
  }
  switchBtn.addEventListener("click", () => toggleSub(!subOpen));

  async function switchTo(a) {
    const d = desktop();
    try {
      if (d && d.accounts) { toggleMenu(false); await d.accounts.switch(a.id); return; } // the shell restarts the gateway and reloads this window
      await json("/auth/switch", { method: "POST", body: JSON.stringify({ account: a.id }) });
      try { sessionStorage.removeItem("daebot:current"); sessionStorage.removeItem("daebot:bot"); localStorage.removeItem("daebot:inflight"); } catch { /* none */ }
      location.replace("/");
    } catch (e) { notify(`Could not switch account: ${e.message}`); }
  }
  async function addAccount() {
    const d = desktop();
    if (d && d.accounts) { try { const r = await d.accounts.add(); if (r && r.error) notify(r.error); } catch { notify("Could not open sign-in."); } return; }
    location.assign("/login?add=1");
  }

  // ---- sign out (this account only) and sign out of all
  async function signOut(all) {
    const d = desktop();
    if (d) { d.signOut(all ? { all: true } : undefined); return; }
    let remaining = 0;
    try {
      const r = await fetch("/logout", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(all ? { all: true } : {}) });
      remaining = (await r.json().catch(() => ({}))).remaining || 0;
    } catch { /* leaving anyway */ }
    try { sessionStorage.removeItem("daebot:current"); sessionStorage.removeItem("daebot:bot"); localStorage.removeItem("daebot:inflight"); } catch { /* none */ }
    location.replace("/");
    void remaining;
  }
  $("btn-logout").addEventListener("click", () => signOut(false));
  $("am-logout-all").addEventListener("click", () => signOut(true));

  paintLinks();
  return { setIdentity, setOnline, setUpdate, close: () => toggleMenu(false, false) };
}
