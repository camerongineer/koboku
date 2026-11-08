import { createServerFn } from '@tanstack/react-start'

import { runRecorded } from './agent.run'
import { loadConfig } from './harness/config'
import { cannedTurn, fakeProvider } from './harness/provider/fake'

/**
 * The bridge. This is the only kind of file allowed to know about both worlds: it may
 * import the framework and the harness, and it holds no agent logic. Everything it
 * returns is plain data, which is what makes it serialisable across the browser
 * boundary — so it hands back run outcomes, never a server file path and never a key.
 *
 * It exports server functions and types, and nothing else. That is a measured
 * constraint, not a preference: the body of a server function stays on the server, but a
 * plain function exported from this file is handed to the browser along with everything
 * it imports. The composition that opens a trace lives in `agent.run.ts` for that reason
 * (see its header comment for the measurement).
 */

export interface Reply {
  content: string | null
  stopReason: string
  inputTokens: number
  outputTokens: number
  model: string
}

/**
 * The same canned reply the vitest test asserts, reached through the same
 * Provider interface. Proves the seam survives the browser boundary.
 *
 * The fake provider is deliberate: no model server and no network are
 * involved. `loadConfig()` is real, so this is also the place where the
 * harness configuration is proved to reach the server runtime. The API key is
 * read and validated but never returned: a server function response goes to
 * the browser. Measured 2026-11-08 in the running dev server: the page renders
 * `model qwen3.8-flash-next-iq3_xxs`, which is the value `loadConfig` read from
 * the environment on the server.
 */
export const getCannedReply = createServerFn({ method: 'GET' }).handler(async (): Promise<Reply> => {
  const config = loadConfig()

  const provider = fakeProvider([cannedTurn('the canned reply')])

  const turn = await provider.generate({
    model: config.model,
    messages: [{ role: 'user', content: 'M0 exit test' }],
    tools: [],
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
  })

  return {
    content: turn.content,
    stopReason: turn.stopReason,
    inputTokens: turn.usage.inputTokens,
    outputTokens: turn.usage.outputTokens,
    model: config.model,
  }
})

/**
 * Reached from the page as `startRun({ data: 'a prompt' })`. Measured 2026-11-08, and the
 * measurement is the point: with no validator the request type is `undefined`, so that
 * call is refused by `tsc` with "Type 'string' is not assignable to type 'undefined'". A
 * validator is needed before a page can send a prompt, and the shape of it is the next
 * step. Until then nothing calls this.
 */
export const startRun = createServerFn({ method: 'POST' }).handler(async ({ data }) => {
  if (typeof data !== 'string') {
    throw new Error('bridge: startRun expects the prompt as a string')
  }
  return runRecorded(data)
})
