import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { ipcRenderer } from 'electron'

// Custom APIs for renderer
const api = {
  llm: {
    getConfig: () => ipcRenderer.invoke('llm:getConfig'),
    setConfig: (input: any) => ipcRenderer.invoke('llm:setConfig', input),
    chat: (input: any) => ipcRenderer.invoke('llm:chat', input)
  },
  fs: {
    selectDirectory: () => ipcRenderer.invoke('fs:selectDirectory'),
    list: (input: any) => ipcRenderer.invoke('fs:list', input),
    applyPlan: (input: any) => ipcRenderer.invoke('fs:applyPlan', input)
  },
  memory: {
    getPaths: () => ipcRenderer.invoke('memory:getPaths'),
    getContext: () => ipcRenderer.invoke('memory:getContext'),
    appendDaily: (input: any) => ipcRenderer.invoke('memory:appendDaily', input),
    appendLongTerm: (input: any) => ipcRenderer.invoke('memory:appendLongTerm', input),
    search: (input: any) => ipcRenderer.invoke('memory:search', input)
  },
  store: {
    getInfo: () => ipcRenderer.invoke('store:getInfo'),
    get: (key: string) => ipcRenderer.invoke('store:get', { key }),
    set: (key: string, value: any) => ipcRenderer.invoke('store:set', { key, value }),
    delete: (key: string) => ipcRenderer.invoke('store:delete', { key })
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
