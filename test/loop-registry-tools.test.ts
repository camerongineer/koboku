import { describe, expect, it } from 'vitest'

import { z } from 'zod'

import { runAgent } from '../src/harness/loop'
import { createRegistry, type Tool, type ToolBudgets } from '../src/harness/tools/registry'
import { fakeProvider } from '../src/harness/provider/fake'
import type { AssistantTurn, HarnessEvent, Message } from '../src/harness/types'

/**
 * M3: the loop is given its tool registry. What this proves is the wiring, not the tools — every
 * tool here is a stand-in whose `execute` is a scripted function, because no real tool exists yet.
 *
 * The scripted turns reproduce what a quantised model actually sends: a tool name close to the real
 * one, and a parameter nobody declared (PLAN.md §6, M3 exit test). No model server, no network, no
 * filesystem, no clock.
 */

const base = { model: 'fake-model', temperature: 0, maxOutputTokens: 128 }

async function collect(events: AsyncGenerator<HarnessEvent, void, undefined>): Promise<HarnessEvent[]> {
  const seen: HarnessEvent[] = []
  for await (const event of events) {
    seen.push(event)
  }
  return seen
}

function standIn(overrides: Partial<Tool> = {}) {
  const executions: { args: unknown; budgets: ToolBudgets }[] = []
  const tool: Tool = {
    name: 'read_file',
    description: 'Read a file inside the workspace.',
    arguments: z.object({ path: z.string().min(1) }),
    budgets: { maxBytes: 500, deadlineMs: 2000 },
    execute: async (args, context) => {
      executions.push({ args, budgets: context.budgets })
      return { output: 'the file says: hello', isError: false }
    },
    ...overrides,
  }
  return { tool, executions }
}

