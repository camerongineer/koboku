import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { dispatchToolCall } from '../src/harness/dispatch'
import { openJail } from '../src/harness/jail'
import { createRegistry } from '../src/harness/tools/registry'
import { readFileTool } from '../src/harness/tools/read-file'
import type { Tool } from '../src/harness/tools/registry'
import type { ToolCall } from '../src/harness/types'

/**
 * M3, last step: the first real tool. This is the only test file in the suite that reads a real file,
 * and it reads one it created in a temporary directory inside the test and deleted afterwards. No
 * model server, no network, no clock, and nothing written into the repository's own `workspace/`.
 */

/** Windows needs a junction, which needs no elevated privileges; elsewhere a directory link. */
function linkKind(): 'junction' | 'dir' {
  return process.platform === 'win32' ? 'junction' : 'dir'
}

function withWorkspace<R>(run: (workspace: string, outside: string) => R): R {
  const workspace = mkdtempSync(join(tmpdir(), 'koboku-work-'))
  const outside = mkdtempSync(join(tmpdir(), 'koboku-out-'))
  try {
    return run(workspace, outside)
  } finally {
    rmSync(outside, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
}

function callNamed(name: string, argumentsText: string): ToolCall {
  return { id: 'call_read_1', name, arguments: argumentsText }
}

describe('read_file', () => {
  it('reads a real file through dispatch, from the arguments string a provider sends', async () => {
    await withWorkspace(async (workspace) => {
      writeFileSync(join(workspace, 'notes.txt'), 'the answer is 42')
      const registry = createRegistry([readFileTool({ jail: openJail(workspace) })])

      const result = await dispatchToolCall(callNamed('read_file', '{"path":"notes.txt"}'), registry)

      expect(result.isError).toBe(false)
      expect(result.output).toBe('the answer is 42')
      expect(result.toolCallId).toBe('call_read_1')
      expect(result.toolName).toBe('read_file')
    })
  })

  it('refuses a path outside the workspace and tells the model the boundary', async () => {
    await withWorkspace(async (workspace, outside) => {
      writeFileSync(join(outside, 'secret.txt'), 'not for the harness')
      const registry = createRegistry([readFileTool({ jail: openJail(workspace) })])

      const result = await dispatchToolCall(callNamed('read_file', `{"path":${JSON.stringify(join(outside, 'secret.txt'))}}`), registry)

      expect(result.isError).toBe(true)
      expect(result.output).toContain('resolves outside the workspace')
      expect(result.output).not.toContain('not for the harness')
    })
  })

  it('refuses a link that points out of the workspace', async () => {
    await withWorkspace(async (workspace, outside) => {
      writeFileSync(join(outside, 'secret.txt'), 'not for the harness')
      symlinkSync(outside, join(workspace, 'link'), linkKind())
      const registry = createRegistry([readFileTool({ jail: openJail(workspace) })])

      const result = await dispatchToolCall(callNamed('read_file', '{"path":"link/secret.txt"}'), registry)

      expect(result.isError).toBe(true)
      expect(result.output).toContain('resolves outside the workspace')
      expect(result.output).not.toContain('not for the harness')
    })
  })

  it('reports a file that is not there, and a path that is a directory', async () => {
    await withWorkspace(async (workspace) => {
      mkdirSync(join(workspace, 'sub'))
      const registry = createRegistry([readFileTool({ jail: openJail(workspace) })])

      const missing = await dispatchToolCall(callNamed('read_file', '{"path":"absent.txt"}'), registry)
      const directory = await dispatchToolCall(callNamed('read_file', '{"path":"sub"}'), registry)

      expect(missing.isError).toBe(true)
      expect(missing.output).toContain('no such file')
      // On Windows a directory cannot be opened for reading at all, so the OS refusal is what the
      // model is told. The `isFile` check inside the tool covers the systems where opening a directory
      // succeeds and reading it is the step that fails.
      expect(directory.isError).toBe(true)
      expect(directory.output).toContain('could not be opened')
    })
  })

  it('reads at most its byte budget and names the cut in the text the model sees', async () => {
    await withWorkspace(async (workspace) => {
      const head = 'the head of the file. '
      const tail = ' THE END OF THE FILE IS NOT IN WHAT YOU RECEIVED'
      const content = head + 'x'.repeat(10_000) + tail
      writeFileSync(join(workspace, 'big.txt'), content)
      const size = Buffer.byteLength(content, 'utf8')
      const tool: Tool = { ...readFileTool({ jail: openJail(workspace) }), budgets: { maxBytes: 400, deadlineMs: 2000 } }
      const registry = createRegistry([tool])

      const result = await dispatchToolCall(callNamed('read_file', '{"path":"big.txt"}'), registry)

      expect(result.isError).toBe(false)
      expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(400)
      expect(result.output).toContain('truncated')
      // The real size of the file, not a number guessed into the test.
      expect(result.output).toContain(`${size} bytes`)
      expect(result.output).toContain('budget 400')
      expect(result.output).toContain(head)
      // The tail of the file is not in there in any form: the read stopped, it was not cut afterwards.
      expect(result.output).not.toContain(tail)
    })
  })

  it('does not cut a multi-byte character in half', async () => {
    await withWorkspace(async (workspace) => {
      writeFileSync(join(workspace, 'wide.txt'), 'ü'.repeat(500)) // 500 characters, 1000 bytes
      const tool: Tool = { ...readFileTool({ jail: openJail(workspace) }), budgets: { maxBytes: 101, deadlineMs: 2000 } }
      const registry = createRegistry([tool])

      const result = await dispatchToolCall(callNamed('read_file', '{"path":"wide.txt"}'), registry)

      expect(result.isError).toBe(false)
      expect(result.output).toContain('1000 bytes')
      expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(101)
      // A cut that landed inside a 2-byte character would leave the replacement character behind.
      expect(result.output).not.toContain('\uFFFD')
      expect((result.output.match(/ü+/)?.[0]?.length ?? 0)).toBeGreaterThan(0)
    })
  })

  it('is a tool the registry accepts, with the argument schema a model is shown', () =>
    withWorkspace((workspace) => {
      const registry = createRegistry([readFileTool({ jail: openJail(workspace) })])
      const definitions = registry.definitions()

      expect(definitions.map((declared) => declared.name)).toEqual(['read_file'])
      expect(definitions[0]?.parameters.properties).toMatchObject({ path: { type: 'string' } })
      expect(definitions[0]?.parameters.additionalProperties).toBe(false)
    }))
})
