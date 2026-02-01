export {}

type PublicLlmConfig = {
  provider: "openai-compatible"
  baseUrl: string
  model: string
  temperature?: number
  maxTokens?: number
  apiKeyPresent: boolean
}

type LlmChatMessage = { role: "system" | "user" | "assistant"; content: string }

type MemoryContext = {
  longTerm: string
  today: string
  yesterday: string
  combined: string
  dateToday: string
  dateYesterday: string
}

declare global {
  interface Window {
    api: {
      llm: {
        getConfig: () => Promise<PublicLlmConfig>
        setConfig: (input: {
          provider?: "openai-compatible"
          baseUrl?: string
          model?: string
          temperature?: number
          maxTokens?: number
          apiKey?: string
          clearApiKey?: boolean
        }) => Promise<PublicLlmConfig>
        chat: (input: {
          messages: LlmChatMessage[]
          temperature?: number
          maxTokens?: number
        }) => Promise<{ text: string }>
      }
      fs: {
        selectDirectory: () => Promise<string | null>
        list: (input: { root: string; maxEntries?: number }) => Promise<
          { path: string; type: "file" | "dir"; size: number; mtimeMs: number }[]
        >
        applyPlan: (input: {
          root: string
          operations: any[]
          commit: boolean
        }) => Promise<{ ok: boolean; root: string; preview: { title: string; detail?: string }[]; errors: string[] }>
      }
      memory: {
        getPaths: () => Promise<{ baseDir: string; longTerm: string; dailyDir: string }>
        getContext: () => Promise<MemoryContext>
        appendDaily: (input: { text: string; date?: string }) => Promise<{ path: string }>
        appendLongTerm: (input: { text: string }) => Promise<{ path: string }>
        search: (input: { query: string; limit?: number }) => Promise<{ hits: { file: string; line: number; text: string }[] }>
      }
      store: {
        getInfo: () => Promise<{ userData: string; dbPath: string }>
        get: (key: string) => Promise<any | null>
        set: (key: string, value: any) => Promise<{ ok: boolean }>
        delete: (key: string) => Promise<{ ok: boolean }>
      }
    }
  }
}
