import { describe, expect, it } from 'vitest'
import { cannedTurn, fakeProvider } from '../src/harness/provider/fake'
import type { GenerateRequest } from '../src/harness/provider/provider'
import type { AssistantTurn, Message } from '../src/harness/types'

function request(messages: Message[]): GenerateRequest {
  return { model: 'fake', messages, tools: [], temperature: 0, maxOutputTokens: 128 }
}

describe('the fake provider through the Provider interface', () => {
  it('round-trips a canned reply', async () => {
    const provider = fakeProvider([cannedTurn('the canned reply')])

    const turn = await provider.generate(request([{ role: 'user', content: 'hello' }]))

    expect(turn.content).toBe('the canned reply')
    expect(turn.stopReason).toBe('stop')
    expect(turn.toolCalls).toEqual([])
  })

  it('receives exactly the conversation it was given', async () => {
    const messages: Message[] = [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Two words?' },
    ]
    const provider = fakeProvider([cannedTurn('Two words.')])

    await provider.generate(request(messages))

    // Indexing returns "maybe undefined", which is the point of the flag.
    expect(provider.calls[0]?.messages).toEqual(messages)
  })

  it('carries a requested tool call as an unparsed string, with content null', async () => {
    const scripted: AssistantTurn = {
      content: null,
      toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"notes.txt"}' }],
      stopReason: 'tool_calls',
      usage: { inputTokens: 11, outputTokens: 4 },
    }
    const provider = fakeProvider([scripted])

    const turn = await provider.generate(request([{ role: 'user', content: 'read it' }]))

    expect(turn.content).toBeNull()
    expect(turn.toolCalls[0]?.arguments).toBe('{"path":"notes.txt"}')
    expect(turn.stopReason).toBe('tool_calls')
    expect(turn.usage).toEqual({ inputTokens: 11, outputTokens: 4 })
  })

  it('refuses to invent a turn it was not scripted to give', async () => {
    const provider = fakeProvider([cannedTurn('only one turn')])

    await provider.generate(request([{ role: 'user', content: 'first' }]))

    await expect(provider.generate(request([{ role: 'user', content: 'second' }]))).rejects.toThrow(
      RangeError,
    )
  })
})
