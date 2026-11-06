import { createServerFn } from '@tanstack/react-start'

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
}

/**
 * The same canned reply the vitest test asserts, reached through the same
 * Provider interface. Proves the seam survives the browser boundary.
 *
 * The fake provider is deliberate: this half of M0 must pass with no model
 * server and no key, so no configuration is read here.
 */
export const getCannedReply = createServerFn({ method: 'GET' }).handler(async (): Promise<Reply> => {
  const provider = fakeProvider([cannedTurn('the canned reply')])

  const turn = await provider.generate({
    model: 'fake',
    messages: [{ role: 'user', content: 'M0 exit test' }],
    tools: [],
    temperature: 0,
    maxOutputTokens: 64,
  })

  return {
    content: turn.content,
    stopReason: turn.stopReason,
    inputTokens: turn.usage.inputTokens,
    outputTokens: turn.usage.outputTokens,
  }
})
