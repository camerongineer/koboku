import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { JailError, openJail } from '../src/harness/jail'

/**
 * M3: the jail. Every case here is one of the three ways PLAN.md §7 says a naive containment check is
 * bypassed — `..`, an absolute path, a symlink — plus the cases a tool needs answered without a file
 * existing yet.
 *
 * The workspace is a temporary directory, created and deleted inside the test. Nothing in this file
 * touches the repository's own `workspace/`, a model server, the network or a clock.
 */

/** Windows needs a junction, which needs no elevated privileges; elsewhere a directory link. */
function linkKind(): 'junction' | 'dir' {
  return process.platform === 'win32' ? 'junction' : 'dir'
}

function withDirs<R>(run: (workspace: string, outside: string) => R): R {
  const workspace = mkdtempSync(join(tmpdir(), 'koboku-jail-'))
  const outside = mkdtempSync(join(tmpdir(), 'koboku-outside-'))
  try {
    return run(workspace, outside)
  } finally {
    rmSync(outside, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
}

describe('the jail', () => {
  it('resolves a relative path to a canonical absolute path inside the workspace', () =>
    withDirs((workspace) => {
      writeFileSync(join(workspace, 'notes.txt'), 'hello')
      const jail = openJail(workspace)

      const resolved = jail.resolve('notes.txt')

      expect(resolved).toBe(join(jail.root, 'notes.txt'))
      expect(resolved.startsWith(jail.root)).toBe(true)
    }))

  it('refuses a path that walks out with ..', () =>
    withDirs((workspace) => {
      mkdirSync(join(workspace, 'sub'))
      const jail = openJail(workspace)

      // `sub/../x` lands back *inside* the workspace. Containment is about where a path resolves,
      // not about whether the written form contains `..`.
      expect(jail.resolve('sub/../inside.txt')).toBe(join(jail.root, 'inside.txt'))

      // Two levels up from `sub` is above the workspace root, and that is the escape.
      expect(() => jail.resolve('sub/../../escape.txt')).toThrow(JailError)
      expect(() => jail.resolve('../../escape.txt')).toThrow(JailError)
      expect(() => jail.resolve('sub/../../escape.txt')).toThrow(/resolves outside the workspace/)
    }))

  it('refuses an absolute path that names a place outside the workspace', () =>
    withDirs((workspace, outside) => {
      const jail = openJail(workspace)

      expect(() => jail.resolve(join(outside, 'secret.txt'))).toThrow(JailError)
      // The refusal tells the model what the boundary is, so it can name a path inside it.
      expect(() => jail.resolve(join(outside, 'secret.txt'))).toThrow(/name a path inside it/)
    }))

  it('accepts an absolute path that is already inside the workspace', () =>
    withDirs((workspace) => {
      writeFileSync(join(workspace, 'notes.txt'), 'hello')
      const jail = openJail(workspace)

      expect(jail.resolve(join(jail.root, 'notes.txt'))).toBe(join(jail.root, 'notes.txt'))
    }))

  it('refuses a link that points out of the workspace', () =>
    withDirs((workspace, outside) => {
      writeFileSync(join(outside, 'secret.txt'), 'not for the harness')
      symlinkSync(outside, join(workspace, 'link'), linkKind())
      const jail = openJail(workspace)

      expect(() => jail.resolve('link/secret.txt')).toThrow(JailError)
      expect(() => jail.resolve('link/secret.txt')).toThrow(/resolves outside the workspace/)
    }))

  it('resolves a path that does not exist yet, when it would land inside', () =>
    withDirs((workspace) => {
      const jail = openJail(workspace)

      // Existence is the tool's question. Where it would land is the jail's, and it has to be
      // answerable before anything is opened.
      expect(jail.resolve('deep/nested/missing.txt')).toBe(join(jail.root, 'deep/nested/missing.txt'))
    }))

  it('treats the workspace root itself as inside the jail', () =>
    withDirs((workspace) => {
      const jail = openJail(workspace)

      // `jail.root` is the canonical form, which is what a resolved path is compared against.
      expect(jail.resolve('.')).toBe(jail.root)
    }))

  it('refuses a path that is not a path', () =>
    withDirs((workspace) => {
      const jail = openJail(workspace)

      expect(() => jail.resolve('')).toThrow(JailError)
      expect(() => jail.resolve('\u0000notes.txt')).toThrow(/null byte/)
    }))

  it('refuses a workspace root that cannot be opened, rather than quietly refusing everything', () =>
    withDirs((workspace) => {
      expect(() => openJail(join(workspace, 'no-such-directory'))).toThrow(JailError)
      expect(() => openJail(join(workspace, 'no-such-directory'))).toThrow(/cannot be opened/)
    }))

  it('does not let a differently cased path open a way round', () =>
    withDirs((workspace, outside) => {
      writeFileSync(join(workspace, 'notes.txt'), 'hello')
      const jail = openJail(workspace)

      // The file name as written differs in case. On Windows that is the same file; on a
      // case-sensitive system it is a name that does not exist. Either way the answer is about
      // containment, and containment holds.
      expect(jail.resolve('NOTES.TXT').startsWith(jail.root)).toBe(true)
      expect(() => jail.resolve(join(outside, 'SECRET.TXT'))).toThrow(JailError)
    }))
})
