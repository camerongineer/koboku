import { afterEach, describe, expect, it } from 'vitest'

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { streamRun, type RunStreamValue, type RunSummary } from '../src/agent.run'
import type { HarnessConfig } from '../src/harness/config'
import { cannedTurn, fakeProvider, type FakeProvider } from '../src/harness/provider/fake'
import type { Provider } from '../src/harness/provider/provider'
import type { HarnessEvent } from '../src/harness/types'

/**
 * M2, step six: a run is given its provider. These tests hand in the scripted one, which is
 * what AGENTS.md §3 rule 4 means in practice — the composition is identical except for who
 * answers, and no test here can reach the model server even by accident. The streamed shape
 * is driven with `next()`, which the wire cannot do (it has no `next` of its own), so the
 * order values arrive in is assertable. No model server, no network, no clock-dependent
 * assertion.
 */

// A stand-in for the standing config. The key value is inert: the scripted provider is
// used, so nothing here contacts a server, and no test depends on `.env.local`.
const config: HarnessConfig = {
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: 'bridge-test-model',
  apiKey: 'inert-value-not-a-secret',
  temperature: 0,
  maxOutputTokens: 128,
}

const writtenTracePaths: string[] = []

afterEach(() => {
  for (const path of writtenTracePaths.splice(0)) {
    rmSync(path, { force: true })
  }
})

function tracePathFor(summary: RunSummary): string {
  return join('traces', `${summary.runId}.jsonl`)
}

/**
 * Pulls every value off the stream. The summary is read from the yielded values, not from the
 * generator's return, because that is the only shape the wire can carry.
 */
async function drainRun(
  prompt: string,
  provider: Provider,
): Promise<{ events: HarnessEvent[]; summary: RunSummary }> {
  const values: RunStreamValue[] = []
  const run = streamRun(prompt, provider, config)

  let step = await run.next()
  while (!step.done) {
    values.push(step.value)
    step = await run.next()
  }
  expect(step.value).toBeUndefined()

  const summary = summaryOf(values.at(-1))
  const events = values.filter((value): value is HarnessEvent => value.type !== 'run_summary')
  writtenTracePaths.push(tracePathFor(summary))
  return { events, summary }
}

/** The last value of a stream must be the summary, or the stream is incomplete. */
function summaryOf(value: RunStreamValue | undefined): RunSummary {
  if (value === undefined || value.type !== 'run_summary') {
    throw new Error('the stream ended without a run_summary value')
  }
  return value.summary
}

/**
 * Every completed run leaves a trace behind, so every test that completes one registers
 * that file for cleanup. A git-ignored folder is not a licence to leave litter in it.
 */
async function runAndTrack(prompt: string, provider: Provider): Promise<RunSummary> {
  const { summary } = await drainRun(prompt, provider)
  return summary
}

/** The scripted answer this suite runs against, kept so a test can also read `provider.calls`. */
function scripted(content: string): FakeProvider {
  return fakeProvider([cannedTurn(content)])
}

/** Which trace files exist right now, so a test can see exactly which one a run opened. */
function traceFileNames(): string[] {
  return existsSync('traces') ? readdirSync('traces').sort() : []
}

function records(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('the bridge running a recorded loop', () => {
  it('refuses a prompt that is only whitespace, before anything is opened', async () => {
    const before = traceFileNames()
    const provider = scripted('never asked')
    const run = streamRun('   ', provider, config)

    // The body of an async generator runs on the first `next()`, so the refusal lands
    // there rather than at the call. Either way it lands before a file exists.
    await expect(run.next()).rejects.toThrow('a run needs a prompt')
    expect(traceFileNames()).toEqual(before)
    expect(provider.calls).toHaveLength(0)
  })

  it('hands over each event while the run is still going', async () => {
    const before = traceFileNames()
    const run = streamRun('Stream this run.', scripted('streamed'), config)

    // One value pulled, and the run is visibly unfinished: no summary yet, and the
    // closing event has not been seen.
    const first = await run.next()
    if (first.done) {
      throw new Error('the run finished before yielding anything')
    }
    const values: RunStreamValue[] = [first.value]
    expect(values[0]?.type).toBe('model_call_started')

    // The trace is already ahead of the consumer. The loop records an event before it
    // yields it (src/harness/loop.ts:107), so the header and this one event are on disk
    // while the caller is still holding only the first one.
    const opened = traceFileNames().filter((name) => !before.includes(name))
    expect(opened).toHaveLength(1)
    const openedPath = join('traces', opened[0] ?? 'none')
    writtenTracePaths.push(openedPath)
    const writtenSoFar = records(openedPath)
    expect(writtenSoFar).toHaveLength(2)
    expect(writtenSoFar[1]?.type).toBe('model_call_started')

    let step = await run.next()
    while (!step.done) {
      values.push(step.value)
      step = await run.next()
    }
    expect(step.value).toBeUndefined()

    const summary = summaryOf(values.at(-1))
    expect(tracePathFor(summary)).toBe(openedPath)

    // The order a page would render is the order the loop produced, and the summary is one
    // more value on the same stream rather than something hidden in the generator's return.
    expect(values.map((value) => value.type)).toEqual([
      'model_call_started',
      'model_call_finished',
      'run_finished',
      'run_summary',
    ])
    expect(summary.iterations).toBe(1)
  })

  it('runs the loop to its end and reports what happened', async () => {
    const provider = scripted('the scripted reply')
    const summary = await runAndTrack('  Read notes.txt.  ', provider)

    expect(summary.finishReason).toBe('model_stop')
    expect(summary.iterations).toBe(1)
    // Provider-reported numbers only: the scripted turn reports zero, and the bridge
    // invents nothing.
    expect(summary.totalUsage).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(summary.finalContent).toBe('the scripted reply')
    // Trimmed on the way in: this is what the provider was actually asked, which is the
    // only proof of trimming that survives the provider no longer being built here.
    expect(provider.calls[0]?.messages[0]?.content).toBe('Read notes.txt.')
  })

  it('writes a trace for the run into the standing directory', async () => {
    const summary = await runAndTrack('Trace this run.', scripted('traced'))
    const path = tracePathFor(summary)

    expect(existsSync(path)).toBe(true)
    const written = records(path)
    expect(written[0]).toEqual({
      type: 'run_header',
      runId: summary.runId,
      model: 'bridge-test-model',
    })
    // The loop filled the file on its own: the bridge never hands an event to the writer.
    expect(written.at(-1)).toEqual({
      type: 'run_finished',
      reason: 'model_stop',
      iterations: 1,
      totalUsage: { inputTokens: 0, outputTokens: 0 },
    })
    // One spoken iteration is three events — a model call started, a model call
    // finished, the run closing — plus the header.
    expect(written).toHaveLength(4)
  })

  it('names the run so the trace guard accepts it', async () => {
    const summary = await runAndTrack('Name this run.', scripted('named'))

    expect(summary.runId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  })

  it('returns plain data with no server path in it', async () => {
    const summary = await runAndTrack('What crosses the boundary?', scripted('plain'))

    expect(Object.keys(summary).sort()).toEqual([
      'finalContent',
      'finishReason',
      'iterations',
      'runId',
      'totalUsage',
    ])
    // The run id travels; the location of the trace file does not.
    expect(JSON.stringify(summary)).not.toContain('traces')
  })
})
