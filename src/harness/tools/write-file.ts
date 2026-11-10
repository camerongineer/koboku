import { Buffer } from 'node:buffer'
import { closeSync, lstatSync, openSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

import { z } from 'zod'

import type { Jail } from '../jail'
import type { Tool, ToolOutcome } from './registry'

/**
 * The second tool that touches the real world: create one new text file inside the workspace.
 *
 * Three decisions shape it, and all three are about what a mistake costs.
 *
 * It creates only. A file that already exists is refused, so nothing a run has not read can be destroyed
 * by a badly aimed call — and the exclusive-open flag is what makes that a fact the operating system
 * enforces rather than a check that could pass a moment before the write.
 *
 * It measures before it opens. The content is sized against the declared `maxBytes` first, so a call
 * that is too large never writes anything at all: an over-budget write is refused as data rather than
 * landing as half a file. For a writer, `maxBytes` bounds what may end up on disk rather than what comes
 * back to the model.
 *
 * It does not build directories. One call adds one file to a directory that already exists, which keeps
 * the shape of the workspace something a run cannot change by accident.
 */

/** The standing budget for a write: the largest file this tool may create. */
const MAX_BYTES = 4096
/** The standing per-call deadline. Dispatch arms it; the write itself is synchronous. */
const DEADLINE_MS = 2000

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? (error as { code?: string }).code : undefined
}

/**
 * The `write_file` declaration and its implementation, as one tool record.
 *
 * The path goes through the jail before anything is opened, exactly as the reader's does: the workspace
 * is the blast radius rather than the disk. Existence questions are answered from the canonical path, so
 * what is checked is the place that would actually be written.
 */
export function writeFileTool(options: { jail: Jail }): Tool {
  return {
    name: 'write_file',
    description:
      'Create one new text file inside the workspace. Refuses a path that already exists, a path whose ' +
      'directory is not there, and content larger than the byte budget. It does not overwrite and it ' +
      'does not create directories.',
    arguments: z.object({ path: z.string().min(1), content: z.string() }),
    budgets: { maxBytes: MAX_BYTES, deadlineMs: DEADLINE_MS },
    execute: async (args: unknown, context): Promise<ToolOutcome> => {
      const failure = (output: string): ToolOutcome => ({ output, isError: true })

      const request = args as { path?: unknown; content?: unknown }
      if (typeof request.path !== 'string' || request.path.length === 0) {
        // Dispatch has validated this already. The check is here because a tool is the last place that
        // knows what its own arguments are supposed to mean.
        return failure('"path" must be a non-empty string. Nothing was written.')
      }
      if (typeof request.content !== 'string') {
        return failure('"content" must be a string of text. Nothing was written.')
      }

      let target: string
      try {
        target = options.jail.resolve(request.path)
      } catch (error) {
        return failure(`the path was refused: ${messageOf(error)}`)
      }

      const content = Buffer.from(request.content, 'utf8')
      const budget = Math.max(Math.trunc(context.budgets.maxBytes ?? MAX_BYTES), 1)
      if (content.length > budget) {
        return failure(
          `[refused: "write_file" would write ${content.length} bytes, budget ${budget}. Nothing was ` +
            'written, not even part of it.',
        )
      }

      const parent = dirname(target)
      try {
        const parentStats = lstatSync(parent)
        if (!parentStats.isDirectory()) {
          return failure(`the directory for "${request.path}" is not a directory. Nothing was written.`)
        }
      } catch (error) {
        return failure(
          `the directory for "${request.path}" is not there (${messageOf(error)}). write_file does not ` +
            'create directories, so nothing was written.',
        )
      }

      try {
        const targetStats = lstatSync(target)
        if (targetStats.isDirectory()) {
          return failure(`"${request.path}" is a directory, so it was not written.`)
        }
        return failure(`"${request.path}" already exists. write_file creates a new file and never ` + 'overwrites.')
      } catch (error) {
        // Absent is what this tool needs. Anything else is the operating system's own reason, and the
        // model is given that reason rather than a guess.
        if (codeOf(error) !== 'ENOENT') {
          return failure(`"${request.path}" could not be examined: ${messageOf(error)}`)
        }
      }

      let fileDescriptor: number
      try {
        // `wx` is the guarantee: create, and fail if the name is taken. The `lstatSync` check above is
        // only there to say so in words the model can act on.
        fileDescriptor = openSync(target, 'wx')
      } catch (error) {
        if (codeOf(error) === 'EEXIST') {
          return failure(`"${request.path}" already exists. write_file creates a new file and never ` + 'overwrites.')
        }
        return failure(`"${request.path}" could not be opened for writing: ${messageOf(error)}`)
      }

      try {
        const written = writeSync(fileDescriptor, content, 0, content.length, 0)
        if (written !== content.length) {
          return failure(
            `"${request.path}" received ${written} of ${content.length} bytes, so the file is incomplete. ` +
              'Read it before writing anything else there.',
          )
        }

        return {
          output: `wrote ${written} bytes to "${request.path}". The file is new; nothing was overwritten.`,
          isError: false,
        }
      } catch (error) {
        return failure(`"${request.path}" could not be written: ${messageOf(error)}`)
      } finally {
        closeSync(fileDescriptor)
      }
    },
  }
}
