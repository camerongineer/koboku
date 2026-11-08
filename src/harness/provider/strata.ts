import { z } from 'zod'
import type { AssistantTurn, Message, StopReason, ToolCall } from '../types'
import type { GenerateRequest, Provider } from './provider'

/**
 * The real adapter: hand-written OpenAI-compatible request and response shapes.
 * No LLM SDK. The zod schemas exist so a server that answers with something
 * unexpected fails here, loudly, instead of failing later inside the loop.
 */

export interface StrataConfig {
  baseUrl: string
  apiKey: string
}

const toolCallSchema = z.object({
  id: z.string().min(1),
  function: z.object({
    name: z.string().min(1),
    /** Still a JSON string on the wire. Parsed later, by dispatch, not here. */
    arguments: z.string(),
  }),
})

const choiceSchema = z.object({
  finish_reason: z.string(),
  message: z.object({
    content: z.string().nullable(),
    tool_calls: z.array(toolCallSchema).optional(),
  }),
})

const completionSchema = z.object({
  choices: z.array(choiceSchema).min(1),
  usage: z
    .object({
      prompt_tokens: z.number().default(0),
      completion_tokens: z.number().default(0),
    })
    .optional(),
})

/**
 * Only the three reasons PLAN.md commits to are accepted. Anything else the
 * server reports is an error naming the value, never a silent success.
 */
function toStopReason(raw: string): StopReason {
  if (raw === 'stop' || raw === 'tool_calls' || raw === 'length') {
    return raw
  }
  throw new Error(`strata: unhandled finish_reason "${raw}"`)
}

/**
 * The wire shape of a requested call: the id the model invented, the kind, and a
 * function block whose `arguments` stays the string it arrived as. Mirrors
 * `toolCallSchema` above, which reads the same shape back in the response.
 */
function toWireToolCall(call: ToolCall): Record<string, unknown> {
  return {
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: call.arguments },
  }
}

/**
 * Exported so the wire shape can be asserted with no server and no network: this
 * is the one place the conversation is translated into another format, and the
 * translation is where a round-trip silently breaks.
 */
export function toWireMessage(message: Message): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
    // Omitted entirely when absent: an assistant turn with no calls carries no tool_calls key.
    ...(message.toolCalls === undefined || message.toolCalls.length === 0
      ? {}
      : { tool_calls: message.toolCalls.map(toWireToolCall) }),
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
}

export function strataProvider(config: StrataConfig): Provider {
  return {
    async generate(request: GenerateRequest): Promise<AssistantTurn> {
      const body = {
        model: request.model,
        messages: request.messages.map(toWireMessage),
        temperature: request.temperature,
        max_tokens: request.maxOutputTokens,
        stream: false,
        ...(request.tools.length === 0
          ? {}
          : {
              tools: request.tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
            }),
      }

      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: request.signal,
      })

      if (!response.ok) {
        // The key travels in a header, so it cannot appear in the body we echo.
        const detail = (await response.text()).slice(0, 300)
        throw new Error(`strata: HTTP ${response.status} ${response.statusText} ${detail}`)
      }

      const parsed = completionSchema.safeParse(await response.json())
      if (!parsed.success) {
        throw new Error(`strata: unexpected response shape (${describeIssues(parsed.error)})`)
      }

      const choice = parsed.data.choices[0]
      if (choice === undefined) {
        throw new Error('strata: response carried no choice')
      }

      const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      }))

      return {
        content: choice.message.content,
        toolCalls,
        stopReason: toStopReason(choice.finish_reason),
        usage: {
          inputTokens: parsed.data.usage?.prompt_tokens ?? 0,
          outputTokens: parsed.data.usage?.completion_tokens ?? 0,
        },
      }
    },
  }
}
