export type PiMachine<S, E> = {
  init: () => S
  step: (state: S) => Promise<{ state: S; events: E[]; done: boolean }>
}

export async function* runPiMachine<S, E>(
  machine: PiMachine<S, E>,
  opts?: { signal?: AbortSignal }
): AsyncGenerator<E, S, void> {
  let state = machine.init()

  while (true) {
    if (opts?.signal?.aborted) {
      return state
    }

    const { state: nextState, events, done } = await machine.step(state)
    state = nextState

    for (const event of events) {
      if (opts?.signal?.aborted) {
        return state
      }
      yield event
    }

    if (done) {
      return state
    }
  }
}

export function sleep(ms: number, opts?: { signal?: AbortSignal }): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  if (!opts?.signal) return new Promise((resolve) => setTimeout(resolve, ms))

  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }

    const timer = setTimeout(() => {
      opts.signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)

    const onAbort = () => {
      clearTimeout(timer)
      opts.signal?.removeEventListener("abort", onAbort)
      reject(new DOMException("Aborted", "AbortError"))
    }

    opts.signal.addEventListener("abort", onAbort, { once: true })
  })
}

