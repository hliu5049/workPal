import { runPiMachine, sleep, type PiMachine } from "@renderer/agent/pi-mono"

export type AgentPhase =
  | "提问"
  | "思考"
  | "规划"
  | "行动"
  | "观察"
  | "等待"
  | "检查"
  | "纠错"
  | "完成"

export type AgentLoopEvent =
  | { type: "phase"; phase: AgentPhase; text: string }
  | { type: "done"; text: string }

type AgentState = {
  question: string
  phase: AgentPhase
  iteration: number
  lastObservation: string | null
  lastError: string | null
  done: boolean
}

function nextPhase(state: AgentState): AgentPhase {
  if (state.phase === "提问") return "思考"
  if (state.phase === "思考") return "规划"
  if (state.phase === "规划") return "行动"
  if (state.phase === "行动") return "观察"
  if (state.phase === "观察") return state.iteration === 0 ? "思考" : "检查"
  if (state.phase === "等待") return "检查"
  if (state.phase === "检查") return state.lastError ? "纠错" : "完成"
  if (state.phase === "纠错") return "行动"
  return "完成"
}

function makePhaseText(state: AgentState): string {
  if (state.phase === "提问") return state.question
  if (state.phase === "思考") {
    return state.iteration === 0
      ? "正在理解问题并确定目标。"
      : "根据观察结果更新思路，准备下一步行动。"
  }
  if (state.phase === "规划") {
    return "拟定一条可执行的方案，并拆解为可验证的步骤。"
  }
  if (state.phase === "行动") {
    return state.iteration === 0
      ? "执行第一轮行动（模拟工具调用/任务推进）。"
      : "执行修正后的行动（根据检查/纠错结果调整）。"
  }
  if (state.phase === "观察") {
    return state.lastObservation ?? "收集执行结果并记录关键观测。"
  }
  if (state.phase === "等待") {
    return "等待外部事件/异步结果完成。"
  }
  if (state.phase === "检查") {
    return state.lastError
      ? `发现问题：${state.lastError}`
      : "检查通过，准备输出最终结果。"
  }
  if (state.phase === "纠错") {
    return "基于检查结果定位原因并制定修复动作。"
  }
  return "完成。"
}

function makeFinalAnswer(state: AgentState): string {
  return `已完成：${state.question}`
}

export async function* runAgentLoop(
  question: string,
  opts?: { signal?: AbortSignal }
): AsyncGenerator<AgentLoopEvent, void, void> {
  const machine: PiMachine<AgentState, AgentLoopEvent> = {
    init: () => ({
      question,
      phase: "提问",
      iteration: 0,
      lastObservation: null,
      lastError: null,
      done: false,
    }),
    step: async (state) => {
      const events: AgentLoopEvent[] = []

      if (state.done) {
        return { state, events, done: true }
      }

      if (state.phase === "等待") {
        try {
          await sleep(500, { signal: opts?.signal })
        } catch {
          return { state: { ...state, done: true }, events, done: true }
        }
      }

      const phaseText = makePhaseText(state)
      events.push({ type: "phase", phase: state.phase, text: phaseText })

      let next: AgentState = { ...state }

      if (state.phase === "观察") {
        next = {
          ...next,
          lastObservation:
            next.lastObservation ??
            (next.iteration === 0
              ? "第一轮行动完成，已拿到初步结果。"
              : "第二轮行动完成，结果已稳定。"),
          iteration: next.iteration + 1,
        }
      }

      if (state.phase === "检查") {
        const shouldFail = next.iteration < 2
        next = { ...next, lastError: shouldFail ? "需要再执行一轮修正。" : null }
      }

      if (state.phase === "完成") {
        next = { ...next, done: true }
        events.push({ type: "done", text: makeFinalAnswer(next) })
        return { state: next, events, done: true }
      }

      next = { ...next, phase: nextPhase(next) }
      return { state: next, events, done: false }
    },
  }

  for await (const event of runPiMachine(machine, { signal: opts?.signal })) {
    yield event
  }
}

