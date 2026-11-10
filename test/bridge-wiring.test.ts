import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { toolRegistryForRun } from '../src/agent.wiring'
import { dispatchToolCall } from '../src/harness/dispatch'
import { openJail } from '../src/harness/jail'
import type { ToolCall } from '../src/harness/types'

/**
 * The wiring a real run gets, now that a test can reach it.
 *
 * `src/agent.functions.ts` may export only server functions — a plain function exported from that file
 * is served to the browser together with everything it imports — so the registry a run is built with used
 * to live inside a handler body no test could call. It moved to `src/agent.wiring.ts`, which takes a jail
 * and imports no framework, and these are the tests the M4 gap list said were missing.
 *
 * What is asserted is what the run path claims: two tools, in this order, each carrying the schema a model
 * is shown, both confined to the one jail that was handed in. No model server, no network, no clock, and
 * nothing written into the repository's own `workspace/`.
 */

/** Waits for the run before removing the directory, so no teardown can outrun an assertion. */
async function withWorkspace<R>(run: (workspace: string) => Promise<R> | R): Promise<R> {
  const workspace = mkdtempSync(join(tmpdir(), 'koboku-wiring-'))
  try {
    return await run(workspace)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

function callFor(name: string, argumentsText: string, id: string): ToolCall {
  return { id, name, arguments: argumentsText }
}

describe('the registry a run is built with', () => {
  it('holds exactly two tools, in the order a provider is shown them', () =>
    withWorkspace((workspace) => {
      const definitions = toolRegistryForRun(openJail(workspace)).definitions()

      expect(definitions.map((declared) => declared.name)).toEqual(['read_file', 'write_file'])
    }))

  it('hands each tool argument schema to the caller, not a list assembled elsewhere', () =>
    withWorkspace((workspace) => {
      const definitions = toolRegistryForRun(openJail(workspace)).definitions()

      expect(definitions[0]?.parameters.properties).toMatchObject({ path: { type: 'string' } })
      expect(definitions[1]?.parameters.properties).toMatchObject({
        path: { type: 'string' },
        content: { type: 'string' },
      })
      // The loop sends these same descriptors, so what a model is shown and what it is corrected against
      // cannot drift apart.
      expect(definitions[0]?.parameters.additionalProperties).toBe(false)
      expect(definitions[1]?.parameters.additionalProperties).toBe(false)
    }))

  it('writes then reads back one file through the jail it was handed', async () => {
    await withWorkspace(async (workspace) => {
      const registry = toolRegistryForRun(openJail(workspace))

      const wrote = await dispatchToolCall(
        callFor('write_file', '{"path":"wired.txt","content":"written by the wiring test"}', 'call_wiring_1'),
        registry,
      )
      const read = await dispatchToolCall(
        callFor('read_file', '{"path":"wired.txt"}', 'call_wiring_2'),
        registry,
      )

      expect(wrote.isError).toBe(false)
      expect(read.isError).toBe(false)
      expect(read.output).toBe('written by the wiring test')
      expect(readFileSync(join(workspace, 'wired.txt'), 'utf8')).toBe('written by the wiring test')
    })
  })

  it('confines both tools to the jail it was handed, and names that root in each refusal', async () => {
    await withWorkspace(async (workspace) => {
      const registry = toolRegistryForRun(openJail(workspace))

      const readEscape = await dispatchToolCall(
        callFor('read_file', '{"path":"../outside.txt"}', 'call_wiring_3'),
        registry,
      )
      const writeEscape = await dispatchToolCall(
        callFor('write_file', '{"path":"../outside.txt","content":"never written"}', 'call_wiring_4'),
        registry,
      )

      expect(readEscape.isError).toBe(true)
      expect(readEscape.output).toContain('resolves outside the workspace')
      expect(readEscape.output).toContain(workspace)

      expect(writeEscape.isError).toBe(true)
      expect(writeEscape.output).toContain('resolves outside the workspace')
      expect(writeEscape.output).toContain(workspace)
      // Both refusals are proved by the absence of a file, not only by their wording.
      expect(existsSync(join(workspace, '..', 'outside.txt'))).toBe(false)
    })
  })

  it('refuses a name it does not have, and names the two it does', async () => {
    await withWorkspace(async (workspace) => {
      const registry = toolRegistryForRun(openJail(workspace))

      const result = await dispatchToolCall(
        callFor('edit_file', '{"path":"notes.txt"}', 'call_wiring_5'),
        registry,
      )

      expect(result.isError).toBe(true)
      expect(result.output).toContain('read_file')
      expect(result.output).toContain('write_file')
      expect(result.output).toContain('edit_file')
    })
  })
})
