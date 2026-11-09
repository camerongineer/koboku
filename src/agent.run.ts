import type { HarnessConfig } from './harness/config'
import { runAgent } from './harness/loop'
import { openTrace } from './harness/trace'
import type { ToolRegistry } from './harness/tools/registry'
import type { Provider } from './harness/provider/provider'
import type { HarnessEvent, Message, RunFinishReason, TokenUsage } from './harness/types'

/**
 * The caller half of a run, with no framework in it: open the trace, drive the loop to
 * its end, report what happened. It lives in its own file because of how the boundary
 * actually works, which was measured rather than assumed — the body of a server
 * function is kept on the server, but a plain function *exported* from a bridge file is
 * handed to the browser together with everything it imports, which for a trace writer
 * means Node's filesystem. Measured 2026-11-08: with `runRecorded` exported from
 * `agent.functions.ts` the page was served that function and `src/harness/trace.ts`, and
 * the run failed in the browser with `Module "node:fs" has been externalized for browser
 * compatibility`. With the export removed the same page was served only server-function
 * stubs and no harness import at all, and it worked.
 *
 * Being framework-free is also what makes it testable: `test/bridge-run.test.ts` imports
 * this file directly and never imports the framework.
 */

/**
 * What one recorded run hands back to the page. Plain data only, and deliberately
 * without the trace path: a browser must not learn where the server keeps its files
 * (PLAN.md §2), and the trace is reachable later through a server function, not a URL.
 */
export interface RunSummary {
  /** The name the trace file was made from, so a later request can ask for that run. */
  runId: string
  finishReason: RunFinishReason
  iterations: number
  /** Provider-reported counts summed by the loop, never a local estimate. */
  totalUsage: TokenUsage
  /** The last assistant turn: the text a chat page shows. */
  finalContent: string | null
}

/**
 * The last value on the stream, and the reason it is a value rather than the generator's
 * return: measured 2026-11-08 in the running app, the wire carries yielded values only. The
 * caller receives an async iterable — `Symbol.asyncIterator` present, `next` and `return`
 * absent — and a generator's return value is not one of the values an iterable yields, so a
 * summary returned that way reaches no one. Tagged, because it shares the stream with the
 * harness events and a reader has to be able to tell them apart.
 */
export interface RunSummaryValue {
  type: 'run_summary'
  summary: RunSummary
}

/** What one streamed run puts on the wire: the harness events, then the summary. */
export type RunStreamValue = HarnessEvent | RunSummaryValue

/**
 * One recorded run, streamed. The provider and the configuration come from the caller: this
 * function does not choose a model or read the environment, which is what lets
 * `test/bridge-run.test.ts` run against a scripted provider with an inert config while
 * `src/agent.functions.ts` runs against the real server with the standing one.
 *
 * The tools come from the caller too, and none are built here: a tool that touches the filesystem
 * needs a jail, and a jail is opened by whoever owns the directory the run is confined to.
 *
 * It is an async generator for the same reason `runAgent` is (AGENTS.md §3, rule 3): the
 * caller sees each iteration the moment it happens. The harness event union is not widened
 * by any of this — the summary is a value this composition adds at the end, not a new kind
 * of harness event.
 *
 * One consequence of the shape is worth knowing: the body of an async generator does not
 * run until the first `next()`. Asking for a bad prompt is not rejected when this function
 * is called, it is rejected when the first event is asked for. Nothing is opened either way.
 */
export async function* streamRun(
  prompt: string,
  provider: Provider,
  config: HarnessConfig,
  registry?: ToolRegistry,
): AsyncGenerator<RunStreamValue, void, void> {
  const request = prompt.trim()
  if (request === '') {
    throw new Error('bridge: a run needs a prompt')
  }

  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const trace = openTrace({ runId, model: config.model })

  const messages: Message[] = [{ role: 'user', content: request }]
  let finish: RunSummary | undefined

  for await (const event of runAgent({
    provider,
    model: config.model,
    messages,
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
    // Passed through, not built here: which tools a run may use is decided by the caller that owns
    // the run, and `config.workspaceDir` is the directory a jail was opened over to make them.
    registry,
    trace,
  })) {
    // Each event is handed to the caller as the loop yields it, and the trace already
    // holds it too: the composition forwards events, it never records them itself.
    yield event

    // Only the closing event is kept for the summary.
    if (event.type === 'run_finished') {
      finish = {
        runId,
        finishReason: event.reason,
        iterations: event.iterations,
        totalUsage: event.totalUsage,
        finalContent: lastAssistantContent(messages),
      }
    }
  }

  if (finish === undefined) {
    // The loop always closes a run with this event, so its absence is a broken loop,
    // not an unusual conversation. Saying so is better than returning an empty summary.
    throw new Error('bridge: the run ended without a run_finished event')
  }
  yield { type: 'run_summary', summary: finish }
}

/**
 * The last thing the model said. `findLast` is unavailable in this tsconfig (lib is
 * ES2022), and `noUncheckedIndexedAccess` makes a negative index meaningless, so the
 * scan is written out.
 */
function lastAssistantContent(messages: Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && message.role === 'assistant') {
      return message.content
    }
  }
  return null
}
