const { contextBridge, ipcRenderer } = require("electron");
const allowed = [
  "snapshot",
  "status",
  "bind",
  "scan",
  "bindArchives",
  "package",
  "prepare",
  "launch",
  "host",
  "join",
  "stop",
  "fillBots",
  "saveRoom",
  "saveLaunchOptions",
  "openFolder",
  "copy",
  "importMedia",
];
const api = {};
for (const name of allowed)
  api[name] = async (data) => {
    const r = await ipcRenderer.invoke("chronicle:" + name, data);
    if (!r.ok) throw Error(r.error);
    return r.value;
  };
contextBridge.exposeInMainWorld("chronicle", Object.freeze(api));
