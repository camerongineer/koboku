import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { streamRun, type RunStreamValue } from './agent.run'
import { toolRegistryForRun } from './agent.wiring'
import { loadConfig } from './harness/config'
import { openJail } from './harness/jail'
import { cannedTurn, fakeProvider } from './harness/provider/fake'
import { strataProvider } from './harness/provider/strata'

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
 * (see its header comment for the measurement). The same rule is why the jail and the
 * filesystem tool below are used inside a handler body and never exported.
 */

export interface Reply {
  content: string | null
  stopReason: string
  inputTokens: number
  outputTokens: number
  model: string
}

/**
 * Re-exported so a page can name what a stream carries without importing the composition module,
 * which is the file that touches the filesystem. Type-only: erased at compile time, and measured
 * 2026-11-08 to add nothing to what the browser is served.
 */
export type { RunSummary } from './agent.run'

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
 * One run, streamed. The page calls it as `startRun({ data: { prompt: '…' } })` and reads the
 * result with `for await`: each harness event arrives while the run is still going, and the last
 * value on the stream is the closing summary, tagged `run_summary` so a reader can tell it apart.
 *
 * The shape of this handler was decided by measurement rather than by the type. The wire carries
 * yielded values only: what the caller gets is an async iterable — `Symbol.asyncIterator` present,
 * `next` and `return` both `undefined`, prototype `null` — so a returned summary crosses nothing,
 * and measured 2026-11-08 three events arrived with no fourth value. Hence the summary is yielded.
 *
 * The validator is what makes the call possible at all, and that too was measured. Without one,
 * the request type is `undefined` and `startRun({ data: 'x' })` is refused by `tsc` with "Type
 * 'string' is not assignable to type 'undefined'". With a zod object in front of it the call site
 * is typed and checked on the server before any event is produced. It asks for a string only; an
 * empty or whitespace-only prompt is refused by the composition, which is where that rule already
 * lives.
 */
export const startRun = createServerFn({ method: 'POST' })
  .validator(z.object({ prompt: z.string() }))
  .handler(async function* ({ data }): AsyncGenerator<RunStreamValue, void, void> {
    // The real adapter, with the standing configuration: this is the first place a run
    // reaches the model server. `loadConfig` is called once here so the provider and the
    // loop are given the same values.
    const config = loadConfig()

    // The jail is opened here, at the one place that owns the directory: a tool that touches a file
    // without a jail cannot be constructed, and a root that cannot be opened raises before the run
    // starts, which is a configuration mistake saying so. The tools themselves are built in
    // `agent.wiring.ts`, which takes the jail and is reachable from a test; this file exports nothing
    // but server functions.
    const jail = openJail(config.workspaceDir)
    const registry = toolRegistryForRun(jail)

    yield* streamRun(data.prompt, strataProvider(config), config, registry)
  })
