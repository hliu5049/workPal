import { dialog, app, BrowserWindow } from "electron"
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "fs/promises"
import { dirname, join, normalize, relative, resolve, sep } from "path"

export type FsEntry = {
  path: string
  type: "file" | "dir"
  size: number
  mtimeMs: number
}

export type ReplaceTextOp = {
  op: "replaceText"
  path: string
  mode: "literal" | "regex"
  search: string
  replace: string
  flags?: string
}

export type MoveOp = { op: "move"; from: string; to: string }
export type MkdirOp = { op: "mkdir"; path: string }
export type DeleteOp = { op: "delete"; path: string }
export type FsOperation = ReplaceTextOp | MoveOp | MkdirOp | DeleteOp

export type ApplyPlanInput = {
  root: string
  operations: FsOperation[]
  commit: boolean
}

export type ApplyPlanResult = {
  ok: boolean
  root: string
  preview: { title: string; detail?: string }[]
  errors: string[]
}

function normalizeRoot(root: string): string {
  const abs = resolve(root)
  const withSep = abs.endsWith(sep) ? abs : abs + sep
  return withSep
}

function ensureWithinRoot(rootWithSep: string, relPath: string): string {
  if (typeof relPath !== "string" || !relPath.trim()) {
    throw new Error("path 不能为空")
  }
  const normalized = normalize(relPath).replace(/^[\\/]+/, "")
  const abs = resolve(rootWithSep, normalized)
  if (!abs.startsWith(rootWithSep)) {
    throw new Error(`路径越界：${relPath}`)
  }
  return abs
}

function toRel(rootWithSep: string, absPath: string): string {
  const rel = relative(rootWithSep, absPath)
  return rel.split(sep).join("/")
}

export async function selectDirectory(): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const res = await dialog.showOpenDialog(win, {
    title: "选择要整理/批量修改的文件夹",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: app.getPath("documents"),
  })
  if (res.canceled || res.filePaths.length === 0) return null
  return res.filePaths[0]
}

export async function listDirectory(root: string, opts?: { maxEntries?: number }): Promise<FsEntry[]> {
  const rootWithSep = normalizeRoot(root)
  const maxEntries = opts?.maxEntries ?? 5000
  const out: FsEntry[] = []

  const walk = async (absDir: string) => {
    if (out.length >= maxEntries) return
    const items = await readdir(absDir, { withFileTypes: true })
    for (const item of items) {
      if (out.length >= maxEntries) return
      const abs = join(absDir, item.name)
      const st = await stat(abs)
      if (item.isDirectory()) {
        out.push({
          path: toRel(rootWithSep, abs),
          type: "dir",
          size: 0,
          mtimeMs: st.mtimeMs,
        })
        await walk(abs)
      } else if (item.isFile()) {
        out.push({
          path: toRel(rootWithSep, abs),
          type: "file",
          size: st.size,
          mtimeMs: st.mtimeMs,
        })
      }
    }
  }

  await walk(rootWithSep)
  return out
}

function countMatchesLiteral(text: string, search: string): number {
  if (!search) return 0
  let count = 0
  let idx = 0
  while (true) {
    const next = text.indexOf(search, idx)
    if (next === -1) break
    count += 1
    idx = next + search.length
    if (search.length === 0) break
  }
  return count
}

function countMatchesRegex(text: string, re: RegExp): number {
  const globalRe = re.global ? re : new RegExp(re.source, re.flags + "g")
  let count = 0
  globalRe.lastIndex = 0
  while (globalRe.exec(text)) {
    count += 1
    if (!globalRe.global) break
  }
  return count
}

export async function applyPlan(input: ApplyPlanInput): Promise<ApplyPlanResult> {
  const rootWithSep = normalizeRoot(input.root)
  const preview: { title: string; detail?: string }[] = []
  const errors: string[] = []

  const ops = Array.isArray(input.operations) ? input.operations : []

  const execMkdir = async (rel: string) => {
    const abs = ensureWithinRoot(rootWithSep, rel)
    await mkdir(abs, { recursive: true })
  }

  const execMove = async (fromRel: string, toRelPath: string) => {
    const fromAbs = ensureWithinRoot(rootWithSep, fromRel)
    const toAbs = ensureWithinRoot(rootWithSep, toRelPath)
    await mkdir(dirname(toAbs), { recursive: true })
    await rename(fromAbs, toAbs)
  }

  const execDelete = async (rel: string) => {
    const abs = ensureWithinRoot(rootWithSep, rel)
    await rm(abs, { recursive: true, force: true })
  }

  const execReplace = async (op: ReplaceTextOp) => {
    const abs = ensureWithinRoot(rootWithSep, op.path)
    const st = await stat(abs)
    if (!st.isFile()) {
      throw new Error(`不是文件：${op.path}`)
    }
    if (st.size > 2 * 1024 * 1024) {
      throw new Error(`文件过大，跳过替换（>2MB）：${op.path}`)
    }
    const raw = await readFile(abs, "utf-8")
    let next = raw
    let matchCount = 0

    if (op.mode === "regex") {
      const flags = typeof op.flags === "string" ? op.flags : "g"
      const re = new RegExp(op.search, flags.includes("g") ? flags : flags + "g")
      matchCount = countMatchesRegex(raw, re)
      next = raw.replace(re, op.replace)
    } else {
      matchCount = countMatchesLiteral(raw, op.search)
      next = raw.split(op.search).join(op.replace)
    }

    preview.push({
      title: `${input.commit ? "替换" : "将替换"} ${op.path}`,
      detail: `匹配次数：${matchCount}`,
    })

    if (!input.commit) return
    if (next === raw) return
    await writeFile(abs, next, "utf-8")
  }

  for (const op of ops) {
    try {
      if (op.op === "mkdir") {
        preview.push({ title: `${input.commit ? "创建目录" : "将创建目录"} ${op.path}` })
        if (input.commit) await execMkdir(op.path)
      } else if (op.op === "move") {
        preview.push({ title: `${input.commit ? "移动" : "将移动"} ${op.from} → ${op.to}` })
        if (input.commit) await execMove(op.from, op.to)
      } else if (op.op === "delete") {
        preview.push({ title: `${input.commit ? "删除" : "将删除"} ${op.path}` })
        if (input.commit) await execDelete(op.path)
      } else if (op.op === "replaceText") {
        await execReplace(op)
      } else {
        throw new Error(`未知操作: ${(op as any).op}`)
      }
    } catch (e: any) {
      errors.push(e?.message ? String(e.message) : "未知错误")
    }
  }

  return { ok: errors.length === 0, root: rootWithSep, preview, errors }
}
