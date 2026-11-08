import type { Provider } from './provider/provider'
import type { TraceWriter } from './trace'
import type {
  HarnessEvent,
  Message,
  RunFinishReason,
  TokenUsage,
  ToolCall,
  ToolResult,
} from './types'

/**
 * The agent loop: assemble the conversation, call the provider, read the stop
 * reason, answer any tool call the model asked for, repeat until the model stops
 * or the iteration budget runs out.
 *
 * It is an async generator that yields one `HarnessEvent` per iteration as it
 * happens, consumed with `for await`. Nothing here waits for the whole run to
 * finish, which is what makes live streaming available later without a second
 * code path (PLAN.md §2).
 *
 * Framework-free by rule: everything this file imports is a type — the Provider seam,
 * the conversation vocabulary and the trace sink interface — so the loop carries no
 * runtime dependency on a model adapter or on the filesystem. It is not a browser
 * module and never a route module.
 */

/** PLAN.md §10 standing default: max iterations per run. */
export const DEFAULT_MAX_ITERATIONS = 8

export interface RunOptions {
  provider: Provider
  /** Passed straight to the provider: which model this run is talking to. */
  model: string
  /**
   * The conversation, owned by the caller. The loop appends to this array in
   * place — assistant turns, then a tool message per requested call — and never
   * rewrites an entry that is already there. The caller keeps the list: session
   * state lives at the bridge, not inside the loop.
   */
  messages: Message[]
  /**
   * Deliberately required rather than defaulted here. config.ts owns the standing
   * values; a second copy of them in the loop could drift away from the config.
   */
  temperature: number
  maxOutputTokens: number
  /** Iteration budget for this run. Falls back to the standing default of 8. */
  maxIterations?: number
  /**
   * Optional sink for the events this run produces: the caller opens the trace,
   * because the caller owns which run this is, and the loop fills it. Every event is
   * written as it is produced, so a caller that stops consuming early still leaves
   * behind a record of everything that had already happened. A sink that cannot write
   * ends the run rather than letting it continue unrecorded.
   */
  trace?: TraceWriter
}

/**
 * Interim branch, M1. No tool exists yet, so every name the model asks for is
 * unknown, and an unknown name is answered **in data**: a ToolResult with
 * `isError` true, the model's own `tool_call_id` and tool name, and a sentence
 * saying why nothing ran. The loop then continues, so the model can change
 * strategy — a failure the model can read is not a crash (PLAN.md §2).
 *
 * This is the whole of what `dispatch.ts` takes over at M3: real execution,
 * argument validation and budgets, with the same unknown-name answer. No registry
 * is built here to anticipate it.
 */
function unknownToolResult(call: ToolCall): ToolResult {
  return {
    toolCallId: call.id,
    toolName: call.name,
    output: `tool "${call.name}" does not exist in this harness: no tool is wired up yet, `
      + 'so the request was not executed.',
    isError: true,
  }
}

/** One assistant turn, appended exactly as the model produced it. */
function assistantMessage(turn: { content: string | null; toolCalls: ToolCall[] }): Message {
  return {
    role: 'assistant',
    content: turn.content,
    // Omitted rather than an empty array: a turn with no calls carries no calls.
    ...(turn.toolCalls.length === 0 ? {} : { toolCalls: turn.toolCalls }),
  }
}

export async function* runAgent(options: RunOptions): AsyncGenerator<HarnessEvent, void, undefined> {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new RangeError(`loop: maxIterations must be a positive integer (got ${maxIterations})`)
  }

  const messages = options.messages
  const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  let reason: RunFinishReason | undefined
  let iterations = 0

  /**
   * Record the event, then hand it on. Writing before yielding is what makes the
   * trace independent of how the run is consumed: an event that is produced is in the
   * record even if the reader throws it away.
   */
  const emit = (event: HarnessEvent): HarnessEvent => {
    options.trace?.write(event)
    return event
  }

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    iterations = iteration
    yield emit({ type: 'model_call_started', iteration })

    // A snapshot, so a provider cannot reshape the conversation it was handed.
    const turn = await options.provider.generate({
      model: options.model,
      messages: [...messages],
      // M1 sends no tool list: nothing can run one. M3 fills this from the registry.
      tools: [],
      temperature: options.temperature,
      maxOutputTokens: options.maxOutputTokens,
    })

    // Counts are the provider's own reported numbers, never a local estimate.
    totalUsage.inputTokens += turn.usage.inputTokens
    totalUsage.outputTokens += turn.usage.outputTokens

    yield emit({
      type: 'model_call_finished',
      iteration,
      stopReason: turn.stopReason,
      toolCallCount: turn.toolCalls.length,
      usage: turn.usage,
    })

    messages.push(assistantMessage(turn))

    for (const call of turn.toolCalls) {
      yield emit({
        type: 'tool_call_requested',
        iteration,
        toolCallId: call.id,
        toolName: call.name,
        arguments: call.arguments,
      })

      const result = unknownToolResult(call)
      messages.push({
        role: 'tool',
        content: result.output,
        toolCallId: result.toolCallId,
        toolName: result.toolName,
      })
      yield emit({ type: 'tool_result', iteration, result })
    }

    if (turn.stopReason === 'length') {
      // A cut-off completion is never treated as success, and no further round is
      // attempted: arguments of a call cut off mid-write may themselves be partial.
      reason = 'model_truncated'
      break
    }

    if (turn.stopReason === 'stop') {
      reason = 'model_stop'
      break
    }
    // 'tool_calls': the results it expects are now in the message list, so loop again.
  }

  yield emit({
    type: 'run_finished',
    reason: reason ?? 'iteration_cap_exhausted',
    iterations,
    totalUsage,
  })
}
