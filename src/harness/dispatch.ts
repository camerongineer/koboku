import { Buffer } from 'node:buffer'

import { z } from 'zod'

import type { Tool, ToolRegistry, ToolOutcome, ToolRunContext } from './tools/registry'
import type { ToolCall, ToolResult } from './types'

/**
 * What happens between the model asking for a tool call and the model reading an answer.
 *
 * One path, five failure modes, and every one of them ends as a `ToolResult` the model can read
 * (AGENTS.md §3.8): the name does not exist; the arguments are not JSON; the arguments are JSON
 * but not what the tool accepts; the tool itself raised; the tool hung past its deadline or
 * returned more than its budget allows. None of them is an exception, because an exception reaches
 * the harness and not the model, and a model that cannot see a failure cannot change what it asks
 * for next.
 */

/** An armed deadline. `clear` releases the timer once the call is over. */
export interface Deadline {
  signal: AbortSignal
  clear: () => void
}

export interface DispatchOptions {
  /**
   * Overrides how a deadline is armed. A test supplies a signal that is already aborted, which
   * proves a deadline with no clock running (AGENTS.md §5: no test may depend on wall-clock time).
   */
  armDeadline?: (milliseconds: number) => Deadline
}

function armTimer(milliseconds: number): Deadline {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`deadline of ${milliseconds} ms elapsed`)), milliseconds)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

/**
 * A name nobody declared, answered in data. This is the branch the loop has carried since M1, and
 * it stays in data now that tools exist. The difference is that the model is told which tools do
 * exist, which is what lets it correct an invented name instead of repeating it.
 */
function unknownToolResult(call: ToolCall, registry: ToolRegistry): ToolResult {
  const available = registry.definitions().map((tool) => tool.name)
  const availableText =
    available.length === 0
      ? 'no tool is wired up in this harness yet'
      : `tools that do exist: ${available.join(', ')}`

  return {
    toolCallId: call.id,
    toolName: call.name,
    output:
      `tool "${call.name}" does not exist in this harness (${availableText}), ` +
      'so the request was not executed.',
    isError: true,
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Cuts text at a byte limit without splitting a character, by walking whole code points. A byte
 * slice would land in the middle of a multi-byte character and hand the model a replacement
 * character where a clean end should be.
 */
function capByBytes(text: string, maxBytes: number): string {
  let bytes = 0
  let characters = 0

  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > maxBytes) break
    bytes += characterBytes
    characters += character.length
  }

  return text.slice(0, characters)
}

/**
 * The byte budget applied to what a tool returned, with the cut stated out loud. Truncation that
 * is not named is the dangerous kind: a model given clipped text will describe content it never
 * received (PLAN.md §7).
 *
 * The budget bounds the tool's own text. The sentence reporting the cut is the harness's and sits
 * on top of the capped text, not inside its budget.
 */
function withinByteBudget(call: ToolCall, tool: Tool, outcome: ToolOutcome): ToolResult {
  const maxBytes = tool.budgets.maxBytes
  const bytes = Buffer.byteLength(outcome.output, 'utf8')

  if (maxBytes === undefined || bytes <= maxBytes) {
    return { toolCallId: call.id, toolName: call.name, output: outcome.output, isError: outcome.isError }
  }

  const kept = capByBytes(outcome.output, maxBytes)
  const keptBytes = Buffer.byteLength(kept, 'utf8')
  const notice =
    `\n\n[output truncated: "${call.name}" returned ${bytes} bytes and its budget is ${maxBytes} bytes. ` +
    `You are seeing the first ${keptBytes} bytes; the rest was never sent to you, so nothing beyond ` +
    'this point is known to you.]'

  return { toolCallId: call.id, toolName: call.name, output: kept + notice, isError: outcome.isError }
}

/** The tool raced its own deadline. Whichever finishes first decides what the model is told. */
async function runWithinDeadline(
  tool: Tool,
  args: unknown,
  context: ToolRunContext,
): Promise<ToolOutcome | 'deadline'> {
  const stopped: Promise<'deadline'> = new Promise((resolve) => {
    if (context.signal.aborted) {
      resolve('deadline')
      return
    }
    context.signal.addEventListener('abort', () => resolve('deadline'), { once: true })
  })

  return Promise.race([tool.execute(args, { signal: context.signal, budgets: context.budgets }), stopped])
}

/**
 * Run one tool call the model asked for.
 *
 * `call.arguments` is the JSON string exactly as the provider delivered it. Parsing it and
 * validating it are kept as separate failures on purpose: "I could not read what you wrote" and
 * "what you wrote is not what this tool accepts" send the model different corrections. Validation
 * is strict, because the registry stores a strict schema and the wire has already told the model
 * that extra properties are not accepted.
 */
export async function dispatchToolCall(
  call: ToolCall,
  registry: ToolRegistry,
  options: DispatchOptions = {},
): Promise<ToolResult> {
  const failure = (output: string): ToolResult => ({
    toolCallId: call.id,
    toolName: call.name,
    output,
    isError: true,
  })

  const tool = registry.lookup(call.name)
  if (tool === undefined) return unknownToolResult(call, registry)

  let written: unknown
  try {
    written = JSON.parse(call.arguments)
  } catch (error) {
    return failure(
      `the arguments for "${call.name}" are not parseable as JSON (${messageOf(error)}). ` +
        'The tool was not executed. Send the arguments as one JSON object.',
    )
  }

  const argumentsParsed = tool.arguments.safeParse(written)
  if (!argumentsParsed.success) {
    const problems = argumentsParsed.error.issues
      .map((issue) => `${issue.path.length === 0 ? '(top level)' : issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    // Read back the same schema the model was shown, so the correction names the parameters it
    // was already told about rather than a second list that could drift from the first.
    const schema = z.toJSONSchema(tool.arguments)
    const accepted = Object.keys((schema.properties ?? {}) as Record<string, unknown>)

    return failure(
      `the arguments for "${call.name}" are not what it accepts (${problems}). ` +
        `It accepts exactly: ${accepted.length === 0 ? 'no parameters' : accepted.join(', ')}. ` +
        'The tool was not executed.',
    )
  }

  const milliseconds = tool.budgets.deadlineMs
  const deadline = (options.armDeadline ?? armTimer)(milliseconds)

  try {
    const outcome = await runWithinDeadline(tool, argumentsParsed.data, {
      signal: deadline.signal,
      budgets: tool.budgets,
    })

    if (outcome === 'deadline') {
      return failure(
        `the call to "${call.name}" did not finish within its ${milliseconds} ms deadline. ` +
          'The harness stopped waiting and is telling you that; the tool itself may still be running.',
      )
    }

    return withinByteBudget(call, tool, outcome)
  } catch (error) {
    return failure(`tool "${call.name}" raised an error: ${messageOf(error)}. It was not handled as a result.`)
  } finally {
    deadline.clear()
  }
}
