import { Buffer } from 'node:buffer'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

import { z } from 'zod'

import type { Jail } from '../jail'
import type { Tool, ToolOutcome } from './registry'

/**
 * The first tool that touches the real world: read one file inside the workspace.
 *
 * Two rules shape it. The path goes through the jail before anything is opened, so the workspace is
 * the blast radius rather than the disk. And the read is bounded from the start — the filesystem is
 * asked for at most the declared byte budget, never the whole file followed by a slice (PLAN.md §7) —
 * with any cut stated in the text the model reads, because a model given silently clipped content will
 * confidently describe what it never received.
 */

/** The standing budget for a read, used when a caller hands this tool no declared `maxBytes`. */
const MAX_BYTES = 4096
/** The standing per-call deadline. Dispatch arms it; the read itself is synchronous. */
const DEADLINE_MS = 2000

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Move a byte limit back to a character boundary. A read stops at a byte count, and a byte count can
 * land inside a multi-byte character; cutting there hands the model a replacement character where a
 * clean end should be. A continuation byte is the one that must not start a kept run.
 */
function cutToCharacterBoundary(buffer: Buffer, limit: number): Buffer {
  let end = Math.min(limit, buffer.length)
  while (end > 0 && end < buffer.length && ((buffer[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1
  }
  return buffer.subarray(0, end)
}

function truncationNotice(toolName: string, fileSize: number, keptBytes: number, budget: number): string {
  return (
    `[truncated: "${toolName}" read ${keptBytes} of ${fileSize} bytes, budget ${budget}; the rest was ` +
    'never read.]'
  )
}

/**
 * The `read_file` declaration and its implementation, as one tool record.
 *
 * The declared `maxBytes` bounds everything the call returns, including the sentence that reports a
 * truncation, so the budget is the number of bytes one read costs the run rather than a limit its own
 * reporting slips past.
 */
export function readFileTool(options: { jail: Jail }): Tool {
  return {
    name: 'read_file',
    description:
      'Read one text file inside the workspace. Returns at most the byte budget of the file, and says ' +
      'so when the file is larger.',
    arguments: z.object({ path: z.string().min(1) }),
    budgets: { maxBytes: MAX_BYTES, deadlineMs: DEADLINE_MS },
    execute: async (args: unknown, context): Promise<ToolOutcome> => {
      const failure = (output: string): ToolOutcome => ({ output, isError: true })

      const request = args as { path?: unknown }
      if (typeof request.path !== 'string' || request.path.length === 0) {
        // Dispatch has validated this already. The check is here because a tool is the last place that
        // knows what its own arguments are supposed to mean.
        return failure('"path" must be a non-empty string. The file was not read.')
      }

      let target: string
      try {
        target = options.jail.resolve(request.path)
      } catch (error) {
        return failure(`the path was refused: ${messageOf(error)}`)
      }

      const budget = Math.max(Math.trunc(context.budgets.maxBytes ?? MAX_BYTES), 1)

      let fileDescriptor: number
      try {
        fileDescriptor = openSync(target, 'r')
      } catch (error) {
        return failure(`"${request.path}" could not be opened: ${messageOf(error)}`)
      }

      try {
        const stats = fstatSync(fileDescriptor)
        if (!stats.isFile()) {
          return failure(`"${request.path}" is not a regular file, so it was not read.`)
        }

        // One buffer, sized to the budget: the filesystem is never asked for more than the tool may return.
        const buffer = Buffer.alloc(budget)
        const bytesRead = readSync(fileDescriptor, buffer, 0, budget, 0)

        if (stats.size <= budget) {
          return { output: buffer.subarray(0, bytesRead).toString('utf8'), isError: false }
        }

        // The file is larger than the budget. Reserve room for the sentence that reports the cut and the
        // newline after it, then keep as much file as is left, cut at a character boundary.
        const noticeForFullBuffer = truncationNotice('read_file', stats.size, bytesRead, budget)
        const contentBudget = Math.max(budget - Buffer.byteLength(noticeForFullBuffer, 'utf8') - 1, 0)
        const kept = cutToCharacterBoundary(buffer, contentBudget).toString('utf8')
        const keptBytes = Buffer.byteLength(kept, 'utf8')

        const output = `${truncationNotice('read_file', stats.size, keptBytes, budget)}\n${kept}`
        return { output, isError: false }
      } catch (error) {
        return failure(`"${request.path}" could not be read: ${messageOf(error)}`)
      } finally {
        closeSync(fileDescriptor)
      }
    },
  }
}
