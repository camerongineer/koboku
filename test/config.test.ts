import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/harness/config'

/**
 * M3 close-out: the jail needs a root, and config.ts is the one place that names it. These tests
 * hand `loadConfig` an explicit environment object, so nothing here reads `.env`, `.env.local` or
 * the machine's environment (AGENTS.md §5). The API key value is inert: no server is contacted.
 */

const inertKey = { KOBOKU_PROVIDER_API_KEY: 'inert-value-not-a-secret' }

describe('the workspace root the jail resolves over', () => {
  it('defaults to workspace when the key is absent', () => {
    const config = loadConfig({ ...inertKey })

    expect(config.workspaceDir).toBe('workspace')
  })

  it('passes a named directory through unchanged, relative or absolute', () => {
    const relative = loadConfig({ ...inertKey, KOBOKU_WORKSPACE_DIR: 'scratch/run-workspace' })
    const absolute = loadConfig({ ...inertKey, KOBOKU_WORKSPACE_DIR: 'C:\\somewhere\\else' })

    // Not resolved here on purpose: the jail canonicalises the root it is handed, so there is one
    // place in the harness that knows about paths rather than two that could disagree.
    expect(relative.workspaceDir).toBe('scratch/run-workspace')
    expect(absolute.workspaceDir).toBe('C:\\somewhere\\else')
  })

  it('refuses an empty directory and names the key it refused', () => {
    let message = ''
    try {
      loadConfig({ ...inertKey, KOBOKU_WORKSPACE_DIR: '' })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    // An empty root would reach `openJail` as the process working directory, which is not a jail.
    expect(message).toContain('config: environment is not valid')
    expect(message).toContain('KOBOKU_WORKSPACE_DIR')
  })

  it('still refuses to return without the provider key, so a default cannot smuggle one in', () => {
    expect(() => loadConfig({ KOBOKU_WORKSPACE_DIR: 'workspace' })).toThrow(/KOBOKU_PROVIDER_API_KEY/)
  })
})
