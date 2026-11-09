import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'

import {
  getCannedReply,
  startRun,
  type Reply,
  type RunSummary,
} from '../agent.functions'
import type { HarnessEvent } from '../harness/types'

export const Route = createFileRoute('/')({ component: Home })

/**
 * One line of the running transcript. The page renders events, never a summary of the
 * conversation: what a harness does is one event at a time, and the page shows them in the
 * order they arrived.
 */
function describe(event: HarnessEvent): string {
  switch (event.type) {
    case 'model_call_started':
      return `iteration ${event.iteration}: asking the model`
    case 'model_call_finished':
      return `iteration ${event.iteration}: stop ${event.stopReason}, ${event.toolCallCount} tool calls, tokens ${event.usage.inputTokens}/${event.usage.outputTokens}`
    case 'tool_call_requested':
      return `iteration ${event.iteration}: ${event.toolName} asked for ${event.arguments}`
    case 'tool_result':
      return `iteration ${event.iteration}: ${event.result.toolName} returned ${event.result.output}`
    case 'run_finished':
      return `run closed: ${event.reason} after ${event.iterations} iteration(s), total tokens ${event.totalUsage.inputTokens}/${event.totalUsage.outputTokens}`
  }
}

function Home() {
  const [reply, setReply] = useState<Reply | null>(null)
  const [pending, setPending] = useState(false)

  const [prompt, setPrompt] = useState('Say hello, then say what you just did.')
  const [events, setEvents] = useState<HarnessEvent[]>([])
  const [summary, setSummary] = useState<RunSummary | null>(null)
  const [running, setRunning] = useState(false)

  async function ask() {
    setPending(true)
    setReply(await getCannedReply())
    setPending(false)
  }

  async function run() {
    setRunning(true)
    setEvents([])
    setSummary(null)

    // `startRun` hands back an async iterable, measured 2026-11-08: it has
    // Symbol.asyncIterator but no `next()`, so `for await` is the only way to read it —
    // the same way AGENTS.md §3 rule 3 says a harness generator is consumed. Each
    // iteration of this loop is one value arriving over the wire, and the last one is the
    // summary, which is why it is tagged rather than another kind of harness event.
    for await (const value of await startRun({ data: { prompt } })) {
      if (value.type === 'run_summary') {
        setSummary(value.summary)
      } else {
        setEvents((current) => [...current, value])
      }
    }

    setRunning(false)
  }

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold">kōboku</h1>

      <section className="mt-6">
        <h2 className="text-lg font-medium">start a run</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The page calls one streaming server function and reads it one event at a time. The
          provider is still the scripted one, so this proves the wire rather than the model.
        </p>
        <textarea
          className="mt-3 w-full rounded-md border p-2 font-mono text-sm"
          rows={2}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <button
          className="mt-3 rounded-md border px-3 py-1.5 text-sm"
          onClick={run}
          disabled={running}
        >
          {running ? 'running' : 'start the run'}
        </button>

        <ul className="mt-4 space-y-1 font-mono text-sm">
          {events.map((event, index) => (
            <li key={`${event.type}-${index}`}>{describe(event)}</li>
          ))}
        </ul>

        {summary ? (
          <p className="mt-3 font-mono text-sm text-muted-foreground">
            run {summary.runId} · {summary.finishReason} · {summary.iterations} iteration(s) · tokens{' '}
            {summary.totalUsage.inputTokens}/{summary.totalUsage.outputTokens}
          </p>
        ) : null}

        {summary?.finalContent ? (
          <p className="mt-2 font-mono text-sm">{summary.finalContent}</p>
        ) : null}
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-medium">M0 exit test</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The page calls a server function. The server function calls the harness <code>Provider</code>
          interface. That interface is satisfied by the scripted fake provider. Configuration is read and
          validated on the server; no model server and no network are involved.
        </p>
        <button
          className="mt-3 rounded-md border px-3 py-1.5 text-sm"
          onClick={ask}
          disabled={pending}
        >
          {pending ? 'asking' : 'ask the fake provider'}
        </button>
        <p className="mt-4 font-mono text-sm">{reply?.content}</p>
        {reply ? (
          <p className="mt-1 font-mono text-sm text-muted-foreground">
            model {reply.model} · stop {reply.stopReason} · tokens {reply.inputTokens}/
            {reply.outputTokens}
          </p>
        ) : null}
      </section>
    </main>
  )
}
