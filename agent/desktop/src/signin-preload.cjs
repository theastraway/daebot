// Sandboxed preload for the first-run sign-in window. The only thing it exposes is submit(key) -> { ok, error? }.
// The key travels renderer -> main over IPC once and is never logged or kept here.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("daebotSignIn", Object.freeze({
  submit: (key) => ipcRenderer.invoke("daebot:signin", typeof key === "string" ? key.slice(0, 300) : ""),
}));
