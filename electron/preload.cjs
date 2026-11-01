// The only bridge between the page and the OS. The page has no Node access.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("studio", {
  pickFiles: (options) => ipcRenderer.invoke("pick-files", options),
  pickSavePath: (options) => ipcRenderer.invoke("pick-save-path", options),
  pickFolder: (title) => ipcRenderer.invoke("pick-folder", title),
  writeFile: (path, bytes) => ipcRenderer.invoke("write-file", path, bytes),
  writeInFolder: (folder, name, bytes) => ipcRenderer.invoke("write-in-folder", folder, name, bytes),
  approveDropped: (file) => ipcRenderer.invoke("approve-dropped", webUtils.getPathForFile(file)),
  reveal: (path) => ipcRenderer.invoke("reveal", path),
  setDirty: (dirty) => ipcRenderer.send("set-dirty", dirty),
  closeNow: () => ipcRenderer.send("close-now"),
  onSaveAndClose: (callback) => ipcRenderer.on("save-and-close", () => callback()),
  onOpenFile: (callback) => ipcRenderer.on("open-file", (_event, file) => callback(file)),
  ready: () => ipcRenderer.send("renderer-ready"),
});
