import { describe, expect, it } from 'vitest'

import { z } from 'zod'

import { createRegistry, type Tool } from '../src/harness/tools/registry'

/**
 * M3, step one: the registry — the place that says which tools exist, what each accepts, and
 * what each may spend. No tool runs here: `dispatch.ts` does not exist yet, so `execute` is
 * never called by this harness. The stand-in implementation below exists only because a tool
 * declaration is incomplete without one.
 *
 * The invented-name tests reproduce what a quantised model actually sends: a name close to the
 * real one rather than the real one (PLAN.md §6, M3 exit test). At this layer an unknown name
 * must come back as `undefined`, because the loop already answers unknown names in data.
 */

/** Typed as the tool's own `execute`, so the shape a tool must satisfy is checked by the compiler. */
const neverRuns: Tool['execute'] = async () => {
  throw new Error('the registry does not execute tools; dispatch.ts does not exist yet')
}

function declaredTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'read_file',
    description: 'Read a file inside the workspace.',
    arguments: z.object({ path: z.string().min(1) }),
    budgets: { maxBytes: 4096, deadlineMs: 2000 },
    execute: neverRuns,
    ...overrides,
  }
}

describe('tool registry', () => {
  it('finds a declared tool by its exact name, with its own budgets', () => {
    const registry = createRegistry([declaredTool()])

    const found = registry.lookup('read_file')
    expect(found?.name).toBe('read_file')
    expect(found?.budgets).toEqual({ maxBytes: 4096, deadlineMs: 2000 })
    expect(registry.size).toBe(1)
  })

  it('answers an invented name with undefined rather than a throw', () => {
    const registry = createRegistry([declaredTool()])

    // Near misses a quantised model produces, plus one name that never existed here.
    for (const invented of ['readFile', 'Read_File', 'read_file_now', 'open_file', 'read']) {
      expect(() => registry.lookup(invented)).not.toThrow()
      expect(registry.lookup(invented)).toBeUndefined()
    }
  })

  it('carries each tool budgets of its own, not a shared default', () => {
    const registry = createRegistry([
      declaredTool(),
      declaredTool({ name: 'list_dir', budgets: { maxResults: 50, maxDepth: 3, deadlineMs: 500 } }),
    ])

    expect(registry.lookup('read_file')?.budgets.deadlineMs).toBe(2000)
    expect(registry.lookup('list_dir')?.budgets).toEqual({ maxResults: 50, maxDepth: 3, deadlineMs: 500 })
  })

  it('produces the descriptors a provider call takes, in declaration order', () => {
    const registry = createRegistry([
      declaredTool(),
      declaredTool({
        name: 'list_dir',
        description: 'List one directory inside the workspace.',
        arguments: z.object({ path: z.string().min(1), depth: z.number().int().min(0) }),
      }),
    ])

    const definitions = registry.definitions()
    expect(definitions.map((tool) => tool.name)).toEqual(['read_file', 'list_dir'])
    expect(definitions[1]?.parameters.properties).toMatchObject({
      path: { type: 'string' },
      depth: { type: 'integer' },
    })
    expect(definitions[1]?.parameters.required).toEqual(['path', 'depth'])
  })

  it('builds the descriptors once, so a schema that cannot be serialised fails at startup', () => {
    const registry = createRegistry([declaredTool()])
    expect(registry.definitions()).toBe(registry.definitions())
  })

  it('accepts an empty registry, which is what a harness with no tools has', () => {
    const registry = createRegistry([])
    expect(registry.size).toBe(0)
    expect(registry.definitions()).toEqual([])
    expect(registry.lookup('read_file')).toBeUndefined()
  })

  it('keeps the validated description rather than the raw one', () => {
    const registry = createRegistry([declaredTool({ description: '  Read a file inside the workspace.  ' })])

    expect(registry.lookup('read_file')?.description).toBe('Read a file inside the workspace.')
    expect(registry.definitions()[0]?.description).toBe('Read a file inside the workspace.')
  })

  it('stores a strict arguments schema, so an invented parameter is refused not dropped', () => {
    const registry = createRegistry([declaredTool()])

    // `maxBytes` is not a parameter this tool declares. It arrives as a valid JSON object with a
    // key nobody invented in the harness, which is exactly what a quantised model sends.
    const parsed = registry.lookup('read_file')?.arguments?.safeParse({ path: 'notes.md', maxBytes: 12 })
    expect(parsed?.success).toBe(false)
    expect(registry.definitions()[0]?.parameters.additionalProperties).toBe(false)
  })

  it('refuses a bad declaration at construction, and names the tool it refused', () => {
    const refusals: Array<{ why: string; tool: Partial<Tool> }> = [
      { why: 'a name that is not there', tool: { name: '' } },
      { why: 'a name with a space in it', tool: { name: 'read file' } },
      { why: 'a name that looks like a path', tool: { name: '../read_file' } },
      { why: 'a name starting with a digit', tool: { name: '1read_file' } },
      { why: 'a name longer than 64 characters', tool: { name: `r${'x'.repeat(64)}` } },
      { why: 'a description that says nothing', tool: { description: '' } },
      { why: 'a description of spaces only', tool: { description: '   ' } },
      { why: 'a budget of zero bytes', tool: { budgets: { maxBytes: 0, deadlineMs: 2000 } } },
      { why: 'a negative deadline', tool: { budgets: { maxBytes: 4096, deadlineMs: -1 } } },
      { why: 'a deadline that is not a whole number', tool: { budgets: { deadlineMs: 1500.5 } } },
      { why: 'a deadline that is not a number at all', tool: { budgets: { deadlineMs: Number.NaN } } },
      { why: 'arguments that are not an object', tool: { arguments: z.string() } },
    ]

    for (const refusal of refusals) {
      const build = () => createRegistry([declaredTool(refusal.tool)])
      expect(build).toThrow(/registry:/)
      // The message names the tool being refused, so the mistake is findable.
      expect(build).toThrow(new RegExp(`tool "${escapeForRegExp(refusal.tool.name ?? 'read_file')}"`))
    }
  })

  it('refuses the same name declared twice', () => {
    const build = () => createRegistry([declaredTool(), declaredTool()])
    expect(build).toThrow(/declared twice/)
  })
})

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
