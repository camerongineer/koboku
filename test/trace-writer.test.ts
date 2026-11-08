import { describe, expect, it, beforeAll, afterAll } from 'vitest'

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runAgent } from '../src/harness/loop'
import { DEFAULT_TRACE_DIRECTORY, openTrace } from '../src/harness/trace'
import { fakeProvider } from '../src/harness/provider/fake'
import type { AssistantTurn, HarnessEvent, Message } from '../src/harness/types'

/**
 * M2, step one: the trace writer puts every harness event on disk as the event
 * happens, into one file per run, inside the trace directory.
 *
 * No model server, no network, and no timing assumption. Incrementality is proven by
 * the scripted provider's own record of what it was asked — at the moment asserted,
 * it has not been called yet — so the proof does not rest on a clock. Tests write
 * into a temporary directory, never into the repository's own `traces/`.
 */

const base = { model: 'fake-model', temperature: 0, maxOutputTokens: 128 }

/** A call whose arguments string is cut off mid-write, and the answer that closes the run. */
function script(): AssistantTurn[] {
  return [
    {
      content: null,
      toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path": "notes.txt' }],
      stopReason: 'tool_calls',
      usage: { inputTokens: 11, outputTokens: 4 },
    },
    {
      content: 'nothing to read',
      toolCalls: [],
      stopReason: 'stop',
      usage: { inputTokens: 14, outputTokens: 2 },
    },
  ]
}

let directory = ''

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'koboku-trace-'))
})

afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
})

/** The file as it stands right now: one JSON document per line, no trailing blank. */
function lines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter((line) => line !== '')
}

function records(path: string): Record<string, unknown>[] {
  return lines(path).map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('the trace writer', () => {
  it('creates the file for one run and writes the header before any event', () => {
    const trace = openTrace({ runId: 'run-header', model: 'fake-model', directory })

    expect(trace.path).toBe(join(directory, 'run-header.jsonl'))
    expect(existsSync(trace.path)).toBe(true)
    expect(records(trace.path)).toEqual([
      { type: 'run_header', runId: 'run-header', model: 'fake-model' },
    ])

    // A second run id is a second file: one file per run, each with its own header.
    const other = openTrace({ runId: 'run-other', model: 'fake-model', directory })
    expect(other.path).not.toBe(trace.path)
    expect(records(other.path)[0]).toEqual({
      type: 'run_header',
      runId: 'run-other',
      model: 'fake-model',
    })
    expect(lines(trace.path)).toHaveLength(1)
  })

  it('writes each event to disk while the run is still in progress', async () => {
    const trace = openTrace({ runId: 'run-live', model: 'fake-model', directory })
    const provider = fakeProvider(script())
    const messages: Message[] = [{ role: 'user', content: 'Read notes.txt.' }]

    const seen: HarnessEvent[] = []
    for await (const event of runAgent({ provider, messages, ...base })) {
      seen.push(event)
      trace.write(event)

      if (event.type === 'model_call_started' && event.iteration === 1) {
        // The scripted provider has been asked nothing yet, so this point in the run
        // is provably mid-flight: the header and this one event are already on disk.
        expect(provider.calls).toHaveLength(0)
        expect(lines(trace.path)).toHaveLength(2)
        expect(JSON.parse(lines(trace.path)[1] ?? '')).toEqual(event)
      }
    }

    // Nothing lost and nothing reordered: header plus every event the loop yielded.
    expect(seen).toHaveLength(7)
    expect(records(trace.path).slice(1)).toEqual(seen)
    expect(records(trace.path).at(-1)).toEqual({
      type: 'run_finished',
      reason: 'model_stop',
      iterations: 2,
      totalUsage: { inputTokens: 25, outputTokens: 6 },
    })
  })

  it('records the arguments string exactly as the model wrote it, cut off and all', () => {
    const trace = openTrace({ runId: 'run-raw-arguments', model: 'fake-model', directory })
    const requested: HarnessEvent = {
      type: 'tool_call_requested',
      iteration: 1,
      toolCallId: 'call_1',
      toolName: 'read_file',
      arguments: '{"path": "notes.txt',
    }
    trace.write(requested)

    const record = records(trace.path)[1]
    expect(record?.['arguments']).toBe('{"path": "notes.txt')
    // The trace repaired nothing: it is still unparseable, exactly as received.
    expect(() => JSON.parse(String(record?.['arguments']))).toThrow()
  })

  it('refuses a run id that would place the file outside the trace directory', () => {
    for (const runId of ['../escaped', '..\\escaped', 'a/b', 'a\\b', '..', '.', '', 'C:evil']) {
      expect(() => openTrace({ runId, model: 'fake-model', directory })).toThrow(RangeError)
    }
    expect(existsSync(join(directory, '..', 'escaped.jsonl'))).toBe(false)
    expect(existsSync(join(directory, 'a'))).toBe(false)
  })

  it('creates the directory when it does not exist yet', () => {
    const nested = join(directory, 'deep', 'deeper')
    expect(existsSync(nested)).toBe(false)

    const trace = openTrace({ runId: 'run-nested', model: 'fake-model', directory: nested })

    expect(existsSync(trace.path)).toBe(true)
    expect(lines(trace.path)).toHaveLength(1)
  })

  it('defaults to the directory the plan names', () => {
    // The constant only: calling openTrace without a directory would write inside the
    // repository, and a test has no business leaving artefacts in a git-ignored folder.
    expect(DEFAULT_TRACE_DIRECTORY).toBe('traces')
  })
})