describe('the loop with a tool registry', () => {
  it('hands the provider the declared tools, with their argument schemas', async () => {
    const { tool } = standIn()
    const messages: Message[] = [{ role: 'user', content: 'Read notes.txt.' }]
    const provider = fakeProvider([{ content: 'Done.', toolCalls: [], stopReason: 'stop', usage: { inputTokens: 9, outputTokens: 2 } }])

    await collect(runAgent({ provider, messages, registry: createRegistry([tool]), ...base }))

    const tools = provider.calls[0]?.tools ?? []
    expect(tools.map((declared) => declared.name)).toEqual(['read_file'])
    expect(tools[0]?.description).toBe('Read a file inside the workspace.')
    expect(tools[0]?.parameters.properties).toMatchObject({ path: { type: 'string' } })
    // The same promise the refusal makes later: extra parameters are not accepted.
    expect(tools[0]?.parameters.additionalProperties).toBe(false)
  })

  it('runs a call the model asked for and hands the output back as a tool message', async () => {
    const { tool, executions } = standIn()
    const messages: Message[] = [{ role: 'user', content: 'Read notes.txt.' }]
    const scripted: AssistantTurn[] = [
      {
        content: null,
        toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"notes.txt"}' }],
        stopReason: 'tool_calls',
        usage: { inputTokens: 31, outputTokens: 14 },
      },
      { content: 'It says hello.', toolCalls: [], stopReason: 'stop', usage: { inputTokens: 44, outputTokens: 6 } },
    ]
    const provider = fakeProvider(scripted)

    const events = await collect(runAgent({ provider, messages, registry: createRegistry([tool]), ...base }))

    expect(executions.map((run) => run.args)).toEqual([{ path: 'notes.txt' }])
    expect(messages).toEqual([
      { role: 'user', content: 'Read notes.txt.' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"notes.txt"}' }],
      },
      { role: 'tool', content: 'the file says: hello', toolCallId: 'call_1', toolName: 'read_file' },
      { role: 'assistant', content: 'It says hello.' },
    ])
    expect(events.at(-1)).toEqual({
      type: 'run_finished',
      reason: 'model_stop',
      iterations: 2,
      totalUsage: { inputTokens: 75, outputTokens: 20 },
    })
  })

  it('refuses an invented name and an invented parameter, and the model reads the refusal next call', async () => {
    const { tool, executions } = standIn()
    const messages: Message[] = [{ role: 'user', content: 'Read notes.txt.' }]
    const scripted: AssistantTurn[] = [
      {
        content: null,
        // Both halves of the mistake a quantised model makes: the name is close, the parameter is invented.
        toolCalls: [{ id: 'call_2', name: 'readFile', arguments: '{"path":"notes.txt","maxBytes":12}' }],
        stopReason: 'tool_calls',
        usage: { inputTokens: 30, outputTokens: 15 },
      },
      { content: 'Then I cannot read it.', toolCalls: [], stopReason: 'stop', usage: { inputTokens: 52, outputTokens: 7 } },
    ]
    const provider = fakeProvider(scripted)

    const events = await collect(runAgent({ provider, messages, registry: createRegistry([tool]), ...base }))

    expect(executions).toHaveLength(0)

    const resultEvent = events.find((event) => event.type === 'tool_result')
    if (resultEvent?.type !== 'tool_result') {
      throw new Error('expected a tool_result event for the refused call')
    }
    expect(resultEvent.result.isError).toBe(true)
    expect(resultEvent.result.toolCallId).toBe('call_2')
    expect(resultEvent.result.output).toContain('does not exist in this harness')
    expect(resultEvent.result.output).toContain('tools that do exist: read_file')

    // The next provider call sees the refusal, which is what lets the model correct the name.
    const secondCall = provider.calls[1]?.messages ?? []
    expect(secondCall.at(-1)).toEqual({
      role: 'tool',
      content: resultEvent.result.output,
      toolCallId: 'call_2',
      toolName: 'readFile',
    })
  })

  it('refuses invented arguments on a tool that does exist, before running it', async () => {
    const { tool, executions } = standIn()
    const messages: Message[] = [{ role: 'user', content: 'Read notes.txt.' }]
    const scripted: AssistantTurn[] = [
      {
        content: null,
        toolCalls: [{ id: 'call_3', name: 'read_file', arguments: '{"path":"notes.txt","maxBytes":12}' }],
        stopReason: 'tool_calls',
        usage: { inputTokens: 30, outputTokens: 15 },
      },
      { content: 'Trying again.', toolCalls: [], stopReason: 'stop', usage: { inputTokens: 51, outputTokens: 7 } },
    ]
    const provider = fakeProvider(scripted)

    await collect(runAgent({ provider, messages, registry: createRegistry([tool]), ...base }))

    expect(executions).toHaveLength(0)
    const secondCall = provider.calls[1]?.messages ?? []
    expect(String(secondCall.at(-1)?.content)).toContain('not what it accepts')
    expect(String(secondCall.at(-1)?.content)).toContain('Unrecognized key')
  })

  it('reports unparseable arguments as its own failure, on a declared tool', async () => {
    const { tool, executions } = standIn()
    const messages: Message[] = [{ role: 'user', content: 'Read notes.txt.' }]
    const provider = fakeProvider([
      {
        content: null,
        toolCalls: [{ id: 'call_4', name: 'read_file', arguments: '{"path": ' }],
        stopReason: 'tool_calls',
        usage: { inputTokens: 20, outputTokens: 9 },
      },
      { content: 'Stopping.', toolCalls: [], stopReason: 'stop', usage: { inputTokens: 33, outputTokens: 4 } },
    ])

    await collect(runAgent({ provider, messages, registry: createRegistry([tool]), ...base }))

    expect(executions).toHaveLength(0)
    expect(String((provider.calls[1]?.messages ?? []).at(-1)?.content)).toContain('not parseable as JSON')
  })

  it('still answers every call as unknown when no registry is given, as it did before tools', async () => {
    const messages: Message[] = [{ role: 'user', content: 'Read notes.txt.' }]
    const provider = fakeProvider([
      {
        content: null,
        toolCalls: [{ id: 'call_5', name: 'read_file', arguments: '{"path":"notes.txt"}' }],
        stopReason: 'tool_calls',
        usage: { inputTokens: 20, outputTokens: 9 },
      },
      { content: 'No tool then.', toolCalls: [], stopReason: 'stop', usage: { inputTokens: 33, outputTokens: 4 } },
    ])

    await collect(runAgent({ provider, messages, ...base }))

    expect(provider.calls[0]?.tools).toEqual([])
    expect(String((provider.calls[1]?.messages ?? []).at(-1)?.content)).toBe(
      'tool "read_file" does not exist in this harness: no tool is wired up yet, '
      + 'so the request was not executed.',
    )
  })
})
