// Menu templates (plain data; main.mjs feeds them to Menu.buildFromTemplate). Handlers are injected so this is testable.
import { KERNEL_MODES } from "./kernel.mjs";

export function buildTrayTemplate({ windowVisible, kernelMode, shortcut, handlers, update = null }) {
  return [
    { label: windowVisible ? "Hide Daebot" : "Show Daebot", accelerator: shortcut || undefined, registerAccelerator: false, click: handlers.toggle },
    { label: "New Session", click: handlers.newSession },
    { type: "separator" },
    {
      label: "Kernel mode",
      submenu: Object.entries(KERNEL_MODES).map(([id, m]) => ({
        label: m.label, type: "radio", checked: id === kernelMode, click: () => handlers.setKernelMode(id),
      })),
    },
    { type: "separator" },
    ...(update ? [update, { type: "separator" }] : []),
    { label: "Sign out of MIND", click: handlers.signOut },
    { label: "Quit Daebot", accelerator: "CmdOrCtrl+Q", click: handlers.quit },
  ];
}

export function buildAppMenuTemplate({ handlers, isMac = true, name = "Daebot", update = null }) {
  const app = isMac
    ? [{ label: name, submenu: [{ role: "about" }, ...(update ? [update] : []), { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { label: `Quit ${name}`, accelerator: "CmdOrCtrl+Q", click: handlers.quit }] }]
    : [];
  return [
    ...app,
    { label: "File", submenu: [
      { label: "New Session", accelerator: "CmdOrCtrl+N", click: handlers.newSession },
      { label: "Close Window", accelerator: "CmdOrCtrl+W", click: handlers.hideWindow },
    ] },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "View", submenu: [{ role: "reload" }, { role: "togglefullscreen" }] },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }] },
  ];
}

/** Flatten a template to "path > label" strings with accelerators, for tests. */
export function flatten(template, prefix = "") {
  const out = [];
  for (const item of template) {
    const label = item.label ?? (item.role ? `[${item.role}]` : item.type);
    if (item.submenu) out.push(...flatten(item.submenu, `${prefix}${label} > `));
    else out.push({ path: `${prefix}${label}`, accelerator: item.accelerator, item });
  }
  return out;
}
