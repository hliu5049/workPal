import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { Separator } from "@renderer/components/ui/separator"
import { cn } from "@renderer/lib/utils"
import {
  FolderOpen,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Send,
  Settings,
  Trash2,
} from "lucide-react"
import React, { useEffect, useMemo, useRef, useState } from "react"
import { TooltipProvider } from "@renderer/components/ui/tooltip"
import { Avatar, AvatarFallback, AvatarImage } from "@renderer/components/ui/avatar"
import { Button } from "@renderer/components/ui/button"
import { Input } from "@renderer/components/ui/input"
import { Textarea } from "@renderer/components/ui/textarea"

type ChatRole = "user" | "ai"
type ChatAction =
  | { type: "applyPlan"; planId: string; label?: string; variant?: "default" | "secondary" | "outline" | "ghost" }
  | { type: "cancelPlan"; planId: string; label?: string; variant?: "default" | "secondary" | "outline" | "ghost" }

type ChatMessage = { role: ChatRole; content: string; createdAt: number; actions?: ChatAction[] }
type ChatSession = {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}

type ActiveView = "chat" | "settings"

type PublicLlmConfig = {
  provider: "openai-compatible"
  baseUrl: string
  model: string
  temperature?: number
  maxTokens?: number
  apiKeyPresent: boolean
}

type FsPlanOp =
  | { op: "mkdir"; path: string }
  | { op: "move"; from: string; to: string }
  | { op: "delete"; path: string }
  | {
      op: "replaceText"
      path: string
      mode: "literal" | "regex"
      search: string
      replace: string
      flags?: string
    }

interface NavProps {
  isCollapsed: boolean
  links: {
    title: string
    label?: string
    icon: React.ElementType
    variant: "default" | "ghost"
    onClick?: () => void
  }[]
}

function Nav({ links, isCollapsed }: NavProps) {
  return (
    <div
      data-collapsed={isCollapsed}
      className="group flex flex-col gap-4 py-2 data-[collapsed=true]:py-2"
    >
      <nav className="grid gap-1 px-2 group-[[data-collapsed=true]]:justify-center group-[[data-collapsed=true]]:px-2">
        {links.map((link, index) => (
          <button
            type="button"
            key={index}
            onClick={link.onClick}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground",
              link.variant === "default" &&
                "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
              isCollapsed && "justify-center px-2"
            )}
          >
            <link.icon className="h-4 w-4" />
            {!isCollapsed && <span>{link.title}</span>}
            {!isCollapsed && link.label && (
              <span className="ml-auto text-muted-foreground">{link.label}</span>
            )}
          </button>
        ))}
      </nav>
    </div>
  )
}

const STORAGE_KEY = "workpal.chat.v1"
const FS_ROOTS_KEY = "workpal.fsroots.v1"
const AVATAR_KEY = "workpal.avatars.v1"
const UI_PREFS_KEY = "workpal.ui.v1"

function createId(): string {
  const cryptoAny = crypto as unknown as { randomUUID?: () => string }
  if (cryptoAny?.randomUUID) return cryptoAny.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function defaultGreeting(): ChatMessage[] {
  return [{ role: "ai", content: "Hello! How can I help you today?", createdAt: Date.now() }]
}

function extractJson(text: string): string {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i)
  if (fenced?.[1]) return fenced[1]
  const fencedAny = text.match(/```([\s\S]*?)```/i)
  if (fencedAny?.[1]) return fencedAny[1]
  return text
}

function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, "")
    .trim()
}

function stripThinkingForDisplay(text: string): string {
  const withoutTags = stripThinking(text)
    .replace(/```(?:thinking|analysis)\s*[\s\S]*?\s*```/gi, "")
    .replace(/^\s*(thinking|analysis)\s*:[\s\S]*$/gim, "")
  return withoutTags.replace(/\n{3,}/g, "\n\n").trim()
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error("读取文件失败"))
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "")
    reader.readAsDataURL(file)
  })
}

function calcTypewriterStep(totalChars: number): number {
  if (totalChars >= 4000) return 10
  if (totalChars >= 2500) return 8
  if (totalChars >= 1600) return 6
  if (totalChars >= 900) return 4
  if (totalChars >= 400) return 3
  return 2
}

function extractFirstJsonObject(text: string): string {
  const base = stripThinking(extractJson(text))
  const start = base.indexOf("{")
  const end = base.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("模型输出不包含 JSON 对象")
  }
  return base.slice(start, end + 1)
}

