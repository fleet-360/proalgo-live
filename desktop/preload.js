const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("live", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (cfg) => ipcRenderer.invoke("config:set", cfg),
  api: (method, route, body) => ipcRenderer.invoke("api", { method, route, body }),
  uploadAudio: (payload) => ipcRenderer.invoke("audio:upload", payload),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  copy: (text) => ipcRenderer.invoke("clipboard:write", text),
  setRecording: (value) => ipcRenderer.invoke("recording:set", value),
  version: () => ipcRenderer.invoke("app:version"),
  selfTestDone: (report) => ipcRenderer.invoke("selftest:done", report),
  onPromptStart: (fn) => ipcRenderer.on("prompt-start", (_e, data) => fn(data)),
  onMicActive: (fn) => ipcRenderer.on("mic-active", (_e, data) => fn(data)),
  onCallMaybeEnded: (fn) => ipcRenderer.on("call-maybe-ended", (_e, data) => fn(data)),
  onEndAndQuit: (fn) => ipcRenderer.on("end-and-quit", () => fn()),
  quit: () => ipcRenderer.invoke("app:quit"),
});
