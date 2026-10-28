// Sandboxed preload (must be CommonJS). Exposes the smallest possible surface to the web UI:
//   window.mindclawDesktop.notify({ title, body })   optional hook the web UI MAY call; main validates, rate-limits
//                                                      and only honors it from the gateway origin.
//   window.mindclawDesktop.signOut()                  signs the app out of MIND (main only honors it from the gateway origin)
//   window.mindclawDesktop.updates.get() / check() / install() / onChange(cb)   the in-window update control (main only
//                                                      answers the gateway origin; install() restarts into the new version)
//   window.mindclawDesktop.platform / version         read-only strings
// The desktop shell also watches confirm events itself, so the web UI does not need to call notify() at all.
const { contextBridge, ipcRenderer } = require("electron");

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

contextBridge.exposeInMainWorld("mindclawDesktop", Object.freeze({
  platform: process.platform,
  version: "0.2.0",
  signOut() { ipcRenderer.send("desktop:signout"); },
  updates: Object.freeze({
    get: () => ipcRenderer.invoke("desktop:update-get"),
    check: () => ipcRenderer.invoke("desktop:update-check"),
    install: () => ipcRenderer.invoke("desktop:update-install"),
    onChange(cb) {
      if (typeof cb !== "function") return;
      ipcRenderer.on("desktop:update-state", (_e, s) => { try { cb(s); } catch { /* UI bug must not break updates */ } });
    },
  }),
  notify(payload) {
    const p = payload && typeof payload === "object" ? payload : {};
    ipcRenderer.send("desktop:notify", { title: str(p.title, 200), body: str(p.body, 600) });
  },
}));
