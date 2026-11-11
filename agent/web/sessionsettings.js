// Session settings: a small panel for a plain session (a bot thread opens its bot's settings instead). Name, home environment, and when it
// was last active. Saving the name goes through the same rename path as the inline rename. DOM is createElement + textContent only.
import { kindIcon, KIND_LABEL } from "./envgroups.js";

export function settingsFacts(s, env) {
  const e = env || { name: "MIND Cloud", kind: "cloud", online: true };
  return { title: s.title || "Untitled", where: e.name, kind: KIND_LABEL[e.kind] || "Computer", online: e.online !== false, pinned: !!s.pinnedAt };
}

export function openSessionSettings({ s, env, h, icon, ago, onRename }) {
  const prev = document.activeElement;
  const f = settingsFacts(s, env);
  const back = h("div", "gate-token modal"); back.id = "sess-settings";
  const card = h("div", "token-card bot-card"); card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true"); card.setAttribute("aria-labelledby", "ss-title");
  const title = h("h2", "", "Session settings"); title.id = "ss-title";
  const lab = h("label", "ss-lab", "Name"); lab.htmlFor = "ss-name";
  const input = h("input", "fld"); input.id = "ss-name"; input.type = "text"; input.maxLength = 80; input.value = s.title || "";
  const home = h("div", "ss-home");
  const ic = icon(kindIcon(env && env.kind)); ic.classList.add("env-kind");
  home.append(ic, h("span", "ss-where", f.where), h("span", "ss-kind", f.kind), h("i", `env-dot ${f.online ? "online" : "offline"}`), h("span", "ss-state", f.online ? "online" : "offline"));
  const homeLab = h("div", "ss-lab", "Home environment");
  const meta = h("div", "ss-meta", `Last active ${ago(s.updatedAt)}${s.pinnedAt ? " · Pinned" : ""}`);
  const row = h("div", "row");
  const save = h("button", "btn-primary", "Save"); save.type = "button";
  const cancel = h("button", "btn-quiet", "Close"); cancel.type = "button";
  row.append(save, cancel);
  card.append(title, lab, input, homeLab, home, meta, row);
  back.append(card);
  const done = () => { document.removeEventListener("keydown", onKey, true); back.remove(); try { prev && prev.focus && prev.focus(); } catch { /* gone */ } };
  const commit = () => { const t = input.value.trim(); if (t && t !== (s.title || "")) onRename(t); done(); };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(); }
    else if (e.key === "Enter" && document.activeElement === input) { e.preventDefault(); commit(); }
    else if (e.key === "Tab") { const fs = [input, save, cancel]; const i = fs.indexOf(document.activeElement); e.preventDefault(); fs[(i + (e.shiftKey ? -1 : 1) + 3) % 3].focus(); }
  };
  save.addEventListener("click", commit); cancel.addEventListener("click", done);
  back.addEventListener("click", (e) => { if (e.target === back) done(); });
  document.addEventListener("keydown", onKey, true);
  document.body.append(back);
  input.focus(); input.select();
  return done;
}
