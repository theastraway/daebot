// The connector page: what opens when you select a connector in Apps. Same card, same panel; the list steps aside and a back arrow brings it back.
// Top to bottom: back arrow + close, logo, name, Share and Uninstall; one line about it; Accounts (label and account, rename, Connected or
// Reconnect, + Add Another Account); Tools ("N of M enabled", each with a switch that the server remembers per user and that removes the tool
// from what Daebot can use); Apps; Information. Built with createElement + textContent only; everything from a server is untrusted text.
import { markFor } from "/apps-icons.js";

const NS = "http://www.w3.org/2000/svg";
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const svg = (paths, size = 18) => {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("width", String(size)); s.setAttribute("height", String(size));
  s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "2"); s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
  s.setAttribute("aria-hidden", "true");
  for (const d of paths) { const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); s.append(p); }
  return s;
};
const ICON = {
  back: ["M19 12H5", "M12 19l-7-7 7-7"],
  x: ["M18 6L6 18", "M6 6l12 12"],
  pencil: ["M12 20h9", "M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z"],
  chev: ["M6 9l6 6 6-6"],
  plug: ["M9 2v6", "M15 2v6", "M6 8h12v4a6 6 0 01-12 0V8z", "M12 18v4"],
  plus: ["M12 5v14", "M5 12h14"],
};
const iconBtn = (name, label, cls = "cd-iconbtn") => { const b = el("button", cls); b.type = "button"; b.setAttribute("aria-label", label); b.title = label; b.append(svg(ICON[name])); return b; };

function logoTile(e) {
  const box = el("span", "app-logo cd-logo");
  const letter = () => { box.replaceChildren(); box.classList.remove("img"); box.classList.add("letter"); box.textContent = (/[\p{L}\p{N}]/u.exec(String(e.name || "")) || ["?"])[0].toUpperCase(); };
  const mark = markFor(e.logo, letter);
  if (mark) { box.classList.add("img"); box.append(mark); } else letter();
  box.setAttribute("aria-hidden", "true");
  return box;
}

