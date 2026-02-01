import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { chatCompletion, readPublicLlmConfig, writeLlmConfig } from './llm'
import { applyPlan, listDirectory, selectDirectory } from './fs-tools'
import { appendDailyMemory, appendLongTermMemory, getMemoryContext, getMemoryPaths, searchMemory } from './memory'
import { getStoreInfo, storeDelete, storeGet, storeSet } from './store'

if (is.dev && process.platform === 'win32' && process.env['WORKPAL_DEV_USE_TMP_USERDATA'] === '1') {
  app.setPath('userData', join(__dirname, '../../.tmp/userData'))
  app.setPath('sessionData', join(__dirname, '../../.tmp/sessionData'))
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    if (is.dev) {
      mainWindow.webContents.openDevTools()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.workpal.app')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  ipcMain.handle('llm:getConfig', async () => {
    return await readPublicLlmConfig()
  })

  ipcMain.handle('llm:setConfig', async (_event, input) => {
    return await writeLlmConfig(input ?? {})
  })

  ipcMain.handle('llm:chat', async (_event, input) => {
    const messages = Array.isArray(input?.messages) ? input.messages : []
    const temperature = typeof input?.temperature === 'number' ? input.temperature : undefined
    const maxTokens = typeof input?.maxTokens === 'number' ? input.maxTokens : undefined
    return await chatCompletion({ messages, temperature, maxTokens })
  })

  ipcMain.handle('fs:selectDirectory', async () => {
    return await selectDirectory()
  })

  ipcMain.handle('fs:list', async (_event, input) => {
    const root = typeof input?.root === 'string' ? input.root : ''
    const maxEntries = typeof input?.maxEntries === 'number' ? input.maxEntries : undefined
    return await listDirectory(root, { maxEntries })
  })

  ipcMain.handle('fs:applyPlan', async (_event, input) => {
    return await applyPlan({
      root: typeof input?.root === 'string' ? input.root : '',
      operations: Array.isArray(input?.operations) ? input.operations : [],
      commit: Boolean(input?.commit)
    })
  })

  ipcMain.handle('memory:getPaths', async () => {
    return await getMemoryPaths()
  })

  ipcMain.handle('memory:getContext', async () => {
    return await getMemoryContext()
  })

  ipcMain.handle('memory:appendDaily', async (_event, input) => {
    const text = typeof input?.text === 'string' ? input.text : ''
    const date = typeof input?.date === 'string' ? input.date : undefined
    return await appendDailyMemory({ text, date })
  })

  ipcMain.handle('memory:appendLongTerm', async (_event, input) => {
    const text = typeof input?.text === 'string' ? input.text : ''
    return await appendLongTermMemory({ text })
  })

  ipcMain.handle('memory:search', async (_event, input) => {
    const query = typeof input?.query === 'string' ? input.query : ''
    const limit = typeof input?.limit === 'number' ? input.limit : undefined
    return await searchMemory({ query, limit })
  })

  ipcMain.handle('store:getInfo', async () => {
    return getStoreInfo()
  })

  ipcMain.handle('store:get', async (_event, input) => {
    const key = typeof input?.key === 'string' ? input.key : ''
    if (!key) return null
    return storeGet(key)
  })

  ipcMain.handle('store:set', async (_event, input) => {
    const key = typeof input?.key === 'string' ? input.key : ''
    if (!key) return { ok: false }
    return storeSet(key, input?.value)
  })

  ipcMain.handle('store:delete', async (_event, input) => {
    const key = typeof input?.key === 'string' ? input.key : ''
    if (!key) return { ok: false }
    return storeDelete(key)
  })

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
