// Actions roll like a rolodex: a run of consecutive tool rows shows only the newest FOLD_KEEP of them. When a new action
// arrives the oldest one rolls out at the top and the new one rolls in at the bottom. A "See all (N)" button under the run
// opens the whole list and folds it back. Works on live turns and on finished turns, because it reads the thread DOM
// (any item kind other than a tool row ends a run), so it does not care which code path built the rows.
// State lives in data attributes, never in classNames: refreshTool() in app.js rewrites a tool row's className.

export const FOLD_KEEP = 4;

/** Pure plan for one run of `count` tool rows: how many are hidden, and what the button says (null = no button). */
export function planRun(count, expanded, keep = FOLD_KEEP) {
  if (!(count > keep)) return { hidden: 0, label: null };
  if (expanded) return { hidden: 0, label: "Show fewer" };
  return { hidden: count - keep, label: `See all (${count})` };
}

const isTool = (n) => n.nodeType === 1 && n.classList.contains("tool");
const isMore = (n) => n.nodeType === 1 && n.classList.contains("tool-more");

export function initToolRoll(thread, { reduced } = {}) {
  const noMotion = reduced || (() => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches));
  let queued = false;

  function setFold(n, hide) {
    const folded = n.dataset.fold === "1";
    if (hide === folded) return;
    if (hide) {
      // A row that was on screen rolls out; one that never was (history loading in) just stays folded.
      if (n.dataset.seen === "1" && !noMotion()) {
        n.dataset.roll = "out";
        const done = () => { if (n.dataset.roll === "out") { delete n.dataset.roll; n.dataset.fold = "1"; } };
        n.addEventListener("animationend", done, { once: true });
        setTimeout(done, 400); // animationend does not fire in a background tab
      } else n.dataset.fold = "1";
    } else {
      delete n.dataset.fold; delete n.dataset.roll;
    }
  }

  function layoutRun(run) {
    const rows = run.filter(isTool);
    const mores = run.filter(isMore);
    let more = mores.pop();
    for (const extra of mores) extra.remove();
    const expanded = !!more && more.dataset.open === "1";
    const plan = planRun(rows.length, expanded);
    rows.forEach((n, i) => {
      setFold(n, i < plan.hidden);
      if (i >= plan.hidden && n.dataset.seen !== "1") {
        n.dataset.seen = "1";
        // A row that arrives while the chat is live rolls in; rows painted with a loaded chat appear in place.
        if (thread.getAttribute("aria-busy") !== "true" && !noMotion() && n.dataset.arrived === "1") n.dataset.roll = "in";
      }
    });
    if (!plan.label) { more?.remove(); return; }
    if (!more) {
      more = document.createElement("button");
      more.type = "button"; more.className = "tool-more"; more.dataset.open = "0";
      more.addEventListener("click", () => {
        more.dataset.open = more.dataset.open === "1" ? "0" : "1";
        layout();
        if (more.dataset.open === "1") more.previousElementSibling?.scrollIntoView?.({ block: "nearest" });
      });
    }
    more.textContent = plan.label;
    more.setAttribute("aria-expanded", String(expanded));
    more.setAttribute("aria-label", expanded ? `Show only the latest ${FOLD_KEEP} actions` : `See all ${rows.length} actions`);
    const last = run[run.length - 1];
    if (last !== more || !more.isConnected) last.after(more); // the button always closes its run
  }

  function layout() {
    queued = false;
    obs.disconnect();
    try {
      let run = [];
      const flush = () => { if (run.length) layoutRun(run); run = []; };
      for (const n of Array.from(thread.children)) {
        if (isTool(n) || (isMore(n) && run.length)) run.push(n);
        else { if (isMore(n)) n.remove(); flush(); }
      }
      flush();
    } finally { obs.observe(thread, { childList: true }); }
  }
  function queue() { if (!queued) { queued = true; (window.requestAnimationFrame || setTimeout)(layout); } }

  const obs = new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) if (isTool(n) && !n.dataset.seen) n.dataset.arrived = "1";
    queue();
  });
  obs.observe(thread, { childList: true });
  layout();
  return { layout };
}
