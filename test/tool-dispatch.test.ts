import { describe, expect, it } from 'vitest'

import { z } from 'zod'

import { dispatchToolCall } from '../src/harness/dispatch'
import { createRegistry, type Tool, type ToolBudgets } from '../src/harness/tools/registry'
import type { ToolCall } from '../src/harness/types'

/**
 * M3, step two: dispatch — the one path from a model asking for a tool call to the model reading
 * an answer. Every failure here is asserted as a `ToolResult` the model can read, because the loop
 * carries on and the model has to be able to change what it asks for.
 *
 * Nothing in this file touches a filesystem, a model server, a network or a clock. The deadline test
 * supplies a signal that is already aborted, so the deadline fires without any timer running
 * (AGENTS.md §5).
 */

interface Execution {
  args: unknown
  budgets: ToolBudgets
}

function callOver(name: string, argumentsText: string): ToolCall {
  return { id: 'call_model_invented_1', name, arguments: argumentsText }
}

function testTool(execute: Tool['execute'], overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'read_file',
    description: 'Stand-in tool. Reads nothing: there is no filesystem in this test.',
    arguments: z.object({ path: z.string().min(1) }),
    budgets: { maxBytes: 500, deadlineMs: 2000 },
    execute,
    ...overrides,
  }
}

/** A tool that records what it was handed, so "it was not executed" is evidence rather than inference. */
function recordingTool(output = 'the file contents') {
  const executions: Execution[] = []
  const tool = testTool(async (args, context) => {
    executions.push({ args, budgets: context.budgets })
    return { output, isError: false }
  })
  return { tool, executions }
}

describe('tool dispatch', () => {
  it('runs a call the model asked for, with the arguments already parsed and validated', async () => {
    const { tool, executions } = recordingTool('the file contents')
    const registry = createRegistry([tool])

    const result = await dispatchToolCall(callOver('read_file', '{"path":"notes.md"}'), registry)

    expect(result.isError).toBe(false)
    expect(result.output).toBe('the file contents')
    // The model's own id, carried back unchanged: this is how it matches a result to a request.
    expect(result.toolCallId).toBe('call_model_invented_1')
    expect(result.toolName).toBe('read_file')
    expect(executions[0]?.args).toEqual({ path: 'notes.md' })
  })

  it('hands the tool its own budgets, so a cap is something the tool can honour', async () => {
    const { tool, executions } = recordingTool()
    const registry = createRegistry([testTool(tool.execute, { budgets: { maxBytes: 128, maxResults: 10, deadlineMs: 750 } })])

    await dispatchToolCall(callOver('read_file', '{"path":"notes.md"}'), registry)

    expect(executions[0]?.budgets).toEqual({ maxBytes: 128, maxResults: 10, deadlineMs: 750 })
  })

  it('refuses a name nobody declared, and names the tools that do exist', async () => {
    const { tool, executions } = recordingTool()
    const registry = createRegistry([tool])

    const result = await dispatchToolCall(callOver('readFile', '{"path":"notes.md"}'), registry)

    expect(result.isError).toBe(true)
    expect(result.output).toContain('does not exist in this harness')
    expect(result.output).toContain('tools that do exist: read_file')
    expect(result.toolCallId).toBe('call_model_invented_1')
    expect(executions).toHaveLength(0)
  })

  it('says plainly that nothing is wired up when the registry is empty', async () => {
    const result = await dispatchToolCall(callOver('read_file', '{"path":"notes.md"}'), createRegistry([]))

    expect(result.output).toContain('no tool is wired up in this harness yet')
  })

  it('keeps "I could not read it" separate from "that is not what it takes"', async () => {
    const { tool, executions } = recordingTool()
    const registry = createRegistry([tool])

    // Three ways the arguments can be wrong, and only one of them is a JSON failure.
    const unparseable = await dispatchToolCall(callOver('read_file', '{"path": '), registry)
    const emptyString = await dispatchToolCall(callOver('read_file', ''), registry)
    const wrongType = await dispatchToolCall(callOver('read_file', '{"path":7}'), registry)

    expect(unparseable.isError).toBe(true)
    expect(unparseable.output).toContain('not parseable as JSON')
    expect(emptyString.output).toContain('not parseable as JSON')
    expect(wrongType.isError).toBe(true)
    expect(wrongType.output).toContain('not what it accepts')
    expect(wrongType.output).toContain('It accepts exactly: path')
    expect(executions).toHaveLength(0)
  })

  it('refuses an invented parameter rather than running with it quietly dropped', async () => {
    const { tool, executions } = recordingTool()
    const registry = createRegistry([tool])

    const result = await dispatchToolCall(callOver('read_file', '{"path":"notes.md","maxBytes":12}'), registry)

    expect(result.isError).toBe(true)
    expect(result.output).toContain('Unrecognized key')
    expect(result.output).toContain('It accepts exactly: path')
    expect(executions).toHaveLength(0)
  })

  it('turns a tool that raises into a result the model can read', async () => {
    const tool = testTool(async () => {
      throw new Error('the stand-in tool was asked to fail')
    })
    const registry = createRegistry([tool])

    const result = await dispatchToolCall(callOver('read_file', '{"path":"notes.md"}'), registry)

    expect(result.isError).toBe(true)
    expect(result.output).toContain('the stand-in tool was asked to fail')
    expect(result.toolCallId).toBe('call_model_invented_1')
  })

  it('reports a call that outlives its own deadline, with no clock involved', async () => {
    const neverFinishes = testTool(() => new Promise<never>(() => {}))
    const registry = createRegistry([neverFinishes])

    const armedWith: number[] = []
    let cleared = 0

    const result = await dispatchToolCall(callOver('read_file', '{"path":"notes.md"}'), registry, {
      // A signal that is already aborted: the deadline has passed before anything was asked to run.
      armDeadline: (milliseconds) => {
        armedWith.push(milliseconds)
        return { signal: AbortSignal.abort(), clear: () => (cleared += 1) }
      },
    })

    expect(result.isError).toBe(true)
    // The number in the report is the number the tool declared, not one the harness invented.
    expect(result.output).toContain('2000 ms deadline')
    expect(armedWith).toEqual([2000])
    expect(cleared).toBe(1)
  })

  it('caps the output at the declared byte budget and says that it did', async () => {
    const wide = 'ü'.repeat(100) // 100 characters, 200 bytes in UTF-8
    const tool = testTool(async () => ({ output: wide, isError: false }), { budgets: { maxBytes: 50, deadlineMs: 2000 } })
    const registry = createRegistry([tool])

    const result = await dispatchToolCall(callOver('read_file', '{"path":"notes.md"}'), registry)

    expect(result.isError).toBe(false)
    expect(result.output).toContain('output truncated')
    expect(result.output).toContain('returned 200 bytes')
    expect(result.output).toContain('budget is 50 bytes')
    // 25 of them is 50 bytes: the cap lands between characters, never inside one. The 26th is
    // gone, so it is the tool's own text that the budget bounded.
    expect(result.output.startsWith('ü'.repeat(25))).toBe(true)
    expect(result.output).not.toContain('ü'.repeat(26))
    expect(result.output).not.toContain('\uFFFD')
  })

  it('leaves the output alone when no byte budget is declared', async () => {
    const long = 'x'.repeat(5000)
    const tool = testTool(async () => ({ output: long, isError: false }), { budgets: { deadlineMs: 2000 } })
    const registry = createRegistry([tool])

    const result = await dispatchToolCall(callOver('read_file', '{"path":"notes.md"}'), registry)

    expect(result.output).toBe(long)
    expect(result.output).not.toContain('truncated')
  })
})
