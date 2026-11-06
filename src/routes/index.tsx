import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'

import { getCannedReply, type Reply } from '../agent.functions'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  const [reply, setReply] = useState<Reply | null>(null)
  const [pending, setPending] = useState(false)

  async function ask() {
    setPending(true)
    setReply(await getCannedReply())
    setPending(false)
  }

  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-2xl font-semibold">M0 exit test</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        The page calls a server function. The server function calls the harness <code>Provider</code>
        interface. That interface is satisfied by the scripted fake provider. Configuration is read and
        validated on the server; no model server and no network are involved.
      </p>
      <button
        className="mt-4 rounded-md border px-3 py-1.5 text-sm"
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
    </main>
  )
}
