import { app } from "electron"
import { mkdir, readFile, writeFile, appendFile, readdir } from "fs/promises"
import { join } from "path"

function memoryBaseDir(): string {
  return join(app.getPath("userData"), "workpal-memory")
}

function longTermPath(): string {
  return join(memoryBaseDir(), "MEMORY.md")
}

function dailyDir(): string {
  return join(memoryBaseDir(), "memory")
}

function dailyPath(date: string): string {
  return join(dailyDir(), `${date}.md`)
}

function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function isoTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  return `${hh}:${mm}`
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8")
  } catch {
    return ""
  }
}

async function ensureLongTermFile(): Promise<void> {
  const base = memoryBaseDir()
  await mkdir(base, { recursive: true })
  const p = longTermPath()
  const existing = await readTextIfExists(p)
  if (existing.trim()) return
  const initial = ["# MEMORY", "", "长期记忆（精心维护，少而精）。", ""].join("\n")
  await writeFile(p, initial, "utf-8")
}

async function ensureDailyDir(): Promise<void> {
  await mkdir(dailyDir(), { recursive: true })
}

export async function getMemoryPaths(): Promise<{ baseDir: string; longTerm: string; dailyDir: string }> {
  return { baseDir: memoryBaseDir(), longTerm: longTermPath(), dailyDir: dailyDir() }
}

export async function getMemoryContext(): Promise<{
  longTerm: string
  today: string
  yesterday: string
  combined: string
  dateToday: string
  dateYesterday: string
}> {
  await ensureLongTermFile()
  await ensureDailyDir()

  const now = new Date()
  const today = isoDate(now)
  const yesterdayDate = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const yesterday = isoDate(yesterdayDate)

  const longTerm = await readTextIfExists(longTermPath())
  const todayText = await readTextIfExists(dailyPath(today))
  const yesterdayText = await readTextIfExists(dailyPath(yesterday))

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
    "",
  ].join("\n")

  return {
    longTerm,
    today: todayText,
    yesterday: yesterdayText,
    combined,
    dateToday: today,
    dateYesterday: yesterday,
  }
}

export async function appendDailyMemory(input: { text: string; date?: string }): Promise<{ path: string }> {
  await ensureDailyDir()
  const now = new Date()
  const date = typeof input.date === "string" && input.date.trim() ? input.date.trim() : isoDate(now)
  const p = dailyPath(date)
  const line = `- ${isoTime(now)} ${input.text.trim()}`
  await appendFile(p, `${line}\n`, "utf-8")
  return { path: p }
}

export async function appendLongTermMemory(input: { text: string }): Promise<{ path: string }> {
  await ensureLongTermFile()
  const now = new Date()
  const header = `## ${isoDate(now)} ${isoTime(now)}`
  const line = `- ${input.text.trim()}`
  await appendFile(longTermPath(), `\n${header}\n${line}\n`, "utf-8")
  return { path: longTermPath() }
}

export async function searchMemory(input: {
  query: string
  limit?: number
}): Promise<{ hits: { file: string; line: number; text: string }[] }> {
  const q = (input.query ?? "").trim()
  const limit = typeof input.limit === "number" && input.limit > 0 ? Math.min(input.limit, 200) : 50
  if (!q) return { hits: [] }

  await ensureLongTermFile()
  await ensureDailyDir()

  const files: string[] = [longTermPath()]
  try {
    const daily = await readdir(dailyDir())
    for (const f of daily) {
      if (!f.toLowerCase().endsWith(".md")) continue
      files.push(join(dailyDir(), f))
    }
  } catch {
  }

  const hits: { file: string; line: number; text: string }[] = []
  const needle = q.toLowerCase()
  for (const f of files) {
    const text = await readTextIfExists(f)
    if (!text) continue
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      const ln = lines[i] ?? ""
      if (ln.toLowerCase().includes(needle)) {
        hits.push({ file: f, line: i + 1, text: ln })
        if (hits.length >= limit) return { hits }
      }
    }
  }
  return { hits }
}

