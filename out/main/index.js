"use strict";
const electron = require("electron");
const path = require("path");
const utils = require("@electron-toolkit/utils");
const promises = require("fs/promises");
const Database = require("better-sqlite3");
const fs = require("fs");
function configPath() {
  return path.join(electron.app.getPath("userData"), "llm-config.json");
}
function toPublic(cfg) {
  const { apiKey, ...rest } = cfg;
  return { ...rest, apiKeyPresent: Boolean(apiKey && apiKey.trim()) };
}
async function readLlmConfig() {
  const fallback = {
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    temperature: 0.7,
    maxTokens: 1024
  };
  try {
    const raw = await promises.readFile(configPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return {
      ...fallback,
      ...parsed,
      provider: "openai-compatible"
    };
  } catch {
    return fallback;
  }
}
async function readPublicLlmConfig() {
  const cfg = await readLlmConfig();
  return toPublic(cfg);
}
async function writeLlmConfig(input) {
  const current = await readLlmConfig();
  const next = {
    ...current,
    provider: "openai-compatible",
    baseUrl: typeof input.baseUrl === "string" ? input.baseUrl : current.baseUrl,
    model: typeof input.model === "string" ? input.model : current.model,
    temperature: typeof input.temperature === "number" ? input.temperature : current.temperature,
    maxTokens: typeof input.maxTokens === "number" ? input.maxTokens : current.maxTokens,
    apiKey: current.apiKey
  };
  if (input.clearApiKey) {
    next.apiKey = "";
  } else if (typeof input.apiKey === "string" && input.apiKey.trim()) {
    next.apiKey = input.apiKey;
  }
  const path$1 = configPath();
  await promises.mkdir(path.dirname(path$1), { recursive: true });
  await promises.writeFile(path$1, JSON.stringify(next, null, 2), "utf-8");
  return toPublic(next);
}
function normalizeBaseUrl(baseUrl) {
  return baseUrl.trim().replace(/\/+$/, "");
}
async function chatCompletion(args) {
  const cfg = await readLlmConfig();
  const baseUrl = normalizeBaseUrl(cfg.baseUrl);
  const url = `${baseUrl}/chat/completions`;
  const body = {
    model: cfg.model,
    messages: args.messages,
    temperature: typeof args.temperature === "number" ? args.temperature : cfg.temperature,
    max_tokens: typeof args.maxTokens === "number" ? args.maxTokens : cfg.maxTokens,
    stream: false
  };
  const headers = {
    "content-type": "application/json"
  };
  if (cfg.apiKey && cfg.apiKey.trim()) {
    headers.authorization = `Bearer ${cfg.apiKey}`;
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM request failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ""}`);
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.text;
  if (typeof content !== "string") {
    throw new Error("LLM response missing message content");
  }
  return { text: content };
}
function normalizeRoot(root) {
  const abs = path.resolve(root);
  const withSep = abs.endsWith(path.sep) ? abs : abs + path.sep;
  return withSep;
}
function ensureWithinRoot(rootWithSep, relPath) {
  if (typeof relPath !== "string" || !relPath.trim()) {
    throw new Error("path 不能为空");
  }
  const normalized = path.normalize(relPath).replace(/^[\\/]+/, "");
  const abs = path.resolve(rootWithSep, normalized);
  if (!abs.startsWith(rootWithSep)) {
    throw new Error(`路径越界：${relPath}`);
  }
  return abs;
}
function toRel(rootWithSep, absPath) {
  const rel = path.relative(rootWithSep, absPath);
  return rel.split(path.sep).join("/");
}
async function selectDirectory() {
  const win = electron.BrowserWindow.getFocusedWindow() ?? electron.BrowserWindow.getAllWindows()[0];
  const res = await electron.dialog.showOpenDialog(win, {
    title: "选择要整理/批量修改的文件夹",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: electron.app.getPath("documents")
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
}
async function listDirectory(root, opts) {
  const rootWithSep = normalizeRoot(root);
  const maxEntries = opts?.maxEntries ?? 5e3;
  const out = [];
  const walk = async (absDir) => {
    if (out.length >= maxEntries) return;
    const items = await promises.readdir(absDir, { withFileTypes: true });
    for (const item of items) {
      if (out.length >= maxEntries) return;
      const abs = path.join(absDir, item.name);
      const st = await promises.stat(abs);
      if (item.isDirectory()) {
        out.push({
          path: toRel(rootWithSep, abs),
          type: "dir",
          size: 0,
          mtimeMs: st.mtimeMs
        });
        await walk(abs);
      } else if (item.isFile()) {
        out.push({
          path: toRel(rootWithSep, abs),
          type: "file",
          size: st.size,
          mtimeMs: st.mtimeMs
        });
      }
    }
  };
  await walk(rootWithSep);
  return out;
}
function countMatchesLiteral(text, search) {
  if (!search) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const next = text.indexOf(search, idx);
    if (next === -1) break;
    count += 1;
    idx = next + search.length;
    if (search.length === 0) break;
  }
  return count;
}
function countMatchesRegex(text, re) {
  const globalRe = re.global ? re : new RegExp(re.source, re.flags + "g");
  let count = 0;
  globalRe.lastIndex = 0;
  while (globalRe.exec(text)) {
    count += 1;
    if (!globalRe.global) break;
  }
  return count;
}
async function applyPlan(input) {
  const rootWithSep = normalizeRoot(input.root);
  const preview = [];
  const errors = [];
  const ops = Array.isArray(input.operations) ? input.operations : [];
  const execMkdir = async (rel) => {
    const abs = ensureWithinRoot(rootWithSep, rel);
    await promises.mkdir(abs, { recursive: true });
  };
  const execMove = async (fromRel, toRelPath) => {
    const fromAbs = ensureWithinRoot(rootWithSep, fromRel);
    const toAbs = ensureWithinRoot(rootWithSep, toRelPath);
    await promises.mkdir(path.dirname(toAbs), { recursive: true });
    await promises.rename(fromAbs, toAbs);
  };
  const execDelete = async (rel) => {
    const abs = ensureWithinRoot(rootWithSep, rel);
    await promises.rm(abs, { recursive: true, force: true });
  };
  const execReplace = async (op) => {
    const abs = ensureWithinRoot(rootWithSep, op.path);
    const st = await promises.stat(abs);
    if (!st.isFile()) {
      throw new Error(`不是文件：${op.path}`);
    }
    if (st.size > 2 * 1024 * 1024) {
      throw new Error(`文件过大，跳过替换（>2MB）：${op.path}`);
    }
    const raw = await promises.readFile(abs, "utf-8");
    let next = raw;
    let matchCount = 0;
    if (op.mode === "regex") {
      const flags = typeof op.flags === "string" ? op.flags : "g";
      const re = new RegExp(op.search, flags.includes("g") ? flags : flags + "g");
      matchCount = countMatchesRegex(raw, re);
      next = raw.replace(re, op.replace);
    } else {
      matchCount = countMatchesLiteral(raw, op.search);
      next = raw.split(op.search).join(op.replace);
    }
    preview.push({
      title: `${input.commit ? "替换" : "将替换"} ${op.path}`,
      detail: `匹配次数：${matchCount}`
    });
    if (!input.commit) return;
    if (next === raw) return;
    await promises.writeFile(abs, next, "utf-8");
  };
  for (const op of ops) {
    try {
      if (op.op === "mkdir") {
        preview.push({ title: `${input.commit ? "创建目录" : "将创建目录"} ${op.path}` });
        if (input.commit) await execMkdir(op.path);
      } else if (op.op === "move") {
        preview.push({ title: `${input.commit ? "移动" : "将移动"} ${op.from} → ${op.to}` });
        if (input.commit) await execMove(op.from, op.to);
      } else if (op.op === "delete") {
        preview.push({ title: `${input.commit ? "删除" : "将删除"} ${op.path}` });
        if (input.commit) await execDelete(op.path);
      } else if (op.op === "replaceText") {
        await execReplace(op);
      } else {
        throw new Error(`未知操作: ${op.op}`);
      }
    } catch (e) {
      errors.push(e?.message ? String(e.message) : "未知错误");
    }
  }
  return { ok: errors.length === 0, root: rootWithSep, preview, errors };
}
function memoryBaseDir() {
  return path.join(electron.app.getPath("userData"), "workpal-memory");
}
function longTermPath() {
  return path.join(memoryBaseDir(), "MEMORY.md");
}
function dailyDir() {
  return path.join(memoryBaseDir(), "memory");
}
function dailyPath(date) {
  return path.join(dailyDir(), `${date}.md`);
}
function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function isoTime(d) {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
async function readTextIfExists(path2) {
  try {
    return await promises.readFile(path2, "utf-8");
  } catch {
    return "";
  }
}
async function ensureLongTermFile() {
  const base = memoryBaseDir();
  await promises.mkdir(base, { recursive: true });
  const p = longTermPath();
  const existing = await readTextIfExists(p);
  if (existing.trim()) return;
  const initial = ["# MEMORY", "", "长期记忆（精心维护，少而精）。", ""].join("\n");
  await promises.writeFile(p, initial, "utf-8");
}
async function ensureDailyDir() {
  await promises.mkdir(dailyDir(), { recursive: true });
}
async function getMemoryPaths() {
  return { baseDir: memoryBaseDir(), longTerm: longTermPath(), dailyDir: dailyDir() };
}
async function getMemoryContext() {
  await ensureLongTermFile();
  await ensureDailyDir();
  const now = /* @__PURE__ */ new Date();
  const today = isoDate(now);
  const yesterdayDate = new Date(now.getTime() - 24 * 60 * 60 * 1e3);
  const yesterday = isoDate(yesterdayDate);
  const longTerm = await readTextIfExists(longTermPath());
  const todayText = await readTextIfExists(dailyPath(today));
  const yesterdayText = await readTextIfExists(dailyPath(yesterday));
  const combined = [
    "以下是已加载的记忆（长期 + 近两日日志）。请将其视为高优先级上下文。",
    "",
    "【长期记忆 / MEMORY.md】",
    longTerm.trim() ? longTerm.trim() : "（空）",
    "",
    `【短期记忆 / memory/${today}.md】`,
    todayText.trim() ? todayText.trim() : "（空）",
    "",
    `【短期记忆 / memory/${yesterday}.md】`,
    yesterdayText.trim() ? yesterdayText.trim() : "（空）",
    ""
  ].join("\n");
  return {
    longTerm,
    today: todayText,
    yesterday: yesterdayText,
    combined,
    dateToday: today,
    dateYesterday: yesterday
  };
}
async function appendDailyMemory(input) {
  await ensureDailyDir();
  const now = /* @__PURE__ */ new Date();
  const date = typeof input.date === "string" && input.date.trim() ? input.date.trim() : isoDate(now);
  const p = dailyPath(date);
  const line = `- ${isoTime(now)} ${input.text.trim()}`;
  await promises.appendFile(p, `${line}
`, "utf-8");
  return { path: p };
}
async function appendLongTermMemory(input) {
  await ensureLongTermFile();
  const now = /* @__PURE__ */ new Date();
  const header = `## ${isoDate(now)} ${isoTime(now)}`;
  const line = `- ${input.text.trim()}`;
  await promises.appendFile(longTermPath(), `
${header}
${line}
`, "utf-8");
  return { path: longTermPath() };
}
async function searchMemory(input) {
  const q = (input.query ?? "").trim();
  const limit = typeof input.limit === "number" && input.limit > 0 ? Math.min(input.limit, 200) : 50;
  if (!q) return { hits: [] };
  await ensureLongTermFile();
  await ensureDailyDir();
  const files = [longTermPath()];
  try {
    const daily = await promises.readdir(dailyDir());
    for (const f of daily) {
      if (!f.toLowerCase().endsWith(".md")) continue;
      files.push(path.join(dailyDir(), f));
    }
  } catch {
  }
  const hits = [];
  const needle = q.toLowerCase();
  for (const f of files) {
    const text = await readTextIfExists(f);
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const ln = lines[i] ?? "";
      if (ln.toLowerCase().includes(needle)) {
        hits.push({ file: f, line: i + 1, text: ln });
        if (hits.length >= limit) return { hits };
      }
    }
  }
  return { hits };
}
let db = null;
function ensureDb() {
  if (db) return db;
  const userData = electron.app.getPath("userData");
  fs.mkdirSync(userData, { recursive: true });
  const dbPath = path.join(userData, "workpal.sqlite");
  const instance = new Database(dbPath);
  instance.pragma("journal_mode = WAL");
  instance.exec(
    [
      "CREATE TABLE IF NOT EXISTS kv (",
      "  key TEXT PRIMARY KEY,",
      "  value TEXT NOT NULL,",
      "  updatedAt INTEGER NOT NULL",
      ");"
    ].join("\n")
  );
  db = instance;
  return instance;
}
function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function getStoreInfo() {
  const userData = electron.app.getPath("userData");
  const dbPath = path.join(userData, "workpal.sqlite");
  return { userData, dbPath };
}
function storeGet(key) {
  const db2 = ensureDb();
  const row = db2.prepare("SELECT key, value, updatedAt FROM kv WHERE key = ?").get(key);
  if (!row) return null;
  return safeJsonParse(row.value);
}
function storeSet(key, value) {
  const db2 = ensureDb();
  const now = Date.now();
  const serialized = JSON.stringify(value ?? null);
  db2.prepare(
    "INSERT INTO kv(key, value, updatedAt) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt"
  ).run(key, serialized, now);
  return { ok: true };
}
function storeDelete(key) {
  const db2 = ensureDb();
  db2.prepare("DELETE FROM kv WHERE key = ?").run(key);
  return { ok: true };
}
if (utils.is.dev && process.platform === "win32" && process.env["WORKPAL_DEV_USE_TMP_USERDATA"] === "1") {
  electron.app.setPath("userData", path.join(__dirname, "../../.tmp/userData"));
  electron.app.setPath("sessionData", path.join(__dirname, "../../.tmp/sessionData"));
}
function createWindow() {
  const mainWindow = new electron.BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
    if (utils.is.dev) {
      mainWindow.webContents.openDevTools();
    }
  });
  mainWindow.webContents.setWindowOpenHandler((details) => {
    electron.shell.openExternal(details.url);
    return { action: "deny" };
  });
  if (utils.is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}
