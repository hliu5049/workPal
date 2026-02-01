import Database from "better-sqlite3"
import { app } from "electron"
import { mkdirSync } from "fs"
import { join } from "path"

type KvRow = { key: string; value: string; updatedAt: number }

let db: Database.Database | null = null

function ensureDb(): Database.Database {
  if (db) return db
  const userData = app.getPath("userData")
  mkdirSync(userData, { recursive: true })
  const dbPath = join(userData, "workpal.sqlite")
  const instance = new Database(dbPath)
  instance.pragma("journal_mode = WAL")
  instance.exec(
    [
      "CREATE TABLE IF NOT EXISTS kv (",
      "  key TEXT PRIMARY KEY,",
      "  value TEXT NOT NULL,",
      "  updatedAt INTEGER NOT NULL",
      ");",
    ].join("\n")
  )
  db = instance
  return instance
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function getStoreInfo() {
  const userData = app.getPath("userData")
  const dbPath = join(userData, "workpal.sqlite")
  return { userData, dbPath }
}

export function storeGet(key: string): unknown | null {
  const db = ensureDb()
  const row = db.prepare("SELECT key, value, updatedAt FROM kv WHERE key = ?").get(key) as KvRow | undefined
  if (!row) return null
  return safeJsonParse(row.value)
}

export function storeSet(key: string, value: unknown): { ok: true } {
  const db = ensureDb()
  const now = Date.now()
  const serialized = JSON.stringify(value ?? null)
  db.prepare(
    "INSERT INTO kv(key, value, updatedAt) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt"
  ).run(key, serialized, now)
  return { ok: true }
}

export function storeDelete(key: string): { ok: true } {
  const db = ensureDb()
  db.prepare("DELETE FROM kv WHERE key = ?").run(key)
  return { ok: true }
}