/** `ctx`: { apps, json, entry (the list row), actions: { reconnect(account, ctl), addAccount(), uninstall(detail) }, onClose() } */
export async function openConnectorDetail(ctx) {
  const { apps, json, entry } = ctx;
  const view = el("section", "cd");
  view.setAttribute("aria-label", `${entry.name} connector`);
  const head = el("div", "cd-top");
  const back = iconBtn("back", "Back to connectors");
  const close = iconBtn("x", "Close");
  head.append(back, close);
  const body = el("div", "cd-body");
  body.append(el("p", "apps-empty", "Loading…"));
  view.append(head, body);
  apps.showDetail(view);
  back.addEventListener("click", () => apps.hideDetail());
  close.addEventListener("click", () => apps.close());
  back.focus({ preventScroll: true });

  let d;
  try { d = (await json(`/mcp/connector?id=${encodeURIComponent(entry.id)}`)).connector; }
  catch (err) { body.replaceChildren(el("p", "apps-empty", err && err.message ? err.message : "Could not load this connector.")); return; }
  if (!view.isConnected) return;
  const status = el("p", "cd-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); status.hidden = true;
  const say = (t, tone) => { status.textContent = t || ""; status.className = `cd-status is-${tone || "off"}`; status.hidden = !t; };

  const render = () => {
    body.replaceChildren();
    // --- title row
    const title = el("div", "cd-title");
    title.append(logoTile(entry));
    const names = el("div", "cd-names"); names.append(el("h3", "cd-name", d.name));
    title.append(names);
    const pills = el("div", "cd-pills");
    const share = el("button", "cd-pill", "Share"); share.type = "button";
    const un = el("button", "cd-pill is-danger", "Uninstall"); un.type = "button";
    pills.append(share, un);
    title.append(pills);
    body.append(title, el("p", "cd-desc", d.description), status);

    const confirm = el("div", "cd-confirm"); confirm.hidden = true;
    body.append(confirm);
    share.addEventListener("click", async () => {
      const link = `${location.origin}/?connector=${encodeURIComponent(d.id)}`;
      try { await navigator.clipboard.writeText(link); say("Link copied. It opens this connector's page in Daebot.", "ok"); }
      catch { say(`Copy this link: ${link}`, "off"); }
    });
    un.addEventListener("click", () => {
      confirm.replaceChildren();
      confirm.append(el("p", "", `Uninstall ${d.name}? Daebot disconnects ${d.accounts.length > 1 ? `all ${d.accounts.length} accounts` : "it"} and stops using ${d.name}. Anything already synced to MIND stays.`));
      const r = el("div", "row");
      const yes = el("button", "btn-danger solid", "Uninstall"); yes.type = "button";
      const no = el("button", "btn-quiet", "Keep it"); no.type = "button";
      no.addEventListener("click", () => { confirm.hidden = true; un.focus(); });
      yes.addEventListener("click", async () => { yes.disabled = true; no.disabled = true; yes.textContent = "Removing…"; await ctx.actions.uninstall(d, say); });
      r.append(yes, no); confirm.append(r); confirm.hidden = false; no.focus();
    });

    // --- Accounts
    body.append(el("h4", "cd-h", "Accounts"));
    const card = el("div", "cd-card");
    for (const a of d.accounts) {
      const row = el("div", "cd-row");
      const text = el("div", "cd-rowtext");
      const lab = el("span", "cd-label", a.label);
      text.append(lab);
      if (a.account && a.account !== a.label) text.append(el("span", "cd-sub", ` · ${a.account}`));
      row.append(text);
      const edit = iconBtn("pencil", `Rename ${a.label}`);
      row.append(edit);
      let state;
      if (a.status === "reauth") {
        state = el("button", "cd-reconnect", "Reconnect"); state.type = "button";
        state.addEventListener("click", () => ctx.actions.reconnect(d, a, { busy: (on) => { state.disabled = on; }, say }));
      } else state = el("span", `cd-state is-${a.status === "connected" ? "ok" : "off"}`, a.status === "connected" ? "Connected" : "Off");
      row.append(state);
      if (a.note) row.append(el("p", "cd-note", a.note));
      edit.addEventListener("click", () => {
        const inp = document.createElement("input"); inp.type = "text"; inp.className = "fld cd-edit"; inp.value = a.label; inp.maxLength = 40; inp.setAttribute("aria-label", "Account label");
        lab.replaceWith(inp); edit.hidden = true; inp.focus(); inp.select();
        let done = false;
        const commit = async (save) => {
          if (done) return; done = true;
          const next = inp.value.trim();
          if (save && next && next !== a.label) {
            try { const r = await json("/mcp/connector/label", { method: "POST", body: JSON.stringify({ key: a.key, label: next }) }); a.label = r.label || next; } catch (err) { say(err && err.message ? err.message : "Could not save the name.", "warn"); }
          }
          render();
        };
        inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); commit(true); } else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); commit(false); } });
        inp.addEventListener("blur", () => commit(true));
      });
      card.append(row);
    }
    if (!d.accounts.length) card.append(el("div", "cd-row", "No account is connected."));
    const add = el("button", "cd-add"); add.type = "button";
    add.append(svg(ICON.plus, 16), el("span", "", "Add Another Account"));
    const addNote = el("p", "cd-note", d.addAccount.note); addNote.hidden = true;
    add.addEventListener("click", () => {
      if (d.addAccount.supported) ctx.actions.addAccount(d); else addNote.hidden = !addNote.hidden;
    });
    card.append(add, addNote);
    body.append(card);

    // --- Tools
    body.append(el("h4", "cd-h", "Tools"));
    const tcard = el("div", "cd-card");
    const count = () => d.tools.filter((t) => t.enabled).length;
    const toggle = el("button", "cd-toolhead"); toggle.type = "button"; toggle.setAttribute("aria-expanded", "false");
    const tlabel = el("span", "", d.tools.length ? `${count()} of ${d.tools.length} enabled` : "No tools");
    const chev = svg(ICON.chev, 16); chev.classList.add("cd-chev");
    toggle.append(tlabel, chev);
    const list = el("div", "cd-tools"); list.hidden = true;
    toggle.disabled = !d.tools.length;
    toggle.addEventListener("click", () => { list.hidden = !list.hidden; toggle.setAttribute("aria-expanded", String(!list.hidden)); chev.classList.toggle("is-open", !list.hidden); });
    for (const t of d.tools) {
      const row = el("div", "cd-tool");
      const tx = el("div", "cd-tooltext"); tx.append(el("span", "cd-toolname", t.name));
      if (t.description) tx.append(el("span", "cd-tooldesc", t.description));
      const sw = el("button", "cd-switch"); sw.type = "button"; sw.setAttribute("role", "switch"); sw.setAttribute("aria-checked", String(t.enabled)); sw.setAttribute("aria-label", `${t.name} ${t.enabled ? "on" : "off"}`);
      sw.append(el("span", "cd-knob"));
      sw.addEventListener("click", async () => {
        const next = !t.enabled; sw.disabled = true;
        try {
          await json("/mcp/connector/tool", { method: "POST", body: JSON.stringify({ server: t.server, tool: t.name, enabled: next }) });
          t.enabled = next; sw.setAttribute("aria-checked", String(next)); sw.setAttribute("aria-label", `${t.name} ${next ? "on" : "off"}`);
          tlabel.textContent = `${count()} of ${d.tools.length} enabled`;
        } catch (err) { say(err && err.message ? err.message : "Could not save that switch.", "warn"); }
        finally { sw.disabled = false; }
      });
      row.append(tx, sw); list.append(row);
    }
    tcard.append(toggle, list);
    if (d.toolsNote) tcard.append(el("p", "cd-note is-show", d.toolsNote));
    body.append(tcard);

    // --- Apps
    body.append(el("h4", "cd-h", `Apps ${d.apps.length}`));
    const acard = el("div", "cd-card");
    for (const ap of d.apps) {
      const row = el("div", "cd-row");
      const ic = el("span", "cd-appicon"); ic.append(svg(ICON.plug, 18));
      const tx = el("div", "cd-rowtext is-stack"); tx.append(el("span", "cd-label", ap.name), el("span", "cd-sub", ap.subtitle));
      row.append(ic, tx); acard.append(row);
    }
    body.append(acard);

    // --- Information
    body.append(el("h4", "cd-h", "Information"));
    const icard = el("div", "cd-card");
    for (const [k, v] of [["Capabilities", `${d.capabilities} app${d.capabilities === 1 ? "" : "s"}`], ["Developer", d.developer]]) {
      const row = el("div", "cd-row cd-info"); row.append(el("span", "cd-label", k), el("span", "cd-sub", v)); icard.append(row);
    }
    body.append(icard);
  };
  render();
}
