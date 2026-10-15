// Sandboxed preload (must be CommonJS). Exposes the smallest possible surface to the web UI:
//   window.mindclawDesktop.notify({ title, body })   optional hook the web UI MAY call; main validates, rate-limits
//                                                      and only honors it from the gateway origin.
//   window.mindclawDesktop.platform / version         read-only strings
// The desktop shell also watches confirm events itself, so the web UI does not need to call notify() at all.
const { contextBridge, ipcRenderer } = require("electron");

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

contextBridge.exposeInMainWorld("mindclawDesktop", Object.freeze({
  platform: process.platform,
  version: "0.2.0-dev",
  notify(payload) {
    const p = payload && typeof payload === "object" ? payload : {};
    ipcRenderer.send("desktop:notify", { title: str(p.title, 200), body: str(p.body, 600) });
  },
}));
