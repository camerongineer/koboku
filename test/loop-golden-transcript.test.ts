import { describe, expect, it } from 'vitest'

import { runAgent } from '../src/harness/loop'
import { fakeProvider } from '../src/harness/provider/fake'
import type { AssistantTurn, HarnessEvent, Message } from '../src/harness/types'

/**
 * M1 exit test, half one: canned responses in, exact expected message list out.
 * Every scripted turn below is recorded from `fake.ts`, and every expectation is
 * written by hand next to it. No model server, no network, no timing.
 */

const base = { model: 'fake-model', temperature: 0, maxOutputTokens: 128 }

async function collect(events: AsyncGenerator<HarnessEvent, void, undefined>): Promise<HarnessEvent[]> {
  const seen: HarnessEvent[] = []
  for await (const event of events) {
    seen.push(event)
  }
  return seen
}

describe('golden transcript: one spoken answer', () => {
  it('produces exactly the message list and exactly the events, in order', async () => {
    const messages: Message[] = [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Two words?' },
    ]
    const scripted: AssistantTurn = {
      content: 'Two words.',
      toolCalls: [],
      stopReason: 'stop',
      usage: { inputTokens: 20, outputTokens: 2 },
    }
    const provider = fakeProvider([scripted])

    const events = await collect(runAgent({ provider, messages, ...base }))

    expect(messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Two words?' },
      { role: 'assistant', content: 'Two words.' },
    ])

    expect(events).toEqual([
      { type: 'model_call_started', iteration: 1 },
      {
        type: 'model_call_finished',
        iteration: 1,
        stopReason: 'stop',
        toolCallCount: 0,
        usage: { inputTokens: 20, outputTokens: 2 },
      },
      {
        type: 'run_finished',
        reason: 'model_stop',
        iterations: 1,
        totalUsage: { inputTokens: 20, outputTokens: 2 },
      },
    ])
  })

  it('asks the provider for exactly the conversation it had at that moment, with no tool list', async () => {
    const messages: Message[] = [{ role: 'user', content: 'Two words?' }]
    const provider = fakeProvider([{ content: 'Two words.', toolCalls: [], stopReason: 'stop', usage: { inputTokens: 20, outputTokens: 2 } }])

    await collect(runAgent({ provider, messages, ...base }))

    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]).toEqual({
      model: 'fake-model',
      messages: [{ role: 'user', content: 'Two words?' }],
      tools: [],
      temperature: 0,
      maxOutputTokens: 128,
    })
  })
})

describe('golden transcript: the model asks for a tool that does not exist', () => {
  it('answers in data with the model own tool_call_id, then lets the model continue', async () => {
    const messages: Message[] = [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Read notes.txt.' },
    ]
    const scripted: AssistantTurn[] = [
      {
        content: null,
        toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"notes.txt"}' }],
        stopReason: 'tool_calls',
        usage: { inputTokens: 31, outputTokens: 14 },
      },
      {
        content: 'I have no tool available, so I cannot read notes.txt.',
        toolCalls: [],
        stopReason: 'stop',
        usage: { inputTokens: 45, outputTokens: 11 },
      },
    ]
    const provider = fakeProvider(scripted)

    const events = await collect(runAgent({ provider, messages, ...base }))

    // The refusal the model receives, spelled out rather than computed by the code under test.
    const refusal =
      'tool "read_file" does not exist in this harness: no tool is wired up yet, '
      + 'so the request was not executed.'

    expect(messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Read notes.txt.' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"notes.txt"}' }],
      },
      { role: 'tool', content: refusal, toolCallId: 'call_1', toolName: 'read_file' },
      { role: 'assistant', content: 'I have no tool available, so I cannot read notes.txt.' },
    ])

    expect(events).toEqual([
      { type: 'model_call_started', iteration: 1 },
      {
        type: 'model_call_finished',
        iteration: 1,
        stopReason: 'tool_calls',
        toolCallCount: 1,
        usage: { inputTokens: 31, outputTokens: 14 },
      },
      {
        type: 'tool_call_requested',
        iteration: 1,
        toolCallId: 'call_1',
        toolName: 'read_file',
        arguments: '{"path":"notes.txt"}',
      },
      {
        type: 'tool_result',
        iteration: 1,
        result: {
          toolCallId: 'call_1',
          toolName: 'read_file',
          output: refusal,
          isError: true,
        },
      },
      { type: 'model_call_started', iteration: 2 },
      {
        type: 'model_call_finished',
        iteration: 2,
        stopReason: 'stop',
        toolCallCount: 0,
        usage: { inputTokens: 45, outputTokens: 11 },
      },
      {
        type: 'run_finished',
        reason: 'model_stop',
        iterations: 2,
        totalUsage: { inputTokens: 76, outputTokens: 25 },
      },
    ])

    // The second call sees the refusal: this is what "the model can change strategy" means in data.
    expect(provider.calls[1]?.messages).toEqual(messages.slice(0, 4))
  })

  it('carries the arguments through unparsed, as the provider delivered them', async () => {
    const messages: Message[] = [{ role: 'user', content: 'Read notes.txt.' }]
    const provider = fakeProvider([
      {
        content: null,
        toolCalls: [{ id: 'call_9', name: 'search_files', arguments: '{"path": ' }],
        stopReason: 'tool_calls',
        usage: { inputTokens: 12, outputTokens: 6 },
      },
      { content: 'Stopping.', toolCalls: [], stopReason: 'stop', usage: { inputTokens: 13, outputTokens: 1 } },
    ])

    const events = await collect(runAgent({ provider, messages, ...base }))

    const requested = events[2]
    expect(requested?.type).toBe('tool_call_requested')
    if (requested?.type === 'tool_call_requested') {
      // Not parsed, not repaired: the string as it arrived. Parsing is a separate failure mode.
      expect(requested.arguments).toBe('{"path": ')
    }
  })
})

