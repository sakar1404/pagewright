const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, shell } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const DIST = path.join(__dirname, "..", "dist");
const approvedFiles = new Set();
const approvedFolders = new Set();
let win = null;
let dirty = false;
let forceClose = false;
let startupFile = process.argv.slice(app.isPackaged ? 1 : 2).find((arg) => arg.toLowerCase().endsWith(".pdf"));

const norm = (p) => path.resolve(p).toLowerCase();

async function readPicked(filePath) {
  approvedFiles.add(norm(filePath));
  return { path: filePath, name: path.basename(filePath), bytes: await fs.readFile(filePath) };
}

/** Write beside the target, then rename, so a failed write cannot damage the existing file. */
async function writeAtomic(target, bytes) {
  const temp = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temp, bytes);
    await fs.rename(temp, target);
  } catch (err) {
    await fs.rm(temp, { force: true });
    if (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES") {
      throw new Error(`${path.basename(target)} could not be written. It may be open in another program or read-only.`);
    }
    throw err;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Pagewright",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once("ready-to-show", () => win.show());
  // The app never navigates; links inside documents must not take over the window.
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  win.on("close", (event) => {
    if (!dirty || forceClose) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      title: "Unsaved changes",
      message: "Save your changes before closing?",
      detail: "If you don't save, your changes will be lost.",
      buttons: ["Save", "Don't Save", "Cancel"],
      defaultId: 0,
      cancelId: 2,
    });
    if (choice === 0) win.webContents.send("save-and-close");
    if (choice === 1) {
      forceClose = true;
      win.close();
    }
  });
  win.on("closed", () => { win = null; });
  win.loadURL("app://bundle/index.html");
}

ipcMain.handle("pick-files", async (_e, { title, filters, multi }) => {
  const result = await dialog.showOpenDialog(win, {
    title,
    filters,
    properties: multi ? ["openFile", "multiSelections"] : ["openFile"],
  });
  if (result.canceled) return [];
  return Promise.all(result.filePaths.map(readPicked));
});

ipcMain.handle("pick-save-path", async (_e, { title, defaultName, filters }) => {
  const result = await dialog.showSaveDialog(win, { title, defaultPath: defaultName, filters });
  if (result.canceled || !result.filePath) return null;
  approvedFiles.add(norm(result.filePath));
  return result.filePath;
});

ipcMain.handle("pick-folder", async (_e, title) => {
  const result = await dialog.showOpenDialog(win, { title, properties: ["openDirectory", "createDirectory"] });
  if (result.canceled || !result.filePaths[0]) return null;
  approvedFolders.add(norm(result.filePaths[0]));
  return result.filePaths[0];
});

ipcMain.handle("write-file", async (_e, target, bytes) => {
  if (!approvedFiles.has(norm(target))) throw new Error("That location was not chosen in a file dialog.");
  await writeAtomic(target, bytes);
});

ipcMain.handle("write-in-folder", async (_e, folder, name, bytes) => {
  if (!approvedFolders.has(norm(folder))) throw new Error("That folder was not chosen in a file dialog.");
  const target = path.join(folder, path.basename(name));
  await writeAtomic(target, bytes);
  return target;
});

ipcMain.handle("approve-dropped", (_e, filePath) => {
  if (!filePath || !filePath.toLowerCase().endsWith(".pdf")) return null;
  approvedFiles.add(norm(filePath));
  return filePath;
});

ipcMain.handle("reveal", (_e, target) => {
  if (approvedFiles.has(norm(target)) || approvedFolders.has(norm(path.dirname(target)))) shell.showItemInFolder(target);
});

ipcMain.on("set-dirty", (_e, value) => { dirty = Boolean(value); });
ipcMain.on("close-now", () => {
  forceClose = true;
  win?.close();
});
ipcMain.on("renderer-ready", async () => {
  if (!startupFile) return;
  const file = startupFile;
  startupFile = undefined;
  try {
    win.webContents.send("open-file", await readPicked(path.resolve(file)));
  } catch (err) {
    dialog.showErrorBox("Could not open file", err.message);
  }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  protocol.handle("app", (request) => {
    const relative = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "");
    const filePath = path.join(DIST, relative);
    if (!filePath.startsWith(DIST + path.sep)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString());
  });
  createWindow();
});

app.on("window-all-closed", () => app.quit());
