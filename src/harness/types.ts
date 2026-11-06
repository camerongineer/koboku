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
