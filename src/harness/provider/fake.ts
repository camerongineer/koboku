import type { AssistantTurn } from '../types'
import type { GenerateRequest, Provider } from './provider'

/**
 * A scripted provider. Same interface as strata.ts, no network and no model.
 * Every test uses this one.
 */
export interface FakeProvider extends Provider {
  /** What it was asked, in order, so a test can assert the conversation it saw. */
  readonly calls: GenerateRequest[]
}

export function fakeProvider(script: AssistantTurn[]): FakeProvider {
  const calls: GenerateRequest[] = []
  let next = 0
  return {
    calls,
    async generate(request) {
      calls.push(request)
      const turn = script[next]
      if (turn === undefined) {
        throw new RangeError(`fake provider is out of scripted turns (asked for turn ${next + 1})`)
      }
      next += 1
      return turn
    },
  }
}

/** A plain spoken answer: the shape a conversation is made of. */
export function cannedTurn(content: string): AssistantTurn {
  return {
    content,
    toolCalls: [],
    stopReason: 'stop',
    usage: { inputTokens: 0, outputTokens: 0 },
  }
}