electron.app.whenReady().then(() => {
  utils.electronApp.setAppUserModelId("com.workpal.app");
  electron.app.on("browser-window-created", (_, window) => {
    utils.optimizer.watchWindowShortcuts(window);
  });
  createWindow();
  electron.ipcMain.handle("llm:getConfig", async () => {
    return await readPublicLlmConfig();
  });
  electron.ipcMain.handle("llm:setConfig", async (_event, input) => {
    return await writeLlmConfig(input ?? {});
  });
  electron.ipcMain.handle("llm:chat", async (_event, input) => {
    const messages = Array.isArray(input?.messages) ? input.messages : [];
    const temperature = typeof input?.temperature === "number" ? input.temperature : void 0;
    const maxTokens = typeof input?.maxTokens === "number" ? input.maxTokens : void 0;
    return await chatCompletion({ messages, temperature, maxTokens });
  });
  electron.ipcMain.handle("fs:selectDirectory", async () => {
    return await selectDirectory();
  });
  electron.ipcMain.handle("fs:list", async (_event, input) => {
    const root = typeof input?.root === "string" ? input.root : "";
    const maxEntries = typeof input?.maxEntries === "number" ? input.maxEntries : void 0;
    return await listDirectory(root, { maxEntries });
  });
  electron.ipcMain.handle("fs:applyPlan", async (_event, input) => {
    return await applyPlan({
      root: typeof input?.root === "string" ? input.root : "",
      operations: Array.isArray(input?.operations) ? input.operations : [],
      commit: Boolean(input?.commit)
    });
  });
  electron.ipcMain.handle("memory:getPaths", async () => {
    return await getMemoryPaths();
  });
  electron.ipcMain.handle("memory:getContext", async () => {
    return await getMemoryContext();
  });
  electron.ipcMain.handle("memory:appendDaily", async (_event, input) => {
    const text = typeof input?.text === "string" ? input.text : "";
    const date = typeof input?.date === "string" ? input.date : void 0;
    return await appendDailyMemory({ text, date });
  });
  electron.ipcMain.handle("memory:appendLongTerm", async (_event, input) => {
    const text = typeof input?.text === "string" ? input.text : "";
    return await appendLongTermMemory({ text });
  });
  electron.ipcMain.handle("memory:search", async (_event, input) => {
    const query = typeof input?.query === "string" ? input.query : "";
    const limit = typeof input?.limit === "number" ? input.limit : void 0;
    return await searchMemory({ query, limit });
  });
  electron.ipcMain.handle("store:getInfo", async () => {
    return getStoreInfo();
  });
  electron.ipcMain.handle("store:get", async (_event, input) => {
    const key = typeof input?.key === "string" ? input.key : "";
    if (!key) return null;
    return storeGet(key);
  });
  electron.ipcMain.handle("store:set", async (_event, input) => {
    const key = typeof input?.key === "string" ? input.key : "";
    if (!key) return { ok: false };
    return storeSet(key, input?.value);
  });
  electron.ipcMain.handle("store:delete", async (_event, input) => {
    const key = typeof input?.key === "string" ? input.key : "";
    if (!key) return { ok: false };
    return storeDelete(key);
  });
  electron.app.on("activate", function() {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});
