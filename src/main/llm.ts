import { app } from "electron"
import { readFile, writeFile, mkdir } from "fs/promises"
import { dirname, join } from "path"

export type LlmConfig = {
  provider: "openai-compatible"
  baseUrl: string
  model: string
  apiKey?: string
  temperature?: number
  maxTokens?: number
}

export type PublicLlmConfig = Omit<LlmConfig, "apiKey"> & { apiKeyPresent: boolean }

type ChatRole = "system" | "user" | "assistant"
export type ChatMessage = { role: ChatRole; content: string }

function configPath(): string {
  return join(app.getPath("userData"), "llm-config.json")
}

function toPublic(cfg: LlmConfig): PublicLlmConfig {
  const { apiKey, ...rest } = cfg
  return { ...rest, apiKeyPresent: Boolean(apiKey && apiKey.trim()) }
}

export async function readLlmConfig(): Promise<LlmConfig> {
  const fallback: LlmConfig = {
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    temperature: 0.7,
    maxTokens: 1024,
  }

  try {
    const raw = await readFile(configPath(), "utf-8")
    const parsed = JSON.parse(raw) as Partial<LlmConfig>
    return {
      ...fallback,
      ...parsed,
      provider: "openai-compatible",
    }
  } catch {
    return fallback
  }
}

export async function readPublicLlmConfig(): Promise<PublicLlmConfig> {
  const cfg = await readLlmConfig()
  return toPublic(cfg)
}

export async function writeLlmConfig(input: {
  provider?: "openai-compatible"
  baseUrl?: string
  model?: string
  apiKey?: string
  clearApiKey?: boolean
  temperature?: number
  maxTokens?: number
}): Promise<PublicLlmConfig> {
  const current = await readLlmConfig()
  const next: LlmConfig = {
    ...current,
    provider: "openai-compatible",
    baseUrl: typeof input.baseUrl === "string" ? input.baseUrl : current.baseUrl,
    model: typeof input.model === "string" ? input.model : current.model,
    temperature: typeof input.temperature === "number" ? input.temperature : current.temperature,
    maxTokens: typeof input.maxTokens === "number" ? input.maxTokens : current.maxTokens,
    apiKey: current.apiKey,
  }

  if (input.clearApiKey) {
    next.apiKey = ""
  } else if (typeof input.apiKey === "string" && input.apiKey.trim()) {
    next.apiKey = input.apiKey
  }

  const path = configPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(next, null, 2), "utf-8")
  return toPublic(next)
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "")
}

export async function chatCompletion(args: {
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
}): Promise<{ text: string }> {
  const cfg = await readLlmConfig()
  const baseUrl = normalizeBaseUrl(cfg.baseUrl)
  const url = `${baseUrl}/chat/completions`

  const body = {
    model: cfg.model,
    messages: args.messages,
    temperature: typeof args.temperature === "number" ? args.temperature : cfg.temperature,
    max_tokens: typeof args.maxTokens === "number" ? args.maxTokens : cfg.maxTokens,
    stream: false,
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
  }
  if (cfg.apiKey && cfg.apiKey.trim()) {
    headers.authorization = `Bearer ${cfg.apiKey}`
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`LLM request failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ""}`)
  }

  const json = (await res.json()) as any
  const content =
    json?.choices?.[0]?.message?.content ??
    json?.choices?.[0]?.delta?.content ??
    json?.choices?.[0]?.text
  if (typeof content !== "string") {
    throw new Error("LLM response missing message content")
  }
  return { text: content }
}

