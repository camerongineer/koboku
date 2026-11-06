import { defineConfig } from 'vitest/config'

/**
 * Deliberately separate from vite.config.ts: the Start plugin is not wanted
 * when tests run, and src/harness/ has to stay testable without the framework.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