function tryExtractWindowsPath(text: string): string | null {
  const quoted = text.match(/["'`](?<p>[a-zA-Z]:[\\/][^"'`]+)["'`]/)
  if (quoted?.groups?.p) {
    return quoted.groups.p.trim()
  }
  const m = text.match(/[a-zA-Z]:[\\/][^\s\r\n，。；;,.]+/)
  if (!m) return null
  return m[0].trim()
}

function inferTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.content.trim())
  if (!firstUser) return "New chat"
  const oneLine = firstUser.content.trim().replace(/\s+/g, " ")
  return oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine
}

function shouldArchive(session: ChatSession): boolean {
  const meaningful = session.messages.some((m) => m.role === "user" && m.content.trim())
  return meaningful
}

function Layout() {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [activeView, setActiveView] = useState<ActiveView>("chat")
  const [history, setHistory] = useState<ChatSession[]>([])
  const [activeSession, setActiveSession] = useState<ChatSession>(() => {
    const now = Date.now()
    return {
      id: createId(),
      title: "New chat",
      messages: defaultGreeting(),
      createdAt: now,
      updatedAt: now,
    }
  })
  const [viewingSessionId, setViewingSessionId] = useState<string | null>(null)
  const [inputValue, setInputValue] = useState('')
  const requestIdRef = useRef(0)
  const [isGenerating, setIsGenerating] = useState(false)
  const [typingState, setTypingState] = useState<{ key: string; shown: number; total: number } | null>(null)
  const typingTimerRef = useRef<number | null>(null)
  const chatScrollAreaRef = useRef<HTMLDivElement | null>(null)
  const chatBottomRef = useRef<HTMLDivElement | null>(null)
  const [isChatNearBottom, setIsChatNearBottom] = useState(true)

  const [llmConfig, setLlmConfig] = useState<PublicLlmConfig | null>(null)
  const [userAvatarSrc, setUserAvatarSrc] = useState<string>("")
  const [aiAvatarSrc, setAiAvatarSrc] = useState<string>("")
  const [chiikawaStyle, setChiikawaStyle] = useState<boolean>(true)
  const [storeInfo, setStoreInfo] = useState<{ userData: string; dbPath: string } | null>(null)
  const userAvatarFileRef = useRef<HTMLInputElement | null>(null)
  const aiAvatarFileRef = useRef<HTMLInputElement | null>(null)
  const [llmBaseUrl, setLlmBaseUrl] = useState("")
  const [llmModel, setLlmModel] = useState("")
  const [llmTemperature, setLlmTemperature] = useState("0.7")
  const [llmMaxTokens, setLlmMaxTokens] = useState("1024")
  const [llmApiKey, setLlmApiKey] = useState("")
  const [llmClearApiKey, setLlmClearApiKey] = useState(false)
  const [llmStatus, setLlmStatus] = useState<string | null>(null)
  const [memoryContext, setMemoryContext] = useState<string>("")
  const [memoryPaths, setMemoryPaths] = useState<{ baseDir: string; longTerm: string; dailyDir: string } | null>(null)
  const [fsRoots, setFsRoots] = useState<Record<string, string>>({})
  const [lastFsPlanIds, setLastFsPlanIds] = useState<Record<string, string>>({})
  const fsPlansRef = useRef(
    new Map<
      string,
      {
        sessionId: string
        root: string
        operations: FsPlanOp[]
        createdAt: number
      }
    >()
  )
  const memoryWrittenRef = useRef(new Set<string>())
  const hasLoadedPersistentStateRef = useRef(false)

  const historySorted = useMemo(() => {
    return [...history].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [history])

  const viewedSession = useMemo(() => {
    if (!viewingSessionId) return activeSession
    const found = history.find((s) => s.id === viewingSessionId)
    return found ?? activeSession
  }, [activeSession, history, viewingSessionId])

  const viewedSessionId = useMemo(() => {
    return viewingSessionId ?? activeSession.id
  }, [activeSession.id, viewingSessionId])

  const viewedMessagesCount = viewedSession.messages.length
  const lastViewedMessageCreatedAt = viewedSession.messages[viewedMessagesCount - 1]?.createdAt ?? 0
  const typingKey = typingState?.key ?? ""
  const typingShown = typingState?.shown ?? 0

  useEffect(() => {
    if (activeView !== "chat") return
    const root = chatScrollAreaRef.current
    const viewport = root?.querySelector("[data-radix-scroll-area-viewport]") as HTMLDivElement | null
    if (!viewport) return

    const update = () => {
      const threshold = 80
      const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
      setIsChatNearBottom(distance < threshold)
    }

    update()
    viewport.addEventListener("scroll", update, { passive: true })
    return () => viewport.removeEventListener("scroll", update)
  }, [activeView, viewedSessionId])

  useEffect(() => {
    if (activeView !== "chat") return
    setIsChatNearBottom(true)
    chatBottomRef.current?.scrollIntoView({ block: "end" })
  }, [activeView, viewedSessionId])

  useEffect(() => {
    if (activeView !== "chat") return
    if (!isChatNearBottom) return
    chatBottomRef.current?.scrollIntoView({ block: "end" })
  }, [activeView, viewedSessionId, viewedMessagesCount, lastViewedMessageCreatedAt, typingKey, typingShown, isChatNearBottom])

  useEffect(() => {
    void (async () => {
      try {
        const [chatStateRaw, avatarRaw, uiRaw, rootsRaw] = await Promise.all([
          window.api.store.get(STORAGE_KEY),
          window.api.store.get(AVATAR_KEY),
          window.api.store.get(UI_PREFS_KEY),
          window.api.store.get(FS_ROOTS_KEY),
        ])

        const fallbackChat = (() => {
          try {
            const raw = localStorage.getItem(STORAGE_KEY)
            return raw ? (JSON.parse(raw) as any) : null
          } catch {
            return null
          }
        })()

        const fallbackAvatars = (() => {
          try {
            const raw = localStorage.getItem(AVATAR_KEY)
            return raw ? (JSON.parse(raw) as any) : null
          } catch {
            return null
          }
        })()

        const fallbackUi = (() => {
          try {
            const raw = localStorage.getItem(UI_PREFS_KEY)
            return raw ? (JSON.parse(raw) as any) : null
          } catch {
            return null
          }
        })()

        const fallbackRoots = (() => {
          try {
            const raw = localStorage.getItem(FS_ROOTS_KEY)
            return raw ? (JSON.parse(raw) as any) : null
          } catch {
            return null
          }
        })()

        const chatState = (chatStateRaw ?? fallbackChat) as
          | { history?: ChatSession[]; active?: ChatSession; viewingSessionId?: string | null }
          | null
        if (chatState?.history && Array.isArray(chatState.history)) setHistory(chatState.history)
        if (chatState?.active && chatState.active.id) setActiveSession(chatState.active)
        if (typeof chatState?.viewingSessionId === "string" || chatState?.viewingSessionId === null) {
          setViewingSessionId(chatState.viewingSessionId ?? null)
        }

        const avatars = (avatarRaw ?? fallbackAvatars) as { user?: string; ai?: string } | null
        if (typeof avatars?.user === "string") setUserAvatarSrc(avatars.user)
        if (typeof avatars?.ai === "string") setAiAvatarSrc(avatars.ai)

        const ui = (uiRaw ?? fallbackUi) as { chiikawaStyle?: boolean } | null
        if (typeof ui?.chiikawaStyle === "boolean") setChiikawaStyle(ui.chiikawaStyle)

        const roots = (rootsRaw ?? fallbackRoots) as Record<string, string> | null
        if (roots && typeof roots === "object") setFsRoots(roots)

        if (chatStateRaw == null && fallbackChat != null) await window.api.store.set(STORAGE_KEY, fallbackChat)
        if (avatarRaw == null && fallbackAvatars != null) await window.api.store.set(AVATAR_KEY, fallbackAvatars)
        if (uiRaw == null && fallbackUi != null) await window.api.store.set(UI_PREFS_KEY, fallbackUi)
        if (rootsRaw == null && fallbackRoots != null) await window.api.store.set(FS_ROOTS_KEY, fallbackRoots)
      } catch {
      } finally {
        hasLoadedPersistentStateRef.current = true
      }
    })()
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const cfg = await window.api.llm.getConfig()
        setLlmConfig(cfg)
        setLlmBaseUrl(cfg.baseUrl ?? "")
        setLlmModel(cfg.model ?? "")
        setLlmTemperature(String(cfg.temperature ?? 0.7))
        setLlmMaxTokens(String(cfg.maxTokens ?? 1024))
      } catch (e: any) {
        setLlmStatus(e?.message ? String(e.message) : "无法读取 LLM 配置")
      }
    })()
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const info = await window.api.store.getInfo()
        setStoreInfo(info)
      } catch {
      }
    })()
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const [paths, ctx] = await Promise.all([window.api.memory.getPaths(), window.api.memory.getContext()])
        setMemoryPaths(paths)
        setMemoryContext(ctx.combined)
      } catch {
      }
    })()
  }, [])

  useEffect(() => {
    if (!hasLoadedPersistentStateRef.current) return
    void window.api.store.set(STORAGE_KEY, {
      history,
      active: activeSession,
      viewingSessionId,
    })
  }, [history, activeSession, viewingSessionId])

  useEffect(() => {
    if (!hasLoadedPersistentStateRef.current) return
    void window.api.store.set(FS_ROOTS_KEY, fsRoots)
  }, [fsRoots])

  useEffect(() => {
    if (!hasLoadedPersistentStateRef.current) return
    void window.api.store.set(AVATAR_KEY, { user: userAvatarSrc, ai: aiAvatarSrc })
  }, [userAvatarSrc, aiAvatarSrc])

  useEffect(() => {
    if (!hasLoadedPersistentStateRef.current) return
    void window.api.store.set(UI_PREFS_KEY, { chiikawaStyle })
  }, [chiikawaStyle])

  useEffect(() => {
    try {
      document.documentElement.classList.toggle("chiikawa", chiikawaStyle)
    } catch {
    }
  }, [chiikawaStyle])

  const abortRunning = () => {
    requestIdRef.current += 1
    setIsGenerating(false)
    setTypingState(null)
  }

  useEffect(() => {
    setTypingState(null)
  }, [viewedSessionId, activeView])

  useEffect(() => {
    if (!typingState) return
    if (typingTimerRef.current) {
      window.clearInterval(typingTimerRef.current)
      typingTimerRef.current = null
    }
    const intervalMs = 30
    const timerId = window.setInterval(() => {
      setTypingState((prev) => {
        if (!prev) return null
        const step = calcTypewriterStep(prev.total)
        const next = Math.min(prev.total, prev.shown + step)
        if (next >= prev.total) return null
        return { ...prev, shown: next }
      })
    }, intervalMs)
    typingTimerRef.current = timerId
    return () => {
      if (typingTimerRef.current) {
        window.clearInterval(typingTimerRef.current)
        typingTimerRef.current = null
      }
    }
  }, [typingState?.key, typingState?.total])

  const normalizeMemoryLine = (text: string) => {
    return text.replace(/\s+/g, " ").replace(/\r?\n/g, " ").trim()
  }

  const shouldConsiderAutoMemory = (userText: string, assistantText: string) => {
    return /记住|偏好|喜欢|讨厌|偏爱|以后|总是|永远|不要|别再|请用|请不要|我是|我叫|叫我/.test(
      userText + "\n" + assistantText
    )
  }

  const autoWriteMemoryFromTurn = async (userText: string, assistantText: string) => {
    if (!shouldConsiderAutoMemory(userText, assistantText)) return
    const prompt = [
      "你是一个“记忆提取器”，负责从对话中判断哪些内容应写入长期/短期记忆文件。",
      "",
      "长期记忆：稳定事实、身份/称呼、长期偏好、关键决策（少而精）。",
      "短期记忆：当天临时信息、会议要点、工作笔记（可多些）。",
      "",
      "禁止写入：密码、token、API key、私钥、银行卡号等敏感信息；以及可随时工具查询的一次性事实。",
      "避免重复：如果内容已在【已加载记忆】里出现，请不要再次输出。",
      "",
      "输出要求：只输出 JSON 对象，不要输出任何解释或 <think>。",
      "JSON 结构：{ \"longTerm\": string[], \"daily\": string[] }",
    ].join("\n")

    const ctxSnapshot = memoryContext.trim()
    const input = [
      "【已加载记忆】",
      ctxSnapshot.length > 4000 ? `${ctxSnapshot.slice(0, 4000)}\n…（已截断）` : ctxSnapshot || "（空）",
      "",
      "【本轮对话】",
      `User: ${userText}`,
      `Assistant: ${assistantText}`,
    ].join("\n")

    try {
      const res = await window.api.llm.chat({
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: input },
        ],
        temperature: 0.2,
        maxTokens: 400,
      })

      const parsed = JSON.parse(extractFirstJsonObject(res.text)) as { longTerm?: unknown; daily?: unknown }
      const longTerm = Array.isArray(parsed.longTerm) ? parsed.longTerm : []
      const daily = Array.isArray(parsed.daily) ? parsed.daily : []

      const writes: Promise<any>[] = []
      for (const t of longTerm) {
        if (typeof t !== "string") continue
        const line = normalizeMemoryLine(t)
        if (!line) continue
        const key = `L:${line}`
        if (memoryWrittenRef.current.has(key)) continue
        memoryWrittenRef.current.add(key)
        writes.push(window.api.memory.appendLongTerm({ text: line }))
      }
      for (const t of daily) {
        if (typeof t !== "string") continue
        const line = normalizeMemoryLine(t)
        if (!line) continue
        const key = `D:${line}`
        if (memoryWrittenRef.current.has(key)) continue
        memoryWrittenRef.current.add(key)
        writes.push(window.api.memory.appendDaily({ text: line }))
      }

      if (writes.length) {
        await Promise.all(writes)
        const ctx = await window.api.memory.getContext()
        setMemoryContext(ctx.combined)
      }
    } catch {
    }
  }

  const archiveActiveSessionIfNeeded = () => {
    if (!shouldArchive(activeSession)) return
    const archived: ChatSession = {
      ...activeSession,
      title: inferTitle(activeSession.messages),
      updatedAt: Date.now(),
    }
    setHistory((prev) => [archived, ...prev.filter((s) => s.id !== archived.id)])
  }

  const updateSessionMessages = (
    sessionId: string | null,
    updater: (messages: ChatMessage[]) => ChatMessage[]
  ) => {
    if (sessionId) {
      let updated = false
      setHistory((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s
          updated = true
          const nextMessages = updater(s.messages)
          return {
            ...s,
            messages: nextMessages,
            title: s.title === "New chat" ? inferTitle(nextMessages) : s.title,
            updatedAt: Date.now(),
          }
        })
      )
      if (updated) return
      setViewingSessionId(null)
    }

    setActiveSession((prev) => {
      const nextMessages = updater(prev.messages)
      return {
        ...prev,
        messages: nextMessages,
        title: prev.title === "New chat" ? inferTitle(nextMessages) : prev.title,
        updatedAt: Date.now(),
      }
    })
  }

  const startNewChat = () => {
    abortRunning()
    archiveActiveSessionIfNeeded()
    const now = Date.now()
    setActiveSession({
      id: createId(),
      title: "New chat",
      messages: defaultGreeting(),
      createdAt: now,
      updatedAt: now,
    })
    setViewingSessionId(null)
    setActiveView("chat")
    setInputValue("")
  }

  const openSessionFromHistory = (sessionId: string) => {
    abortRunning()
    setViewingSessionId(sessionId)
    setActiveView("chat")
    setInputValue("")
  }

  const openCurrentChat = () => {
    abortRunning()
    setViewingSessionId(null)
    setActiveView("chat")
    setInputValue("")
  }

  const deleteSession = (sessionId: string) => {
    setHistory((prev) => prev.filter((s) => s.id !== sessionId))
    if (viewingSessionId === sessionId) {
      setViewingSessionId(null)
      setActiveView("chat")
    }
  }

  const saveLlmConfig = async () => {
    try {
      setLlmStatus(null)
      const baseUrl = llmBaseUrl.trim()
      const model = llmModel.trim()
      if (!baseUrl) {
        setLlmStatus("Base URL 不能为空")
        return
      }
      if (!model) {
        setLlmStatus("Model 不能为空")
        return
      }
      const temperature = Number.isFinite(Number(llmTemperature)) ? Number(llmTemperature) : undefined
      const maxTokens = Number.isFinite(Number(llmMaxTokens)) ? Number(llmMaxTokens) : undefined
      const cfg = await window.api.llm.setConfig({
        baseUrl,
        model,
        temperature,
        maxTokens,
        apiKey: llmApiKey,
        clearApiKey: llmClearApiKey,
      })
      setLlmConfig(cfg)
      setLlmBaseUrl(cfg.baseUrl ?? baseUrl)
      setLlmModel(cfg.model ?? model)
      setLlmTemperature(String(cfg.temperature ?? temperature ?? 0.7))
      setLlmMaxTokens(String(cfg.maxTokens ?? maxTokens ?? 1024))
      setLlmApiKey("")
      setLlmClearApiKey(false)
      setLlmStatus(`已保存：${cfg.model} @ ${cfg.baseUrl}`)
    } catch (e: any) {
      setLlmStatus(e?.message ? String(e.message) : "保存失败")
    }
  }

  const testLlmConfig = async () => {
    try {
      setLlmStatus(null)
      await saveLlmConfig()
      const res = await window.api.llm.chat({
        messages: [{ role: "user", content: "ping" }],
      })
      setLlmStatus(`测试成功：${stripThinkingForDisplay(res.text)}`)
    } catch (e: any) {
      setLlmStatus(e?.message ? String(e.message) : "测试失败")
    }
  }

  const getFsRoot = () => {
    return fsRoots[viewedSessionId] ?? null
  }

  const setFsRoot = (root: string) => {
    setFsRoots((prev) => ({ ...prev, [viewedSessionId]: root }))
  }

  const summarizeEntries = (entries: { path: string; type: "file" | "dir"; size: number }[]) => {
    const fileCount = entries.filter((e) => e.type === "file").length
    const dirCount = entries.filter((e) => e.type === "dir").length
    const extCount = new Map<string, number>()
    for (const e of entries) {
      if (e.type !== "file") continue
      const m = e.path.toLowerCase().match(/\.([a-z0-9]+)$/)
      const ext = m?.[1] ? `.${m[1]}` : "(noext)"
      extCount.set(ext, (extCount.get(ext) ?? 0) + 1)
    }
    const topExt = [...extCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([k, v]) => `${k}:${v}`)
      .join("  ")
    return { fileCount, dirCount, topExt }
  }

  const buildFsPrompt = (args: { instruction: string; root: string; filesForPrompt: string }) => {
    return [
      "你是一个桌面应用的文件整理助手。目标：在不越界的前提下整理/批量修改选中文件夹内的文件。",
      "",
      "输出要求：只能输出 JSON（不要输出任何其它文本；不要输出 <think> 或解释过程）。",
      "",
      "路径要求：",
      "- 所有 path/from/to 都必须是相对根目录的路径（用 / 分隔），不能包含盘符、不能以 / 开头、不能包含 ..",
      "",
      "允许的操作（只能使用这些）：",
      '  - { "op": "mkdir", "path": "..." }',
      '  - { "op": "move", "from": "...", "to": "..." }',
      '  - { "op": "delete", "path": "..." }',
      '  - { "op": "replaceText", "path": "...", "mode": "literal|regex", "search": "...", "replace": "...", "flags": "gim" }',
      "",
      "你必须返回：",
      '{ "summary": "...", "operations": [ ... ] }',
      "",
      `根目录（绝对路径，仅供参考）：${args.root}`,
      "",
      "用户需求：",
      args.instruction,
      "",
      "根目录文件清单（最多 300 个文件，仅用于规划）：",
      args.filesForPrompt,
      "",
    ].join("\n")
  }

  const clearFsRoot = () => {
    setFsRoots((prev) => {
      const next = { ...prev }
      delete next[viewedSessionId]
      return next
    })
  }

  const replyToChat = (content: string) => {
    appendMessageToSession(viewingSessionId, { role: "ai", content, createdAt: Date.now() })
  }

  const scanRootToChat = async (root: string) => {
    try {
      const list = await window.api.fs.list({ root, maxEntries: 5000 })
      const { fileCount, dirCount, topExt } = summarizeEntries(list)
      replyToChat(
        [
          `扫描完成：${root}`,
          `目录：${dirCount}  文件：${fileCount}`,
          topExt ? `Top 扩展名：${topExt}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      )
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : "扫描失败"
      if (msg.includes("ENOENT")) {
        replyToChat(`目录不存在：${root}`)
      } else if (msg.includes("EACCES") || msg.includes("EPERM")) {
        replyToChat(`无权限访问：${root}`)
      } else {
        replyToChat(msg)
      }
    }
  }

  const listRootToChat = async (root: string) => {
    try {
      const list = await window.api.fs.list({ root, maxEntries: 5000 })
      const { fileCount, dirCount, topExt } = summarizeEntries(list)
      const dirs = list
        .filter((e) => e.type === "dir")
        .map((e) => e.path)
        .sort((a, b) => a.localeCompare(b))
      const files = list
        .filter((e) => e.type === "file")
        .map((e) => e.path)
        .sort((a, b) => a.localeCompare(b))

      const dirLines = dirs.slice(0, 30).map((p) => `- ${p}/`)
      const fileLines = files.slice(0, 30).map((p) => `- ${p}`)

      replyToChat(
        [
          `目录：${root}`,
          `目录数：${dirCount}  文件数：${fileCount}`,
          topExt ? `Top 扩展名：${topExt}` : "",
          "",
          "目录（前 30）：",
          dirLines.length ? dirLines.join("\n") : "（无）",
          dirs.length > 30 ? `（还有 ${dirs.length - 30} 个目录未显示）` : "",
          "",
          "文件（前 30）：",
          fileLines.length ? fileLines.join("\n") : "（无）",
          files.length > 30 ? `（还有 ${files.length - 30} 个文件未显示）` : "",
          "",
          "如果要整理/批量修改：回复 /plan <你的需求>",
        ]
          .filter(Boolean)
          .join("\n")
      )
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : "列目录失败"
      if (msg.includes("ENOENT")) {
        replyToChat(`目录不存在：${root}`)
      } else if (msg.includes("EACCES") || msg.includes("EPERM")) {
        replyToChat(`无权限访问：${root}`)
      } else {
        replyToChat(msg)
      }
    }
  }

  const pickFolderForChat = async () => {
    const selected = await window.api.fs.selectDirectory()
    if (!selected) return
    setFsRoot(selected)
    replyToChat(
      [
        `已选择根目录：${selected}`,
        "你可以直接描述文件需求（整理/替换/移动/删除），我会先生成计划并让你点击按钮确认执行。",
      ].join("\n")
    )
    await scanRootToChat(selected)
  }

  const appendMessageToSession = (sessionId: string | null, message: ChatMessage) => {
    if (sessionId) {
      let updated = false
      setHistory((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s
          updated = true
          const nextMessages = [...s.messages, message]
          return {
            ...s,
            messages: nextMessages,
            title: s.title === "New chat" ? inferTitle(nextMessages) : s.title,
            updatedAt: Date.now(),
          }
        })
      )
      if (updated) return
      setViewingSessionId(null)
    }

    setActiveSession((prev) => {
      const nextMessages = [...prev.messages, message]
      return {
        ...prev,
        messages: nextMessages,
        title: prev.title === "New chat" ? inferTitle(nextMessages) : prev.title,
        updatedAt: Date.now(),
      }
    })
  }

  const clearPlanActions = (sessionId: string | null, planId: string) => {
    updateSessionMessages(sessionId, (messages) =>
      messages.map((m) => {
        if (!m.actions || m.actions.length === 0) return m
        const has = m.actions.some((a) => ("planId" in a ? a.planId === planId : false))
        if (!has) return m
        return { ...m, actions: [] }
      })
    )
  }

  const applyPlanToChat = async (sessionId: string | null, planId: string) => {
    const found = fsPlansRef.current.get(planId)
    if (!found) {
      appendMessageToSession(sessionId, {
        role: "ai",
        content: `找不到计划：${planId}（请先 /plan 生成）`,
        createdAt: Date.now(),
      })
      return
    }
    clearPlanActions(sessionId, planId)
    setIsGenerating(true)
    try {
      const res = await window.api.fs.applyPlan({
        root: found.root,
        operations: found.operations,
        commit: true,
      })
      const lines = res.preview.slice(0, 40).map((p, i) => {
        const detail = p.detail ? ` (${p.detail})` : ""
        return `${i + 1}. ${p.title}${detail}`
      })
      const errLines = res.errors.slice(0, 20).map((e) => `- ${e}`)
      appendMessageToSession(sessionId, {
        role: "ai",
        content: [
          res.ok ? "执行完成" : "执行完成（存在错误）",
          `根目录：${found.root}`,
          "",
          "结果：",
          lines.length ? lines.join("\n") : "（无变更）",
          res.preview.length > 40 ? "\n（仅展示前 40 条结果）" : "",
          errLines.length ? `\n错误：\n${errLines.join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        createdAt: Date.now(),
      })
    } catch (e: any) {
      appendMessageToSession(sessionId, {
        role: "ai",
        content: e?.message ? String(e.message) : "执行失败",
        createdAt: Date.now(),
      })
    } finally {
      setIsGenerating(false)
    }
  }

  const cancelPlanToChat = (sessionId: string | null, planId: string) => {
    clearPlanActions(sessionId, planId)
    appendMessageToSession(sessionId, {
      role: "ai",
      content: `已取消计划：${planId}`,
      createdAt: Date.now(),
    })
  }

  const handleSendMessage = () => {
    if (!inputValue.trim()) return
    setActiveView("chat")
    abortRunning()
    const requestId = requestIdRef.current
    setIsGenerating(true)

    const question = inputValue.trim()
    const targetSessionId = viewingSessionId
    const sessionIdForKey = viewingSessionId ?? activeSession.id
    const userMsg: ChatMessage = { role: "user", content: question, createdAt: Date.now() }
    setInputValue("")

    appendMessageToSession(targetSessionId, userMsg)

    void (async () => {
      try {
        const reply = (input: string | { content: string; actions?: ChatAction[] }) => {
          if (requestIdRef.current !== requestId) return
          const msg = typeof input === "string" ? { content: input } : input
          appendMessageToSession(targetSessionId, {
            role: "ai",
            content: msg.content,
            actions: msg.actions,
            createdAt: Date.now(),
          })
        }

        const currentRoot = getFsRoot()
        let memoryCtxForTurn = memoryContext

        const handleRoot = async (root: string) => {
          setFsRoot(root)
          try {
            const list = await window.api.fs.list({ root, maxEntries: 2000 })
            const { fileCount, dirCount, topExt } = summarizeEntries(list)
            reply(
              [
                `已设置根目录：${root}`,
                `目录：${dirCount}  文件：${fileCount}`,
                topExt ? `Top 扩展名：${topExt}` : "",
                "下一步：回复 /ls 查看文件清单，或 /plan <你的需求> 生成可预览计划",
              ]
                .filter(Boolean)
                .join("\n")
            )
          } catch (e: any) {
            const msg = e?.message ? String(e.message) : "设置根目录失败"
            if (msg.includes("ENOENT")) {
              reply(`目录不存在：${root}`)
            } else if (msg.includes("EACCES") || msg.includes("EPERM")) {
              reply(`无权限访问：${root}`)
            } else {
              reply(msg)
            }
          }
        }

        const handleScan = async (root: string) => {
          try {
            const list = await window.api.fs.list({ root, maxEntries: 5000 })
            const { fileCount, dirCount, topExt } = summarizeEntries(list)
            reply(
              [
                `扫描完成：${root}`,
                `目录：${dirCount}  文件：${fileCount}`,
                topExt ? `Top 扩展名：${topExt}` : "",
              ]
                .filter(Boolean)
                .join("\n")
            )
          } catch (e: any) {
            const msg = e?.message ? String(e.message) : "扫描失败"
            if (msg.includes("ENOENT")) {
              reply(`目录不存在：${root}`)
            } else if (msg.includes("EACCES") || msg.includes("EPERM")) {
              reply(`无权限访问：${root}`)
            } else {
              reply(msg)
            }
          }
        }

        const handleList = async (root: string) => {
          try {
            const list = await window.api.fs.list({ root, maxEntries: 5000 })
            const { fileCount, dirCount, topExt } = summarizeEntries(list)
            const dirs = list
              .filter((e) => e.type === "dir")
              .map((e) => e.path)
              .sort((a, b) => a.localeCompare(b))
            const files = list
              .filter((e) => e.type === "file")
              .map((e) => e.path)
              .sort((a, b) => a.localeCompare(b))

            const dirLines = dirs.slice(0, 30).map((p) => `- ${p}/`)
            const fileLines = files.slice(0, 30).map((p) => `- ${p}`)

            reply(
              [
                `目录：${root}`,
                `目录数：${dirCount}  文件数：${fileCount}`,
                topExt ? `Top 扩展名：${topExt}` : "",
                "",
                "目录（前 30）：",
                dirLines.length ? dirLines.join("\n") : "（无）",
                dirs.length > 30 ? `（还有 ${dirs.length - 30} 个目录未显示）` : "",
                "",
                "文件（前 30）：",
                fileLines.length ? fileLines.join("\n") : "（无）",
                files.length > 30 ? `（还有 ${files.length - 30} 个文件未显示）` : "",
                "",
                "如果要整理/批量修改：回复 /plan <你的需求>",
              ]
                .filter(Boolean)
                .join("\n")
            )
          } catch (e: any) {
            const msg = e?.message ? String(e.message) : "列目录失败"
            if (msg.includes("ENOENT")) {
              reply(`目录不存在：${root}`)
            } else if (msg.includes("EACCES") || msg.includes("EPERM")) {
              reply(`无权限访问：${root}`)
            } else {
              reply(msg)
            }
          }
        }

        const generatePlan = async (instruction: string, root: string) => {
          const list = await window.api.fs.list({ root, maxEntries: 5000 })
          const filesForPrompt = list
            .filter((e) => e.type === "file")
            .slice(0, 300)
            .map((f) => `${f.path}`)
            .join("\n")

          const prompt = buildFsPrompt({ instruction, root, filesForPrompt })
          const res = await window.api.llm.chat({ messages: [{ role: "user", content: prompt }] })

          let parsed: { summary?: string; operations?: FsPlanOp[] }
          try {
            parsed = JSON.parse(extractFirstJsonObject(res.text)) as { summary?: string; operations?: FsPlanOp[] }
          } catch (e: any) {
            const msg = e?.message ? String(e.message) : "无法解析 JSON"
            throw new Error(
              [
                "模型输出不是合法 JSON，无法生成计划。",
                `解析错误：${msg}`,
                "建议：切换到更“指令遵循/JSON 输出稳定”的模型，或关闭模型的 think/reasoning 输出。",
              ].join("\n")
            )
          }
          const operations = Array.isArray(parsed.operations) ? (parsed.operations as FsPlanOp[]) : null
          if (!operations) {
            throw new Error("LLM 未返回 operations 数组")
          }

          const check = await window.api.fs.applyPlan({ root, operations, commit: false })
          const planId = createId()
          fsPlansRef.current.set(planId, {
            sessionId: viewedSessionId,
            root,
            operations,
            createdAt: Date.now(),
          })
          setLastFsPlanIds((prev) => ({ ...prev, [viewedSessionId]: planId }))

          const previewLines = check.preview.slice(0, 40).map((p, i) => {
            const detail = p.detail ? ` (${p.detail})` : ""
            return `${i + 1}. ${p.title}${detail}`
          })
          const errLines = check.errors.slice(0, 20).map((e) => `- ${e}`)

          const content = [
            `已生成计划（ID: ${planId}）`,
            parsed.summary ? `摘要：${parsed.summary}` : "",
            "",
            "预览：",
            previewLines.length ? previewLines.join("\n") : "（无变更）",
            check.preview.length > 40 ? "\n（仅展示前 40 条预览）" : "",
            errLines.length ? `\n错误：\n${errLines.join("\n")}` : "",
            errLines.length ? "\n存在错误，已禁止执行。请调整需求后重新 /plan。" : "",
            errLines.length ? "" : "\n请点击下方按钮确认执行",
          ]
            .filter(Boolean)
            .join("\n")

          reply({
            content,
            actions: errLines.length
              ? []
              : [
                  { type: "applyPlan", planId, label: "确认执行", variant: "default" },
                  { type: "cancelPlan", planId, label: "取消", variant: "secondary" },
                ],
          })
        }

        const maybePath = tryExtractWindowsPath(question)

        if (question.startsWith("/")) {
          const [cmdRaw, ...rest] = question.slice(1).trim().split(" ")
          const cmd = (cmdRaw || "").toLowerCase()
          const argStr = rest.join(" ").trim()

          if (cmd === "remember") {
            const text = argStr.trim()
            if (!text) {
              reply("用法：/remember <需要长期记住的内容>")
              return
            }
            const res = await window.api.memory.appendLongTerm({ text })
            const ctx = await window.api.memory.getContext()
            setMemoryContext(ctx.combined)
            reply(`已写入长期记忆：${res.path}`)
            return
          }

          if (cmd === "note") {
            const text = argStr.trim()
            if (!text) {
              reply("用法：/note <写入今天短期记忆的内容>")
              return
            }
            const res = await window.api.memory.appendDaily({ text })
            const ctx = await window.api.memory.getContext()
            setMemoryContext(ctx.combined)
            reply(`已写入短期记忆：${res.path}`)
            return
          }

          if (cmd === "mem") {
            const [subRaw, ...subRest] = argStr.split(" ")
            const sub = (subRaw || "").toLowerCase()
            const subArg = subRest.join(" ").trim()

            if (!sub || sub === "help") {
              reply(
                [
                  "记忆系统命令：",
                  "- /mem show              查看已加载记忆（长期 + 近两日）",
                  "- /mem paths             查看记忆文件路径",
                  "- /mem search <关键词>    在记忆中搜索",
                  "- /remember <内容>        写入长期记忆（MEMORY.md）",
                  "- /note <内容>            写入今日短期记忆（daily log）",
                ].join("\n")
              )
              return
            }

            if (sub === "paths") {
              if (!memoryPaths) {
                const p = await window.api.memory.getPaths()
                setMemoryPaths(p)
                reply([`baseDir: ${p.baseDir}`, `longTerm: ${p.longTerm}`, `dailyDir: ${p.dailyDir}`].join("\n"))
                return
              }
              reply(
                [
                  `baseDir: ${memoryPaths.baseDir}`,
                  `longTerm: ${memoryPaths.longTerm}`,
                  `dailyDir: ${memoryPaths.dailyDir}`,
                ].join("\n")
              )
              return
            }

            if (sub === "show") {
              const ctx = await window.api.memory.getContext()
              setMemoryContext(ctx.combined)
              const text = ctx.combined.length > 4000 ? `${ctx.combined.slice(0, 4000)}\n…（已截断）` : ctx.combined
              reply(text)
              return
            }

            if (sub === "search") {
              if (!subArg) {
                reply("用法：/mem search <关键词>")
                return
              }
              const res = await window.api.memory.search({ query: subArg, limit: 20 })
              if (!res.hits.length) {
                reply("未找到匹配内容")
                return
              }
              reply(
                res.hits
                  .slice(0, 20)
                  .map((h) => `${h.file}:${h.line}  ${h.text}`)
                  .join("\n")
              )
              return
            }
          }

          if (cmd === "help") {
            reply(
              [
                "文件整理（对话模式）命令：",
                "- 也可点击输入框右侧的文件夹按钮选择根目录",
                "- /root <绝对路径>  设置根目录",
                "- /scan             扫描根目录概览",
                "- /ls               列出根目录下的文件/目录（前 30）",
                "- /plan <需求>       生成计划并预览",
                "- /apply <planId|latest>  执行计划（也可点击按钮确认）",
                "",
                "记忆系统命令：/mem",
              ].join("\n")
            )
            return
          }

          if (cmd === "root") {
            const root = argStr || maybePath
            if (!root) {
              reply("请提供根目录绝对路径，例如：/root D:\\projects\\demo")
              return
            }
            await handleRoot(root)
            return
          }

          if (cmd === "scan") {
            const root = argStr || maybePath || currentRoot
            if (!root) {
              reply("请先设置根目录：/root D:\\...，或 /scan D:\\...")
              return
            }
            await handleScan(root)
            return
          }

          if (cmd === "ls" || cmd === "list") {
            const root = argStr || maybePath || currentRoot
            if (!root) {
              reply("请先设置根目录：/root D:\\...，或 /ls D:\\...")
              return
            }
            await handleList(root)
            return
          }

          if (cmd === "plan") {
            const root = maybePath || currentRoot
            if (!root) {
              reply("请先设置根目录：/root D:\\...，再 /plan <需求>")
              return
            }
            if (maybePath && maybePath !== currentRoot) {
              setFsRoot(maybePath)
            }
            const instr = argStr || question
            if (!instr) {
              reply("请提供需求，例如：/plan 把所有 .png 移到 assets/images")
              return
            }
            await generatePlan(instr, root)
            return
          }

          if (cmd === "apply") {
            const arg = argStr || ""
            let planId = arg.split(/\s+/)[0] ?? ""
            if (planId === "latest" || !planId) {
              planId = lastFsPlanIds[viewedSessionId] ?? ""
              if (!planId) {
                let best: { id: string; createdAt: number } | null = null
                for (const [id, p] of fsPlansRef.current.entries()) {
                  if (p.sessionId !== viewedSessionId) continue
                  if (!best || p.createdAt > best.createdAt) best = { id, createdAt: p.createdAt }
                }
                planId = best?.id ?? ""
              }
            }
            if (!planId) {
              reply("请提供计划 ID，例如：/apply <planId> 或 /apply latest")
              return
            }
            await applyPlanToChat(targetSessionId, planId)
            return
          }
        }

        const fsIntent =
          /整理|归档|批量|重命名|移动|替换|删除|按扩展名|文件夹|目录|前缀|去掉|去除|移除/.test(question) ||
          question.startsWith("fs:")

        const listIntent = /里面有什么文件|有哪些文件|列出|文件清单|目录下有什么|list\b|ls\b/i.test(question)

        if (fsIntent) {
          const root = maybePath || currentRoot
          if (!root) {
            reply("请先告诉我根目录绝对路径，例如：/root D:\\...，然后描述你的整理规则。")
            return
          }
          if (maybePath && maybePath !== currentRoot) {
            setFsRoot(maybePath)
          }
          if (listIntent) {
            await handleList(root)
            return
          }

          const removePrefixA = question.match(/前缀\s*["'`]?(.{1,20}?)["'`]?\s*(?=去掉|去除|移除)/)
          const removePrefixB = question.match(/(?:去掉|去除|移除)\s*前缀\s*["'`]?(.{1,20}?)["'`]?(?:\s|$)/)
          const prefix = (removePrefixA?.[1] ?? removePrefixB?.[1] ?? "").trim()

          if (prefix) {
            const list = await window.api.fs.list({ root, maxEntries: 5000 })
            const existing = new Set(list.map((e) => e.path))
            const ops: FsPlanOp[] = []
            const conflicts: string[] = []
            const targets = new Set<string>()

            for (const e of list) {
              if (e.type !== "file") continue
              const parts = e.path.split("/")
              const base = parts[parts.length - 1] ?? ""
              if (!base.startsWith(prefix)) continue
              const nextBase = base.slice(prefix.length)
              if (!nextBase) continue
              parts[parts.length - 1] = nextBase
              const to = parts.join("/")

              if (to === e.path) continue
              if (existing.has(to)) {
                conflicts.push(`目标已存在：${e.path} → ${to}`)
                continue
              }
              if (targets.has(to)) {
                conflicts.push(`目标冲突：${e.path} → ${to}`)
                continue
              }
              targets.add(to)
              ops.push({ op: "move", from: e.path, to })
            }

            if (conflicts.length) {
              reply(
                [
                  `检测到冲突，已中止生成计划（前缀：${prefix}）`,
                  ...conflicts.slice(0, 20).map((c) => `- ${c}`),
                  conflicts.length > 20 ? `（还有 ${conflicts.length - 20} 条未显示）` : "",
                ]
                  .filter(Boolean)
                  .join("\n")
              )
              return
            }

            if (ops.length === 0) {
              reply(`未找到需要处理的文件（前缀：${prefix}）`)
              return
            }

            const check = await window.api.fs.applyPlan({ root, operations: ops, commit: false })
            const planId = createId()
            fsPlansRef.current.set(planId, { sessionId: viewedSessionId, root, operations: ops, createdAt: Date.now() })
            setLastFsPlanIds((prev) => ({ ...prev, [viewedSessionId]: planId }))

            const previewLines = check.preview.slice(0, 40).map((p, i) => `${i + 1}. ${p.title}`)
            reply({
              content: [
                `已生成计划（ID: ${planId}）`,
                `摘要：去掉文件名前缀 "${prefix}"（操作数：${ops.length}）`,
                "",
                "预览：",
                previewLines.join("\n"),
                check.preview.length > 40 ? "（仅展示前 40 条预览）" : "",
                "",
                "请点击下方按钮确认执行",
              ]
                .filter(Boolean)
                .join("\n"),
              actions: [
                { type: "applyPlan", planId, label: "确认执行", variant: "default" },
                { type: "cancelPlan", planId, label: "取消", variant: "secondary" },
              ],
            })
            return
          }

          await generatePlan(question, root)
          return
        }

        if (/记住这个|记住一下|记下来/.test(question)) {
          const text = question
            .replace(/^(请|帮我)?\s*(记住这个|记住一下|记下来)[:：\s]*/g, "")
            .trim()
          const toSave = text || question.trim()
          const res = await window.api.memory.appendLongTerm({ text: toSave })
          const ctx = await window.api.memory.getContext()
          setMemoryContext(ctx.combined)
          reply(`已写入长期记忆：${res.path}`)
          return
        }

        if (/记住我是谁|你记得我是谁|记住我是谁吗/.test(question)) {
          reply(
            [
              "可以，我会自动把你的身份信息写入长期记忆。",
              "你直接用自然语言告诉我即可，例如：",
              "- 我叫张三，叫我三哥",
              "- 我是李四（产品经理），叫我李四",
            ].join("\n")
          )
          return
        }

        const nameA =
          question.match(/(?:我叫|我的名字是|叫我)\s*([^\s，。,.]{1,20})/)?.[1]?.trim() ?? ""
        const nameB = question.match(/^我是\s*([^\s，。,.]{1,20})/)?.[1]?.trim() ?? ""
        const preferredName = nameA || nameB
        const identityHint = question.match(/我是\s*([^\n]{1,60})/)?.[1]?.trim() ?? ""

        if (preferredName && /(?:我叫|我的名字是|叫我|我是)/.test(question)) {
          const payload = [
            "用户身份：",
            `- 称呼：${preferredName}`,
            identityHint ? `- 自述：${identityHint}` : "",
          ]
            .filter(Boolean)
            .join("\n")
          await window.api.memory.appendLongTerm({ text: payload })
          const ctx = await window.api.memory.getContext()
          memoryCtxForTurn = ctx.combined
          setMemoryContext(ctx.combined)
        }

        const prior = viewedSession.messages
          .filter((m) => m.content.trim())
          .map((m) => ({
            role: m.role === "ai" ? ("assistant" as const) : ("user" as const),
            content: m.content,
          }))

        const res = await window.api.llm.chat({
          messages: [
            ...(memoryCtxForTurn.trim() ? [{ role: "system" as const, content: memoryCtxForTurn.trim() }] : []),
            ...prior,
            { role: "user", content: question },
          ],
        })

        if (requestIdRef.current !== requestId) return
        const finalText = stripThinkingForDisplay(res.text)
        const createdAt = Date.now()
        appendMessageToSession(targetSessionId, {
          role: "ai",
          content: finalText,
          createdAt,
        })
        const sessionKey = `${sessionIdForKey}:${createdAt}`
        setTypingState({ key: sessionKey, shown: 0, total: finalText.length })
        void autoWriteMemoryFromTurn(question, res.text)
      } catch (e: any) {
        if (requestIdRef.current !== requestId) return
        appendMessageToSession(targetSessionId, {
          role: "ai",
          content: e?.message ? String(e.message) : "LLM 调用失败",
          createdAt: Date.now(),
        })
      } finally {
        if (requestIdRef.current === requestId) {
          setIsGenerating(false)
        }
      }
    })()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  return (
    <TooltipProvider delayDuration={0}>
      <div className="h-screen w-full flex overflow-hidden">
        <aside
          className={cn(
            "h-full shrink-0 border-r bg-background flex flex-col",
            isCollapsed ? "w-14" : "w-64"
          )}
        >
          <div
            className={cn(
              "flex h-[52px] items-center",
              isCollapsed ? "justify-center px-2" : "justify-between px-3"
            )}
          >
            {isCollapsed ? (
              <Button
                size="icon"
                variant="ghost"
                className="h-9 w-9"
                onClick={() => setIsCollapsed(false)}
              >
                <PanelLeftOpen className="h-4 w-4" />
              </Button>
            ) : (
              <>
                <div className="flex items-center gap-2 font-semibold">
                  <div className="h-6 w-6 rounded bg-primary text-primary-foreground flex items-center justify-center">W</div>
                  <span>WorkPal</span>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  onClick={() => setIsCollapsed(true)}
                >
                  <PanelLeftClose className="h-4 w-4" />
                </Button>
              </>
            )}
          </div>
          <Separator />
          <div className="flex-1 overflow-hidden">
            <ScrollArea className="h-full">
              <Nav
                isCollapsed={isCollapsed}
                links={[
                  {
                    title: "New Chat",
                    label: "",
                    icon: Plus,
                    variant: activeView === "chat" ? "default" : "ghost",
                    onClick: startNewChat,
                  },
                  {
                    title: "Current",
                    label: "",
                    icon: MessageSquare,
                    variant: activeView === "chat" && !viewingSessionId ? "default" : "ghost",
                    onClick: openCurrentChat,
                  },
                ]}
              />
              {!isCollapsed && (
                <div className="px-2 pb-2">
                  <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                    History
                  </div>
                  <div className="grid gap-1">
                    {historySorted.length === 0 ? (
                      <div className="px-2 py-2 text-xs text-muted-foreground">
                        No history yet
                      </div>
                    ) : (
                      historySorted.map((s) => (
                        <div key={s.id} className="group flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => openSessionFromHistory(s.id)}
                            className={cn(
                              "flex-1 flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground",
                              viewingSessionId === s.id && "bg-accent text-accent-foreground"
                            )}
                          >
                            <MessageSquare className="h-4 w-4 text-muted-foreground" />
                            <span className="truncate">{s.title || "New chat"}</span>
                          </button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={(e) => {
                              e.stopPropagation()
                              deleteSession(s.id)
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </ScrollArea>
          </div>
          <Separator />
          <div className="p-2">
            <Nav
              isCollapsed={isCollapsed}
              links={[
                {
                  title: "Settings",
                  label: "",
                  icon: Settings,
                  variant: activeView === "settings" ? "default" : "ghost",
                  onClick: () => {
                    abortRunning()
                    setActiveView("settings")
                  },
                },
              ]}
            />
          </div>
        </aside>

        <main className="flex-1 min-w-0 bg-background">
          {activeView === "settings" ? (
            <ScrollArea className="h-full p-6">
              <div className="max-w-2xl mx-auto space-y-6 py-6">
                <div className="space-y-1">
                  <div className="text-2xl font-semibold">LLM 设置</div>
                  <div className="text-sm text-muted-foreground">
                    支持 OpenAI 兼容接口（OpenAI / Ollama / LM Studio 等）。
                  </div>
                  {storeInfo?.userData && (
                    <div className="text-xs text-muted-foreground break-all">数据目录：{storeInfo.userData}</div>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-medium">Base URL</div>
                  <Input
                    value={llmBaseUrl}
                    onChange={(e) => setLlmBaseUrl(e.target.value)}
                    placeholder="https://api.openai.com/v1 或 http://localhost:11434/v1"
                  />
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-medium">Model</div>
                  <Input
                    value={llmModel}
                    onChange={(e) => setLlmModel(e.target.value)}
                    placeholder="gpt-4o-mini / llama3.1 / qwen2.5 ..."
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Temperature</div>
                    <Input
                      value={llmTemperature}
                      onChange={(e) => setLlmTemperature(e.target.value)}
                      placeholder="0.7"
                    />
                  </div>
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Max Tokens</div>
                    <Input
                      value={llmMaxTokens}
                      onChange={(e) => setLlmMaxTokens(e.target.value)}
                      placeholder="1024"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-4">
                    <div className="text-sm font-medium">API Key</div>
                    <div className="text-xs text-muted-foreground">
                      {llmConfig?.apiKeyPresent ? "已设置" : "未设置"}
                    </div>
                  </div>
                  <Input
                    value={llmApiKey}
                    onChange={(e) => setLlmApiKey(e.target.value)}
                    placeholder={llmConfig?.apiKeyPresent ? "（已保存，留空不修改）" : "sk-...（可留空用于本地模型）"}
                    type="password"
                  />
                  <label className="flex items-center gap-2 text-sm text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={llmClearApiKey}
                      onChange={(e) => setLlmClearApiKey(e.target.checked)}
                    />
                    清除已保存的 API Key
                  </label>
                </div>

                <div className="flex items-center gap-3">
                  <Button onClick={() => void saveLlmConfig()}>保存</Button>
                  <Button variant="secondary" onClick={() => void testLlmConfig()}>
                    测试连接
                  </Button>
                  <Button variant="outline" onClick={() => setActiveView("chat")}>
                    返回聊天
                  </Button>
                </div>

                {llmStatus && (
                  <div className="rounded-md border bg-muted/30 p-3 text-sm whitespace-pre-wrap">
                    {llmStatus}
                  </div>
                )}

                <Separator />

                <div className="space-y-1">
                  <div className="text-2xl font-semibold">头像设置</div>
                  <div className="text-sm text-muted-foreground">支持输入图片 URL 或上传本地图片。</div>
                </div>

                <div className="space-y-6">
                  <div className="space-y-3">
                    <div className="text-sm font-medium">你的头像</div>
                    <div className="flex items-center gap-3">
                      <Avatar className="h-10 w-10">
                        <AvatarImage src={userAvatarSrc || undefined} />
                        <AvatarFallback>U</AvatarFallback>
                      </Avatar>
                      <div className="flex-1">
                        <Input
                          value={userAvatarSrc}
                          onChange={(e) => setUserAvatarSrc(e.target.value)}
                          placeholder="https://... 或 data:image/..."
                        />
                      </div>
                      <input
                        ref={userAvatarFileRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0]
                          if (!f) return
                          void (async () => {
                            const dataUrl = await readFileAsDataUrl(f)
                            setUserAvatarSrc(dataUrl)
                            if (userAvatarFileRef.current) userAvatarFileRef.current.value = ""
                          })()
                        }}
                      />
                      <Button variant="outline" onClick={() => userAvatarFileRef.current?.click()}>
                        上传
                      </Button>
                      <Button variant="secondary" onClick={() => setUserAvatarSrc("")}>
                        清除
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="text-sm font-medium">AI 头像</div>
                    <div className="flex items-center gap-3">
                      <Avatar className="h-10 w-10">
                        <AvatarImage src={aiAvatarSrc || undefined} />
                        <AvatarFallback>AI</AvatarFallback>
                      </Avatar>
                      <div className="flex-1">
                        <Input
                          value={aiAvatarSrc}
                          onChange={(e) => setAiAvatarSrc(e.target.value)}
                          placeholder="https://... 或 data:image/..."
                        />
                      </div>
                      <input
                        ref={aiAvatarFileRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0]
                          if (!f) return
                          void (async () => {
                            const dataUrl = await readFileAsDataUrl(f)
                            setAiAvatarSrc(dataUrl)
                            if (aiAvatarFileRef.current) aiAvatarFileRef.current.value = ""
                          })()
                        }}
                      />
                      <Button variant="outline" onClick={() => aiAvatarFileRef.current?.click()}>
                        上传
                      </Button>
                      <Button variant="secondary" onClick={() => setAiAvatarSrc("")}>
                        清除
                      </Button>
                    </div>
                  </div>

                  <Separator />

                  <div className="space-y-3">
                    <div className="text-sm font-medium">界面风格</div>
                    <label className="flex items-center gap-2 text-sm text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={chiikawaStyle}
                        onChange={(e) => setChiikawaStyle(e.target.checked)}
                      />
                      Chiikawa 风格（柔和配色）
                    </label>
                  </div>
                </div>
              </div>
            </ScrollArea>
          ) : (
            <div className="flex h-full flex-col relative">
              <div className="absolute top-4 right-4 z-10">
                <Avatar className="h-8 w-8">
                  <AvatarImage src={aiAvatarSrc || undefined} />
                  <AvatarFallback>AI</AvatarFallback>
                </Avatar>
              </div>

              <ScrollArea ref={chatScrollAreaRef} className="flex-1 p-4">
                <div className="max-w-3xl mx-auto flex flex-col gap-4 py-8">
                  {viewedSession.messages.map((msg, index) => (
                    <div key={index} className={cn("flex gap-3", msg.role === "user" ? "flex-row-reverse" : "")}>
                      <Avatar className="h-8 w-8 shrink-0">
                        <AvatarImage src={msg.role === "ai" ? aiAvatarSrc || undefined : userAvatarSrc || undefined} />
                        <AvatarFallback>{msg.role === "ai" ? "AI" : "U"}</AvatarFallback>
                      </Avatar>
                      <div
                        className={cn(
                          "rounded-lg p-3 max-w-[80%] text-sm whitespace-pre-wrap",
                          msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"
                        )}
                      >
                        {(() => {
                          const baseText = msg.role === "ai" ? stripThinkingForDisplay(msg.content) : msg.content
                          const key = `${viewedSessionId}:${msg.createdAt}`
                          const isTyping = msg.role === "ai" && typingState?.key === key
                          const shownText = isTyping ? baseText.slice(0, typingState?.shown ?? 0) : baseText
                          return (
                            <>
                              <div>
                                {shownText}
                                {isTyping && <span className="inline-block w-2 align-baseline animate-pulse">▍</span>}
                              </div>
                              {msg.role === "ai" && msg.actions && msg.actions.length > 0 && (
                                <div className="mt-3 flex flex-wrap gap-2">
                                  {msg.actions.map((a, i) => (
                                    <Button
                                      key={`${a.type}-${a.planId}-${i}`}
                                      size="sm"
                                      variant={a.variant ?? "default"}
                                      onClick={() => {
                                        if (a.type === "applyPlan") void applyPlanToChat(viewingSessionId, a.planId)
                                        if (a.type === "cancelPlan") cancelPlanToChat(viewingSessionId, a.planId)
                                      }}
                                      disabled={isGenerating}
                                    >
                                      {a.label ?? (a.type === "applyPlan" ? "确认执行" : "取消")}
                                    </Button>
                                  ))}
                                </div>
                              )}
                            </>
                          )
                        })()}
                      </div>
                    </div>
                  ))}
                  <div ref={chatBottomRef} />
                </div>
              </ScrollArea>

              <div className="p-4 border-t bg-background">
                <div className="max-w-3xl mx-auto relative">
                {getFsRoot() && (
                  <div className="mb-2 flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
                    <div className="min-w-0 truncate">根目录：{getFsRoot()}</div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void listRootToChat(getFsRoot()!)}
                        disabled={isGenerating}
                      >
                        列出
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void scanRootToChat(getFsRoot()!)}
                        disabled={isGenerating}
                      >
                        扫描
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={clearFsRoot}
                        disabled={isGenerating}
                      >
                        清除
                      </Button>
                    </div>
                  </div>
                )}
                  <Textarea
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={isGenerating ? "Generating..." : "Message WorkPal..."}
                  className="min-h-[60px] w-full resize-none pr-24 py-3 bg-muted/50 border-none focus-visible:ring-1 focus-visible:ring-primary"
                    disabled={isGenerating}
                  />
                <Button
                  size="icon"
                  variant="ghost"
                  className="absolute right-12 bottom-2 h-8 w-8"
                  onClick={() => void pickFolderForChat()}
                  disabled={isGenerating}
                >
                  <FolderOpen className="h-4 w-4" />
                </Button>
                  <Button
                    size="icon"
                    className="absolute right-2 bottom-2 h-8 w-8"
                    onClick={handleSendMessage}
                    disabled={isGenerating || !inputValue.trim()}
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
                <div className="text-center mt-2">
                  <p className="text-xs text-muted-foreground">WorkPal can make mistakes. Please verify important information.</p>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </TooltipProvider>
  )
}

export default Layout
