import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runAgent } from '../src/harness/loop'
import { openTrace, type TraceWriter } from '../src/harness/trace'
import { fakeProvider } from '../src/harness/provider/fake'
import type { AssistantTurn, HarnessEvent, Message } from '../src/harness/types'

/**
 * M2, step two: the loop records its own events. The caller opens the trace and the
 * loop fills it, so a run is accountable even when the caller is careless about what
 * it receives. No model server, no network, no clock.
 */

const base = { model: 'fake-model', temperature: 0, maxOutputTokens: 128 }

function script(): AssistantTurn[] {
  return [
    {
      content: null,
      toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path": "notes.txt"}' }],
      stopReason: 'tool_calls',
      usage: { inputTokens: 11, outputTokens: 4 },
    },
    {
      content: 'there is nothing to read',
      toolCalls: [],
      stopReason: 'stop',
      usage: { inputTokens: 14, outputTokens: 2 },
    },
  ]
}

async function collect(events: AsyncGenerator<HarnessEvent, void, undefined>): Promise<HarnessEvent[]> {
  const seen: HarnessEvent[] = []
  for await (const event of events) {
    seen.push(event)
  }
  return seen
}

function records(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

let directory = ''

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'koboku-loop-trace-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('the loop writing into a trace', () => {
  it('records every event it yields, with no help from the caller', async () => {
    const trace = openTrace({ runId: 'loop-full', model: 'fake-model', directory })
    const provider = fakeProvider(script())
    const messages: Message[] = [{ role: 'user', content: 'Read notes.txt.' }]

    const seen = await collect(runAgent({ provider, messages, ...base, trace }))

    expect(seen).toHaveLength(7)
    // The file holds exactly what the run produced: one header, then the same seven
    // events in the same order, including the tool result and the closing event.
    expect(records(trace.path)).toEqual([
      { type: 'run_header', runId: 'loop-full', model: 'fake-model' },
      ...seen,
    ])
  })

  it('records an event the caller never stores', async () => {
    const trace = openTrace({ runId: 'loop-discarded', model: 'fake-model', directory })
    const provider = fakeProvider(script())
    const messages: Message[] = [{ role: 'user', content: 'Read notes.txt.' }]

    const events = runAgent({ provider, messages, ...base, trace })
    await events.next()
    await events.next()
    await events.return(undefined)

    // Two events were produced and dropped on the floor; both are in the file, and the
    // second one proves the model call really happened.
    expect(provider.calls).toHaveLength(1)
    expect(records(trace.path)).toHaveLength(3)
    expect(records(trace.path).at(-1)).toEqual({
      type: 'model_call_finished',
      iteration: 1,
      stopReason: 'tool_calls',
      toolCallCount: 1,
      usage: { inputTokens: 11, outputTokens: 4 },
    })
  })

  it('ends the run when the trace cannot be written, before spending a model call', async () => {
    const broken: TraceWriter = {
      path: join(directory, 'unwritable.jsonl'),
      write(): void {
        throw new Error('disk full')
      },
    }
    const provider = fakeProvider(script())
    const messages: Message[] = [{ role: 'user', content: 'Read notes.txt.' }]

    await expect(collect(runAgent({ provider, messages, ...base, trace: broken })))
      .rejects.toThrow('disk full')

    // The first event is produced before the provider is asked anything, so a record
    // that cannot be written stops the run at once instead of running unrecorded.
    expect(provider.calls).toHaveLength(0)
  })

  it('changes nothing about the run when no trace is given', async () => {
    const trace = openTrace({ runId: 'loop-compared', model: 'fake-model', directory })
    const tracedEvents = await collect(
      runAgent({ provider: fakeProvider(script()), messages: [], ...base, trace }),
    )
    const bareEvents = await collect(
      runAgent({ provider: fakeProvider(script()), messages: [], ...base }),
    )

    // Two identical runs, one watched and one not: the events are the same either way,
    // so the sink is an addition to the run and not a change in it.
    expect(bareEvents).toEqual(tracedEvents)
  })
})
