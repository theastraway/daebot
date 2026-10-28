// Sandboxed preload (must be CommonJS). Exposes the smallest possible surface to the web UI:
//   window.mindclawDesktop.notify({ title, body })   optional hook the web UI MAY call; main validates, rate-limits
//                                                      and only honors it from the gateway origin.
//   window.mindclawDesktop.signOut({ all })           signs out the ACTIVE account (another remembered one takes over); all:true signs out of every account
//   window.mindclawDesktop.accounts.list() / switch(id) / add()   remembered accounts: ids and names only, never a key; switch restarts the gateway
//                                                      as that account, add opens the sign-in window (all main-process, gateway origin only)
//   window.mindclawDesktop.updates.get() / check() / install() / onChange(cb)   the in-window update control (main only
//                                                      answers the gateway origin; install() restarts into the new version)
//   window.mindclawDesktop.calendar.call(op, args)    Mac only: Apple Calendar through the bundled EventKit helper -> { ok, result | error }.
//                                                      Absent on Windows and Linux, so the web UI sees no Calendar bridge there.
//   window.mindclawDesktop.platform / version         read-only strings
// The desktop shell also watches confirm events itself, so the web UI does not need to call notify() at all.
const { contextBridge, ipcRenderer } = require("electron");

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
const CALENDAR_OPS = ["status", "request", "calendars", "events", "create", "update", "delete"];

contextBridge.exposeInMainWorld("mindclawDesktop", Object.freeze({
  platform: process.platform,
  version: "0.2.0",
  signOut(opts) { ipcRenderer.send("desktop:signout", { all: !!(opts && typeof opts === "object" && opts.all === true) }); },
  accounts: Object.freeze({
    list: () => ipcRenderer.invoke("desktop:accounts-list"),
    switch: (id) => ipcRenderer.invoke("desktop:account-switch", typeof id === "string" ? id.slice(0, 64) : ""),
    add: () => ipcRenderer.invoke("desktop:account-add"),
  }),
  updates: Object.freeze({
    get: () => ipcRenderer.invoke("desktop:update-get"),
    check: () => ipcRenderer.invoke("desktop:update-check"),
    install: () => ipcRenderer.invoke("desktop:update-install"),
    onChange(cb) {
      if (typeof cb !== "function") return;
      ipcRenderer.on("desktop:update-state", (_e, s) => { try { cb(s); } catch { /* UI bug must not break updates */ } });
    },
  }),
  ...(process.platform === "darwin" ? {
    calendar: Object.freeze({
      call: (op, args) => ipcRenderer.invoke("desktop:calendar", typeof op === "string" && CALENDAR_OPS.includes(op) ? op : "", args && typeof args === "object" && !Array.isArray(args) ? args : {}),
    }),
  } : {}),
  notify(payload) {
    const p = payload && typeof payload === "object" ? payload : {};
    ipcRenderer.send("desktop:notify", { title: str(p.title, 200), body: str(p.body, 600) });
  },
}));
