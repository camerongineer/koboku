import { afterEach, describe, expect, it } from 'vitest'

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { runRecorded, type RunSummary } from '../src/agent.run'
import type { HarnessConfig } from '../src/harness/config'

/**
 * M2, step three: the bridge runs the loop and records the run. The composition is
 * imported from `src/agent.run.ts`, which has no framework in it, so these tests need
 * neither the framework nor a browser. No model server, no network, no clock-dependent
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
 * Every completed run leaves a trace behind, so every test that completes one registers
 * that file for cleanup. A git-ignored folder is not a licence to leave litter in it.
 */
async function runAndTrack(prompt: string): Promise<RunSummary> {
  const summary = await runRecorded(prompt, config)
  writtenTracePaths.push(tracePathFor(summary))
  return summary
}

function records(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('the bridge running a recorded loop', () => {
  it('refuses a prompt that is only whitespace, before anything is opened', async () => {
    await expect(runRecorded('   ', config)).rejects.toThrow('a run needs a prompt')
  })

  it('runs the loop to its end and reports what happened', async () => {
    const summary = await runAndTrack('  Read notes.txt.  ')

    expect(summary.finishReason).toBe('model_stop')
    expect(summary.iterations).toBe(1)
    // Provider-reported numbers only: the scripted turn reports zero, and the bridge
    // invents nothing.
    expect(summary.totalUsage).toEqual({ inputTokens: 0, outputTokens: 0 })
    // Trimmed on the way in, so the page sees the reply to what was actually asked.
    expect(summary.finalContent).toBe('scripted reply to: Read notes.txt.')
  })

  it('writes a trace for the run into the standing directory', async () => {
    const summary = await runAndTrack('Trace this run.')
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
    const summary = await runAndTrack('Name this run.')

    expect(summary.runId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  })

  it('returns plain data with no server path in it', async () => {
    const summary = await runAndTrack('What crosses the boundary?')

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
