import type { AssistantTurn, Message } from '../types'

/** A tool the model is allowed to ask for. */
export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema for the arguments, produced by z.toJSONSchema(). */
  parameters: Record<string, unknown>
}

export interface GenerateRequest {
  model: string
  /** The conversation so far. The provider does not remember anything between calls. */
  messages: Message[]
  tools: ToolDefinition[]
  temperature: number
  maxOutputTokens: number
  signal?: AbortSignal
}

/**
 * The seam everything above depends on. Real and fake providers satisfy this
 * one interface, which is what lets every test run with no model server.
 */
export interface Provider {
  generate(request: GenerateRequest): Promise<AssistantTurn>
}
