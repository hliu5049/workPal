"use strict";
const electron = require("electron");
const preload = require("@electron-toolkit/preload");
const api = {
  llm: {
    getConfig: () => electron.ipcRenderer.invoke("llm:getConfig"),
    setConfig: (input) => electron.ipcRenderer.invoke("llm:setConfig", input),
    chat: (input) => electron.ipcRenderer.invoke("llm:chat", input)
  },
  fs: {
    selectDirectory: () => electron.ipcRenderer.invoke("fs:selectDirectory"),
    list: (input) => electron.ipcRenderer.invoke("fs:list", input),
    applyPlan: (input) => electron.ipcRenderer.invoke("fs:applyPlan", input)
  },
  memory: {
    getPaths: () => electron.ipcRenderer.invoke("memory:getPaths"),
    getContext: () => electron.ipcRenderer.invoke("memory:getContext"),
    appendDaily: (input) => electron.ipcRenderer.invoke("memory:appendDaily", input),
    appendLongTerm: (input) => electron.ipcRenderer.invoke("memory:appendLongTerm", input),
    search: (input) => electron.ipcRenderer.invoke("memory:search", input)
  },
  store: {
    getInfo: () => electron.ipcRenderer.invoke("store:getInfo"),
    get: (key) => electron.ipcRenderer.invoke("store:get", { key }),
    set: (key, value) => electron.ipcRenderer.invoke("store:set", { key, value }),
    delete: (key) => electron.ipcRenderer.invoke("store:delete", { key })
  }
};
if (process.contextIsolated) {
  try {
    electron.contextBridge.exposeInMainWorld("electron", preload.electronAPI);
    electron.contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error(error);
  }
} else {
  window.electron = preload.electronAPI;
  window.api = api;
}
