const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentr", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  getStatus: () => ipcRenderer.invoke("status:get"),
  getChecklist: () => ipcRenderer.invoke("checklist:get"),
  resolveAgent: (configured) => ipcRenderer.invoke("agent:resolve", configured),
  reconnect: () => ipcRenderer.invoke("worker:reconnect"),
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
  windowMinimize: () => ipcRenderer.invoke("window:minimize"),
  windowClose: () => ipcRenderer.invoke("window:close"),
  onStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("status:changed", handler);
    return () => ipcRenderer.removeListener("status:changed", handler);
  },
  onConsoleInit: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("console:init", handler);
    return () => ipcRenderer.removeListener("console:init", handler);
  },
  onConsoleLog: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("console:log", handler);
    return () => ipcRenderer.removeListener("console:log", handler);
  },
  onConsoleEnd: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("console:end", handler);
    return () => ipcRenderer.removeListener("console:end", handler);
  },
});
