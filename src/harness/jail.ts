import { basename, dirname, isAbsolute, join, sep } from 'node:path'
import { realpathSync } from 'node:fs'

/**
 * The jail: where a tool is allowed to touch, resolved before anything is opened.
 *
 * Order is the whole design (AGENTS.md §3.7, PLAN.md §7). A candidate path is turned into a canonical
 * absolute path first — symlinks followed, `..` collapsed, the volume form resolved — and only then
 * compared against the canonical workspace root. A check that looks at the written form ("does it
 * start with `workspace/`?") is bypassed by `..`, by an absolute path, and by a symlink that points
 * out.
 *
 * It answers in the two ways a tool needs: a path inside the workspace comes back as the canonical
 * path to open, and a path outside it raises `JailError`, which dispatch turns into a `ToolResult`
 * the model can read. Nothing here approves, warns or prompts: v1 has no interactive gate.
 */

export class JailError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JailError'
  }
}

export interface Jail {
  /** The canonical absolute workspace root. Everything a tool may touch is inside it. */
  readonly root: string
  /**
   * Resolve a path a model named, and refuse it if it lands outside the workspace. A path that does
   * not exist yet still resolves: this answers *where* it would land, not whether it is there.
   */
  resolve(candidate: string): string
}

/**
 * On Windows a path comparison that respects case is a way round the jail, because the filesystem
 * itself does not. Canonical paths from `realpathSync` already carry the platform separator, which is
 * what `path.sep` is.
 */
function sameOrBelow(root: string, candidate: string): boolean {
  const compareRoot = process.platform === 'win32' ? root.toLowerCase() : root
  const compareCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate

  return compareCandidate === compareRoot || compareCandidate.startsWith(`${compareRoot}${sep}`)
}

/**
 * Canonicalise a path that may not exist yet: resolve the nearest ancestor that does exist, then
 * re-join the remaining segments below it. A missing tail is a fact about the file, not about where
 * it would land, and the jail has to answer that before a tool opens anything.
 */
function canonicalise(absolutePath: string): string {
  try {
    return realpathSync(absolutePath)
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') {
      throw new JailError(`cannot resolve "${absolutePath}": ${(error as Error).message}`)
    }

    const parent = dirname(absolutePath)
    if (parent === absolutePath) {
      throw new JailError(`cannot resolve "${absolutePath}": no existing ancestor to resolve against`)
    }

    return join(canonicalise(parent), basename(absolutePath))
  }
}

/**
 * Open the jail over a directory. The root itself is canonicalised, so a workspace reached through a
 * symlink and a workspace reached directly are the same jail, and a root that cannot be opened is a
 * configuration mistake rather than a jail that quietly refuses everything.
 */
export function openJail(rootPath: string): Jail {
  let root: string
  try {
    root = realpathSync(rootPath)
  } catch (error) {
    throw new JailError(
      `the workspace root "${rootPath}" cannot be opened (${(error as Error).message}). ` +
        'Create the directory before opening the jail.',
    )
  }

  return {
    root,
    resolve(candidate: string): string {
      if (candidate.length === 0) {
        throw new JailError('a path is required: the request named none')
      }
      // A NUL byte truncates a path where the rest of the system would not see it.
      if (candidate.includes('\0')) {
        throw new JailError('the path contains a null byte, which is not a path')
      }

      const written = candidate.trim()
      const absolute = canonicalise(isAbsolute(written) ? written : join(root, written))

      if (!sameOrBelow(root, absolute)) {
        throw new JailError(
          `"${candidate}" resolves outside the workspace. The workspace is ${root}; name a path inside it.`,
        )
      }

      return absolute
    },
  }
}
