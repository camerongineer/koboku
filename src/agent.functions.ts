import { createServerFn } from '@tanstack/react-start'

import { loadConfig } from './harness/config'
import { cannedTurn, fakeProvider } from './harness/provider/fake'

/**
 * The bridge. This is the only kind of file allowed to know about both worlds:
 * it may import the framework and the harness, and it holds no agent logic.
 * Everything it returns is plain data, which is what makes it serialisable
 * across the browser boundary.
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
 * the browser.
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
