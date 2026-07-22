const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentr", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  getStatus: () => ipcRenderer.invoke("status:get"),
  reconnect: () => ipcRenderer.invoke("worker:reconnect"),
  onStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("status:changed", handler);
    return () => ipcRenderer.removeListener("status:changed", handler);
  },
});
