import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { dispatchToolCall } from '../src/harness/dispatch'
import { openJail } from '../src/harness/jail'
import { createRegistry, type Tool } from '../src/harness/tools/registry'
import { writeFileTool } from '../src/harness/tools/write-file'
import type { ToolCall } from '../src/harness/types'

/**
 * M4, first step: the tool that writes. Like the reader's tests, every file it touches is created in a
 * temporary directory inside the test and deleted afterwards, so nothing is written into the repository's
 * own `workspace/`. No model server, no network, no clock.
 *
 * The three escape routes PLAN.md §6 names for this milestone — `..`, an absolute path, a link — are each
 * asserted twice: once as a refusal the model can read, and once as the absence of a file where the
 * refusal should have left none.
 */

/** Windows needs a junction, which needs no elevated privileges; elsewhere a directory link. */
function linkKind(): 'junction' | 'dir' {
  return process.platform === 'win32' ? 'junction' : 'dir'
}

/**
 * Waits for the run before removing the directories. A helper that returns the promise its callback
 * produced would run `rmSync` while that callback is still suspended at its first `await`, which deletes
 * the workspace out from under the assertions that come after it.
 */
async function withWorkspace<R>(run: (workspace: string, outside: string) => Promise<R> | R): Promise<R> {
  const workspace = mkdtempSync(join(tmpdir(), 'koboku-work-'))
  const outside = mkdtempSync(join(tmpdir(), 'koboku-out-'))
  try {
    return await run(workspace, outside)
  } finally {
    rmSync(outside, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
}

/** The arguments string exactly as the wire would carry it. */
function writeCall(argumentsObject: { path: string; content: string }, id = 'call_write_1'): ToolCall {
  return { id, name: 'write_file', arguments: JSON.stringify(argumentsObject) }
}

function registryOver(workspace: string, tool?: Tool) {
  return createRegistry([tool ?? writeFileTool({ jail: openJail(workspace) })])
}

describe('write_file', () => {
  it('writes a real file through dispatch, from the arguments string a provider sends', async () => {
    await withWorkspace(async (workspace) => {
      const registry = registryOver(workspace)

      const result = await dispatchToolCall(writeCall({ path: 'notes.txt', content: 'the answer is 42' }), registry)

      expect(result.isError).toBe(false)
      expect(result.toolCallId).toBe('call_write_1')
      expect(result.toolName).toBe('write_file')
      expect(result.output).toContain('16 bytes')
      // The bytes are on disk, not merely claimed: read the file back and compare.
      expect(readFileSync(join(workspace, 'notes.txt'), 'utf8')).toBe('the answer is 42')
    })
  })

  it('refuses a path that walks out with .. and leaves nothing outside', async () => {
    await withWorkspace(async (workspace) => {
      const registry = registryOver(workspace)

      const result = await dispatchToolCall(writeCall({ path: '../escape.txt', content: 'outside' }), registry)

      expect(result.isError).toBe(true)
      expect(result.output).toContain('resolves outside the workspace')
      expect(existsSync(join(dirname(workspace), 'escape.txt'))).toBe(false)
    })
  })

  it('refuses an absolute path outside the workspace and leaves nothing there', async () => {
    await withWorkspace(async (workspace, outside) => {
      const registry = registryOver(workspace)

      const result = await dispatchToolCall(
        writeCall({ path: join(outside, 'secret.txt'), content: 'not for the harness' }),
        registry,
      )

      expect(result.isError).toBe(true)
      expect(result.output).toContain('resolves outside the workspace')
      expect(existsSync(join(outside, 'secret.txt'))).toBe(false)
    })
  })

  it('refuses a link that points out of the workspace and writes nothing through it', async () => {
    await withWorkspace(async (workspace, outside) => {
      symlinkSync(outside, join(workspace, 'link'), linkKind())
      const registry = registryOver(workspace)

      const result = await dispatchToolCall(writeCall({ path: 'link/new.txt', content: 'through the link' }), registry)

      expect(result.isError).toBe(true)
      expect(result.output).toContain('resolves outside the workspace')
      expect(existsSync(join(outside, 'new.txt'))).toBe(false)
    })
  })

  it('refuses to overwrite a file that is already there, and leaves the original bytes alone', async () => {
    await withWorkspace(async (workspace) => {
      writeFileSync(join(workspace, 'notes.txt'), 'the original content')
      const registry = registryOver(workspace)

      const result = await dispatchToolCall(writeCall({ path: 'notes.txt', content: 'replacement' }), registry)

      expect(result.isError).toBe(true)
      expect(result.output).toContain('already exists')
      expect(result.output).toContain('overwrites')
      expect(readFileSync(join(workspace, 'notes.txt'), 'utf8')).toBe('the original content')
    })
  })

  it('refuses a path whose directory is not there, and creates no directory', async () => {
    await withWorkspace(async (workspace) => {
      const registry = registryOver(workspace)

      const result = await dispatchToolCall(writeCall({ path: 'missing/dir/file.txt', content: 'nested' }), registry)

      expect(result.isError).toBe(true)
      expect(result.output).toContain('does not create directories')
      expect(existsSync(join(workspace, 'missing'))).toBe(false)
    })
  })

  it('refuses content over its byte budget before writing any of it', async () => {
    await withWorkspace(async (workspace) => {
      // 300 characters, 600 bytes: the budget counts bytes, and the refusal quotes the byte count the
      // model would have written, not the number of characters it sent.
      const content = 'ü'.repeat(300)
      const tool: Tool = { ...writeFileTool({ jail: openJail(workspace) }), budgets: { maxBytes: 400, deadlineMs: 2000 } }
      const registry = registryOver(workspace, tool)

      const result = await dispatchToolCall(writeCall({ path: 'big.txt', content }), registry)

      expect(result.isError).toBe(true)
      expect(result.output).toContain('600 bytes')
      expect(result.output).toContain('budget 400')
      expect(existsSync(join(workspace, 'big.txt'))).toBe(false)
    })
  })

  it('refuses a path that is a directory, and refuses a name that is not a path', async () => {
    await withWorkspace(async (workspace) => {
      mkdirSync(join(workspace, 'sub'))
      const registry = registryOver(workspace)

      const directory = await dispatchToolCall(writeCall({ path: 'sub', content: 'not a file' }), registry)
      const emptyPath = await dispatchToolCall(
        { id: 'call_write_2', name: 'write_file', arguments: '{"path":"","content":"x"}' },
        registry,
      )

      expect(directory.isError).toBe(true)
      expect(directory.output).toContain('is a directory')
      expect(existsSync(join(workspace, 'sub', 'x'))).toBe(false)

      // An empty `path` is refused by the strict schema before the tool ever runs.
      expect(emptyPath.isError).toBe(true)
      expect(emptyPath.output).toContain('It accepts exactly')
    })
  })

  it('is a tool the registry accepts, with the two parameters a model is shown', () =>
    withWorkspace((workspace) => {
      const definitions = registryOver(workspace).definitions()

      expect(definitions.map((declared) => declared.name)).toEqual(['write_file'])
      expect(definitions[0]?.parameters.properties).toMatchObject({
        path: { type: 'string' },
        content: { type: 'string' },
      })
      expect(definitions[0]?.parameters.additionalProperties).toBe(false)
    }))
})