describe('golden transcript: a cut-off completion is never a success', () => {
  it('ends the run as truncated and does not ask for another round', async () => {
    const messages: Message[] = [{ role: 'user', content: 'List everything.' }]
    const provider = fakeProvider([
      {
        content: 'Here is everything, starting with',
        toolCalls: [],
        stopReason: 'length',
        usage: { inputTokens: 40, outputTokens: 512 },
      },
    ])

    const events = await collect(runAgent({ provider, messages, ...base }))

    expect(provider.calls).toHaveLength(1)
    expect(messages).toEqual([
      { role: 'user', content: 'List everything.' },
      { role: 'assistant', content: 'Here is everything, starting with' },
    ])
    const finished = events[1]
    if (finished?.type !== 'model_call_finished') {
      throw new Error('expected the second event to be the finished model call')
    }
    expect(finished.stopReason).toBe('length')
    expect(events.at(-1)).toEqual({
      type: 'run_finished',
      reason: 'model_truncated',
      iterations: 1,
      totalUsage: { inputTokens: 40, outputTokens: 512 },
    })
  })

  it('answers a tool call that arrived inside a cut-off completion instead of running it', async () => {
    const messages: Message[] = [{ role: 'user', content: 'Write it.' }]
    const provider = fakeProvider([
      {
        content: null,
        // Cut off mid-write: these arguments are partial on purpose.
        toolCalls: [{ id: 'call_7', name: 'write_file', arguments: '{"path":"out.txt","content":"the firs' }],
        stopReason: 'length',
        usage: { inputTokens: 40, outputTokens: 512 },
      },
    ])

    const events = await collect(runAgent({ provider, messages, ...base }))

    expect(messages).toEqual([
      { role: 'user', content: 'Write it.' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'call_7', name: 'write_file', arguments: '{"path":"out.txt","content":"the firs' }],
      },
      {
        role: 'tool',
        content:
          'tool "write_file" does not exist in this harness: no tool is wired up yet, '
          + 'so the request was not executed.',
        toolCallId: 'call_7',
        toolName: 'write_file',
      },
    ])
    expect(events.at(-1)).toEqual({
      type: 'run_finished',
      reason: 'model_truncated',
      iterations: 1,
      totalUsage: { inputTokens: 40, outputTokens: 512 },
    })
  })
})

describe('a provider failure is not turned into a tool result', () => {
  it('lets the provider error reach the caller instead of inventing a turn', async () => {
    const messages: Message[] = [{ role: 'user', content: 'Loop forever.' }]
    const provider = fakeProvider([
      {
        content: null,
        toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{}' }],
        stopReason: 'tool_calls',
        usage: { inputTokens: 5, outputTokens: 3 },
      },
    ])

    const events = collect(runAgent({ provider, messages, ...base }))

    await expect(events).rejects.toThrow(RangeError)
    // The run got as far as the refusal it could produce, and no further.
    expect(messages).toHaveLength(3)
    expect(provider.calls).toHaveLength(2)
  })
})
