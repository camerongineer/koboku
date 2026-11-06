import { describe, expect, it } from 'vitest'

import { DEFAULT_MAX_ITERATIONS, runAgent, type RunOptions } from '../src/harness/loop'
import { fakeProvider } from '../src/harness/provider/fake'
import type { AssistantTurn, HarnessEvent, Message } from '../src/harness/types'

/**
 * M1 exit test, half two: the iteration cap is proven to stop a looping fake
 * model. The looping fake never stops on its own, so the only thing that can end
 * the run is the budget. No model server, no network, no timing assumptions.
 */

const base = { model: 'fake-model', temperature: 0, maxOutputTokens: 128 }

const refusal =
  'tool "list_files" does not exist in this harness: no tool is wired up yet, '
  + 'so the request was not executed.'

/** A fake that always asks for another tool call: nothing but the cap ends it. */
function loopingScript(count: number): AssistantTurn[] {
  return Array.from({ length: count }, (_unused, index): AssistantTurn => {
    return {
      content: null,
      toolCalls: [{ id: `call_${index + 1}`, name: 'list_files', arguments: '{}' }],
      stopReason: 'tool_calls',
      usage: { inputTokens: 5, outputTokens: 3 },
    }
  })
}

async function collect(events: AsyncGenerator<HarnessEvent, void, undefined>): Promise<HarnessEvent[]> {
  const seen: HarnessEvent[] = []
  for await (const event of events) {
    seen.push(event)
  }
  return seen
}

describe('iteration cap', () => {
  it('stops a looping fake after exactly maxIterations model calls', async () => {
    const messages: Message[] = [{ role: 'user', content: 'Keep going.' }]
    const provider = fakeProvider(loopingScript(6))

    const events = await collect(runAgent({ provider, messages, ...base, maxIterations: 3 }))

    expect(provider.calls).toHaveLength(3)

    const started = events.filter((event) => event.type === 'model_call_started')
    expect(started.map((event) => event.iteration)).toEqual([1, 2, 3])

    // One assistant turn and one tool message per iteration, on top of the user message.
    expect(messages).toHaveLength(7)
    expect(messages[0]).toEqual({ role: 'user', content: 'Keep going.' })
    for (let round = 0; round < 3; round += 1) {
      expect(messages[1 + round * 2]).toEqual({
        role: 'assistant',
        content: null,
        toolCalls: [{ id: `call_${round + 1}`, name: 'list_files', arguments: '{}' }],
      })
      expect(messages[2 + round * 2]).toEqual({
        role: 'tool',
        content: refusal,
        toolCallId: `call_${round + 1}`,
        toolName: 'list_files',
      })
    }

    expect(events).toHaveLength(13)
    expect(events.at(-1)).toEqual({
      type: 'run_finished',
      reason: 'iteration_cap_exhausted',
      iterations: 3,
      totalUsage: { inputTokens: 15, outputTokens: 9 },
    })
  })

  it('ends the run before the fake runs out of scripted turns', async () => {
    const messages: Message[] = [{ role: 'user', content: 'Keep going.' }]
    // Scripted with exactly the cap: a fourth model call would make the fake raise
    // RangeError rather than invent a turn, so this passing proves it never asked.
    const provider = fakeProvider(loopingScript(3))

    const events = await collect(runAgent({ provider, messages, ...base, maxIterations: 3 }))

    expect(provider.calls).toHaveLength(3)
    expect(provider.calls[3]).toBeUndefined()
    expect(events.at(-1)).toEqual({
      type: 'run_finished',
      reason: 'iteration_cap_exhausted',
      iterations: 3,
      totalUsage: { inputTokens: 15, outputTokens: 9 },
    })
  })

  it('defaults to the standing budget of 8 when the caller gives none', async () => {
    expect(DEFAULT_MAX_ITERATIONS).toBe(8)

    const messages: Message[] = [{ role: 'user', content: 'Keep going.' }]
    const provider = fakeProvider(loopingScript(24))

    const events = await collect(runAgent({ provider, messages, ...base }))

    expect(provider.calls).toHaveLength(DEFAULT_MAX_ITERATIONS)
    expect(events.at(-1)).toEqual({
      type: 'run_finished',
      reason: 'iteration_cap_exhausted',
      iterations: 8,
      totalUsage: { inputTokens: 40, outputTokens: 24 },
    })
  })

  it('rejects a budget that is not a positive integer, before spending a model call', async () => {
    const provider = fakeProvider(loopingScript(4))

    for (const maxIterations of [0, -1, 2.5, Number.NaN]) {
      const options: RunOptions = { provider, messages: [], ...base, maxIterations }
      await expect(collect(runAgent(options))).rejects.toThrow(RangeError)
    }

    expect(provider.calls).toHaveLength(0)
  })
})
