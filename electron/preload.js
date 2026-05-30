const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  openUploadFolder: () => ipcRenderer.send("open-folder"),
  pickUploadFolder: () => ipcRenderer.invoke("pick-folder"),
  getInfo: () => ipcRenderer.invoke("get-info"),
  setReadOnly: (value) => ipcRenderer.invoke("set-readonly", value),
  quitApp: () => ipcRenderer.send("quit-app"),
  onFilesChanged: (cb) => ipcRenderer.on("files-changed", () => cb()),
});
