/**
 * The conversation vocabulary. Hand-written on purpose: no SDK defines these
 * shapes, so a provider change cannot silently change what our loop sees.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface Message {
  role: Role
  /**
   * null when the model requested a tool call and produced no text.
   * Providers really do send null here, not an empty string.
   */
  content: string | null
  /** On a tool message: the model's own tool_call_id that this message answers. */
  toolCallId?: string
  /** On a tool message: which tool produced the result. */
  toolName?: string
  /**
   * On an assistant message: the calls the model asked for in that turn.
   * The conversation the next provider call sees is malformed without it: the
   * model would not see its own request. `strata.ts` serialises it on the
   * outgoing request as `tool_calls`.
   */
  toolCalls?: ToolCall[]
}

export interface ToolCall {
  /** Id the model invented. A result must carry it back unchanged. */
  id: string
  name: string
  /**
   * Providers deliver arguments as a JSON string, not an object.
   * "Could not parse it" and "parsed, but the arguments are wrong" are
   * two different failures and must stay distinguishable.
   */
  arguments: string
}

export interface ToolResult {
  toolCallId: string
  toolName: string
  /** Text sent back to the model. A failure is described here too. */
  output: string
  /** A tool failure is data the model can read, not an exception the loop swallows. */
  isError: boolean
}

/**
 * Why the model stopped generating. The loop branches on this.
 * "length" means the output was cut off mid-sentence: never a success.
 */
export type StopReason = 'stop' | 'tool_calls' | 'length'

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

/** One assistant turn, as returned by a provider. */
export interface AssistantTurn {
  content: string | null
  toolCalls: ToolCall[]
  stopReason: StopReason
  /** Provider-reported counts only. Never a local estimate presented as a measurement. */
  usage: TokenUsage
}

/**
 * Why the loop stopped. Distinct from StopReason, which explains one model call:
 * this explains the run. `iteration_cap_exhausted` means the budget stopped the
 * run rather than the model, and is never reported as a completed answer.
 */
export type RunFinishReason = 'model_stop' | 'model_truncated' | 'iteration_cap_exhausted'

/**
 * What the generator yields, one event per iteration. Plain data, so a trace file
 * can record it and a UI can render it without either owning agent logic.
 *
 * Only the variants the loop can produce today are named. Truncation warnings and
 * tool-budget variants describe a tool's own failure, so they arrive with the tools
 * (PLAN.md §6, M3) instead of being declared before they exist.
 */
export interface ModelCallStartedEvent {
  type: 'model_call_started'
  /** 1-based iteration within this run. */
  iteration: number
}

export interface ModelCallFinishedEvent {
  type: 'model_call_finished'
  iteration: number
  /** `length` is reported here as what it is: a cut-off answer, never a success. */
  stopReason: StopReason
  toolCallCount: number
  usage: TokenUsage
}

export interface ToolCallRequestedEvent {
  type: 'tool_call_requested'
  iteration: number
  toolCallId: string
  toolName: string
  /** The unparsed JSON string, exactly as the provider delivered it. */
  arguments: string
}

export interface ToolResultEvent {
  type: 'tool_result'
  iteration: number
  /** Carries the model's own tool_call_id, which is how the model correlates it. */
  result: ToolResult
}

export interface RunFinishedEvent {
  type: 'run_finished'
  reason: RunFinishReason
  iterations: number
  /** Summed from provider-reported `usage` across this run's calls. */
  totalUsage: TokenUsage
}

export type HarnessEvent =
  | ModelCallStartedEvent
  | ModelCallFinishedEvent
  | ToolCallRequestedEvent
  | ToolResultEvent
  | RunFinishedEvent
