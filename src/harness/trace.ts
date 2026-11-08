import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { HarnessEvent } from './types'

/**
 * The trace writer: the log of a run.
 *
 * Its whole job is to get each harness event onto disk the moment it happens, into
 * one file per run, so a finished run — especially a bad one — can be read line by
 * line afterwards instead of guessed at from what the page happened to show. It
 * appends and never collects, which is what makes a run that dies halfway leave
 * behind everything it actually got to (AGENTS.md §3, rule 10).
 *
 * Each line is a complete JSON document on its own. A single JSON array could only
 * be finished by a run that survived to the end, so the file format follows the
 * incremental rule rather than the other way round.
 *
 * Server-side only: this file touches Node's filesystem, so it is never imported by
 * a route or a browser module, and the file it writes is never statically served.
 * Only harness events are recorded, which is why a provider API key can never appear
 * in a trace — a key is not part of any event.
 */

/** PLAN.md §5 fixes this directory. It is git-ignored, so no trace is committed. */
export const DEFAULT_TRACE_DIRECTORY = 'traces'

/**
 * The run id becomes a file name, so it has to be one flat name and nothing else:
 * a leading letter or digit, then letters, digits, dots, dashes and underscores.
 * That one rule is what keeps the file inside the trace directory — no `..`, no path
 * separator, no drive letter, nothing `join` could turn into a path somewhere else.
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * The writer's own first line, and not a harness event: it names the run and the
 * model, so a reader holding a single line still knows which run it came from.
 * `run_header` is deliberately a name no HarnessEvent uses.
 */
export interface TraceHeader {
  type: 'run_header'
  runId: string
  model: string
}

export interface TraceOptions {
  /** Becomes the file name `<runId>.jsonl`. Validated before anything is created. */
  runId: string
  /** Which model this run talked to: recorded because a trace is read on its own. */
  model: string
  /** Defaults to the standing directory, `traces/`. */
  directory?: string
}

export interface TraceWriter {
  /** Canonical absolute path of this run's file, settled before the first byte. */
  readonly path: string
  /**
   * Appends one event as one JSON line and returns only once it is on disk. Nothing
   * is buffered: buffering is how a crashed run loses its own evidence. The price —
   * one open-write-close per event — is taken on purpose here and measured at M6.
   */
  write(event: HarnessEvent): void
}

/**
 * Opens one run's trace and writes its header line immediately, which is also what
 * creates the directory. Opening a run id that already has a file starts that file
 * again: one file per run means one header per run, not two runs merged into a file
 * that can no longer be read from the top.
 */
export function openTrace(options: TraceOptions): TraceWriter {
  const { runId, model } = options
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new RangeError(`trace: runId must be a single file name (got ${JSON.stringify(runId)})`)
  }

  const directory = resolve(options.directory ?? DEFAULT_TRACE_DIRECTORY)
  const path = join(directory, `${runId}.jsonl`)
  const header: TraceHeader = { type: 'run_header', runId, model }

  mkdirSync(directory, { recursive: true })
  writeFileSync(path, `${JSON.stringify(header)}\n`)

  return {
    path,
    write(event: HarnessEvent): void {
      appendFileSync(path, `${JSON.stringify(event)}\n`)
    },
  }
}
