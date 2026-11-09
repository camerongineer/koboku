import { z } from 'zod'

import type { ToolDefinition } from '../provider/provider'

/**
 * The tool contract, and the only place that knows which tools this harness has.
 *
 * A tool's budgets are part of its declaration rather than an argument of each call, so a
 * caller cannot ask a tool for more than its own record permits. The four fields come from
 * PLAN.md §7. A tool that has no use for one of them leaves it absent instead of carrying a
 * number nobody checked: `maxDepth` means nothing to a file reader, and a filler value asks
 * the reader to trust it. `deadlineMs` is required because every call gets a deadline.
 */
export interface ToolBudgets {
  /** Largest number of bytes one call may return. */
  maxBytes?: number
  /** How deep a recursive walk may go. */
  maxDepth?: number
  /** How many items one call may report. */
  maxResults?: number
  /** Wall-clock limit for one call, in milliseconds. */
  deadlineMs: number
}

/**
 * What a tool's own implementation is handed. `dispatch.ts` builds it: it arms the deadline from this
 * tool's `deadlineMs` and copies the budgets from this tool's own declaration, so a tool is never
 * told to spend more than it declared.
 */
export interface ToolRunContext {
  /** Already wired to this tool's `deadlineMs` by the harness. */
  signal: AbortSignal
  /** The budgets from this tool's own declaration. A tool may read them, never raise them. */
  budgets: ToolBudgets
}

/** What a tool hands back. A failure is described in `output` too, because text is the only thing the model can read. */
export interface ToolOutcome {
  output: string
  isError: boolean
}

/** One tool: its name, the arguments it accepts, what it may spend, and the code that runs. */
export interface Tool {
  name: string
  description: string
  /**
   * An object schema, which doubles as the `parameters` payload the model sees
   * (AGENTS.md §3.6). An object is required because function calling asks for named arguments,
   * and the registry stores a strict version of it: a parameter nobody declared is refused
   * rather than dropped. See `createRegistry` for why that was measured rather than assumed.
   */
  arguments: z.ZodType
  budgets: ToolBudgets
  /** `args` is the arguments after validation. Validating them is dispatch's job, not this file's. */
  execute(args: unknown, context: ToolRunContext): Promise<ToolOutcome>
}

/**
 * A closed set of characters, checked before a name is ever stored or sent to a provider. The
 * precedent is the trace writer's run-id guard: resolve the name first, refuse what does not
 * fit, and never let a name be a place something can be written.
 */
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

const declarationSchema = z.object({
  name: z.string().regex(TOOL_NAME_PATTERN),
  description: z.string().trim().min(1),
  budgets: z.object({
    maxBytes: z.number().int().positive().optional(),
    maxDepth: z.number().int().positive().optional(),
    maxResults: z.number().int().positive().optional(),
    deadlineMs: z.number().int().positive(),
  }),
})

/** What a run's caller can ask of the tools. Lookup answers in data, never by throwing. */
export interface ToolRegistry {
  /** Descriptors for a provider call, in declaration order, computed once at construction. */
  definitions(): ToolDefinition[]
  /** `undefined` for a name nobody declared — an invented tool name is a failure the model is told about, not an exception. */
  lookup(name: string): Tool | undefined
  size: number
}

/**
 * Build the registry from tool declarations.
 *
 * A bad declaration is refused here, at startup, rather than discovered mid-run: a duplicate
 * name, an empty description, a non-integer budget and a non-object argument schema are all
 * mistakes made by whoever wrote the tool, and none of them are something the model can be
 * asked to work around. An empty registry is valid — that is what a harness with no tools has.
 */
export function createRegistry(tools: readonly Tool[]): ToolRegistry {
  const byName = new Map<string, Tool>()

  for (const tool of tools) {
    const parsed = declarationSchema.safeParse({
      name: tool.name,
      description: tool.description,
      budgets: tool.budgets,
    })
    if (!parsed.success) {
      const problems = parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')
      throw new Error(`registry: tool "${tool.name}" is not a valid declaration (${problems})`)
    }
    if (!(tool.arguments instanceof z.ZodObject)) {
      throw new Error(`registry: tool "${tool.name}" must declare arguments as an object schema`)
    }
    if (byName.has(tool.name)) {
      throw new Error(`registry: tool name "${tool.name}" is declared twice`)
    }
    // Unknown parameters are refused, not dropped. Measured 2026-11-08 with node v24.12.0 and
    // the installed zod: parsing `{ path, extra }` against a plain `z.object({ path })` succeeds
    // and silently drops `extra`, while `z.toJSONSchema` on that same schema publishes
    // `additionalProperties: false`. The wire already tells a model that extra keys are not
    // accepted, and a quantised model invents parameter names (PLAN.md §6, M3), so the stored
    // schema is the strict version: the promise and the parse agree.
    const argumentsSchema = tool.arguments.strict()

    // The validated values are what the registry keeps, so a tool is described to the model
    // exactly as the registry checked it: a trimmed description, budgets as parsed, strict
    // arguments.
    byName.set(parsed.data.name, {
      ...tool,
      name: parsed.data.name,
      description: parsed.data.description,
      arguments: argumentsSchema,
      budgets: parsed.data.budgets,
    })
  }

  // Built once, so a schema that cannot be serialised fails at startup rather than inside a run.
  const definitions = [...byName.values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.arguments),
  }))

  return {
    definitions: () => definitions,
    lookup: (name) => byName.get(name),
    size: byName.size,
  }
}
