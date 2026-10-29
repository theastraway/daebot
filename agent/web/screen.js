// "Let Daebot watch my screen": the switch in the account menu, the red "watching" pill with a one-click Stop, and the macOS permission card.
// Desktop app only: everything stays hidden unless the shell exposes window.mindclawDesktop.screen (the website and the phone never show it).
// The USER grants the macOS permission; this file only shows the state and a button that opens the System Settings pane.

/** What to show for a state from the shell. Pure so it is unit tested. */
export function screenView(s) {
  const st = s && typeof s === "object" ? s : {};
  const watching = st.watching === true;
  const perm = typeof st.permission === "string" ? st.permission : "unknown";
  const on = watching && perm === "granted";
  const needsPermission = watching && perm === "needs-permission";
  let note = "Off. Daebot cannot see your screen.";
  if (on) note = st.error ? `On, but capture has a problem: ${st.error}` : "On. Daebot looks only when you ask it to. A red dot shows while this is on.";
  else if (needsPermission) note = "Waiting for Screen Recording permission.";
  else if (watching && perm === "restricted") note = "Blocked by a system policy on this computer.";
  else if (watching && perm === "unsupported") note = "Not supported on this system.";
  else if (watching) note = "Checking permission...";
  return {
    checked: watching,
    on,
    pill: on,
    card: needsPermission,
    canOpenSettings: st.canOpenSettings === true,
    note,
    platform: st.platform || "",
  };
}

export function initScreen(o) {
  const bridge = typeof window !== "undefined" && window.mindclawDesktop && window.mindclawDesktop.screen;
  if (!bridge || typeof bridge.get !== "function") return { available: false };
  const { h, item, pill } = o;
  let state = null;
  let card = null;

  const sw = item.querySelector(".u-switch");
  const note = item.querySelector("small");
  item.hidden = false;

  function closeCard() { if (card) { card.remove(); card = null; } }

  function openCard(v) {
    if (card) return;
    const modal = h("div", "gate-token modal"); modal.id = "screen-modal";
    const c = h("div", "token-card bot-card apps-card"); c.setAttribute("role", "dialog"); c.setAttribute("aria-modal", "true"); c.setAttribute("aria-label", "Screen Recording permission");
    const head = h("div", "apps-head");
    const t = h("div"); t.append(h("h2", "", "Daebot needs Screen Recording permission"), h("p", "", "macOS asks you to allow this once. Daebot cannot allow it for you."));
    head.append(t);
    const steps = h("ol", "screen-steps");
    for (const x of ["Click Open System Settings.", "Turn on Daebot under Screen & System Audio Recording.", "If macOS asks, quit and reopen Daebot. The switch stays on."]) steps.append(h("li", "", x));
    const row = h("div", "screen-actions");
    if (v.canOpenSettings) {
      const go = h("button", "btn-primary", "Open System Settings"); go.type = "button";
      go.addEventListener("click", () => { bridge.openSettings(); });
      row.append(go);
    }
    const no = h("button", "btn-quiet", "Turn it off"); no.type = "button";
    no.addEventListener("click", () => { bridge.set(false).then(apply).catch(() => {}); closeCard(); });
    row.append(no);
    c.append(head, steps, row, h("p", "apps-note", "Frames stay in memory on this computer. Nothing is saved or uploaded unless you ask Daebot to look at something."));
    modal.append(c);
    document.body.append(modal);
    card = modal;
  }

  function apply(s) {
    state = s;
    const v = screenView(s);
    sw.classList.toggle("on", v.checked);
    item.setAttribute("aria-checked", String(v.checked));
    note.textContent = v.note;
    pill.hidden = !v.pill;
    if (v.card) openCard(v); else closeCard();
  }

  item.addEventListener("click", () => {
    const next = !(state && state.watching);
    bridge.set(next).then((s) => { if (s) apply(s); }).catch(() => {});
  });
  pill.querySelector("button").addEventListener("click", () => { bridge.set(false).then((s) => { if (s) apply(s); }).catch(() => {}); });
  if (typeof bridge.onChange === "function") bridge.onChange(apply);
  bridge.get().then((s) => { if (s) apply(s); }).catch(() => {});
  return { available: true, state: () => state };
}
