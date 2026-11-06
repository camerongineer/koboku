# AGENTS.md — rules for this repository

Binding on humans and agents. Rationale lives **outside** the repository (§1).

## Contents

1. [Repository scope](#1-repository-scope)
2. [Commits: Conventional Commits](#2-commits-conventional-commits)
3. [Architecture invariants](#3-architecture-invariants)
4. [Toolchain](#4-toolchain)
5. [Testing rules](#5-testing-rules)
6. [Working method](#6-working-method)

## 1. Repository scope

- Repo root: **`C:\Users\c-em\Repos\koboku`**. All paths below are relative to it. Never create a second working copy.
- This repository holds: `README.md`, `CHANGELOG.md`, `PLAN.md`, `AGENTS.md`, and source code.
- Name — **kōboku**, macron over the first `o`. Two registers, one name. **Prose** (README, CHANGELOG, comments, human-facing UI labels): **kōboku**. **Code and identifiers** (folder, npm package name, repository name, imports, domains, any shell- or URL-reachable string): ASCII **`koboku`** — npm rejects non-ASCII package names (`EINVALIDTAGNAME`) and non-ASCII paths trouble Windows tooling. **Wherever the macron would break or corrupt an operation, use ASCII `koboku` without hesitation** — shell commands, tool arguments, paths, commit messages, anything parsed by a program. A correct ASCII spelling is never an error. No other variant is in use: not `kouboku`, `houpo`, `honoki`, `hoboku`.
- Documents state **what the project is and what the app does** at the time they were written — never as a learning exercise, never what a milestone taught.
- `README.md` speaks at **app level**: what it is, roughly how it is used, its boundaries. Loop mechanics, internal seams, tool inventories and wire formats belong in `PLAN.md`, `CHANGELOG.md` and the code. Document a capability once it exists in code, not before.
- `CHANGELOG.md` stays current: every user-visible change goes in **Unreleased**, in the commit that makes it. A completed milestone becomes its own versioned section with the date and the exit test that proved it. Tools are listed once implemented, never announced in advance.
- **Never committed**: decision logs, naming and etymology research, ranking tables, logo or icon mockups, scratch diagnostic HTML, plain-language study notes, benchmark write-ups, `node_modules/`, `.env` and any variant, `traces/`, contents of `workspace/`. Such material lives outside the repository; on this machine in the OpenCode scratch directory `C:\Users\c-em\AppData\Local\Temp\opencode\koboku-notes\`, which can be cleared — copy anything worth keeping.

## 2. Commits: Conventional Commits

- Format `type(scope): subject`. Scope optional; subject imperative, ≤ 72 characters, no trailing period. Breaking change: `!` before the colon — `feat(provider)!: change tool result shape`.
- Allowed types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- Body: **one or two sentences** — what changed and the constraint that forced it. A large commit (a new tool, a restructure, a milestone) may carry a longer body. Never design debates, rejected candidates, or measurements that only matter outside the repo.
- ASCII `koboku` is correct in any commit message, subject or body. Write the macron only where it costs nothing.
- One commit per milestone step. Never mix a behaviour change with formatting or dependency churn. No amend after a milestone review: add a follow-up commit.

Examples for this project:

```
feat(loop): yield per-iteration harness events
feat(jail): reject paths outside workspace after canonicalisation
fix(provider): treat arguments parse failure separately from invalid arguments
test(provider): golden transcript for a two-turn tool call
docs: record M0 exit test results
```

## 3. Architecture invariants

These hold at every milestone. A change that breaks one is not a small change.

1. `src/harness/` never imports TanStack Start, React, or any UI/routing package. The harness core is framework-free.
2. No agent framework and no LLM SDK. `src/harness/` has exactly **one** runtime dependency: `zod`. UI-layer dependencies are unrestricted, but nothing under `src/harness/` may import them.
3. The agent loop is an **async generator** yielding one event per iteration. Callers consume it with `for await`.
4. `provider/provider.ts` defines the interface; `strata.ts` and `fake.ts` implement it. Every test uses `fake.ts`.
5. **Never tokenise locally.** Token counts come from provider-reported `usage`. A chars ÷ 4 number may appear only as a labelled pre-call estimate, never as a measurement.
6. Every tool carries a zod schema (which doubles as its `toJSONSchema()` payload) **and budgets**: max bytes, max depth, max results, per-call deadline. Budgets are validated with the arguments.
7. The jail resolves to a canonical absolute path **first**, then checks containment in `workspace/`. There is no interactive approval gate in v1.
8. Wire format, handled explicitly: tool `arguments` arrive as a JSON **string** (parse failure and invalid arguments are distinct failure modes); `content` is `null` when a tool call is requested; tool results must carry the model's `tool_call_id`; `finish_reason: "length"` is never treated as success.
9. Secrets: `.env` is gitignored, `.env.example` is committed, nothing secret is `VITE_`-prefixed, no server function returns a secret. No `dotenv` package — use Node's `--env-file`.
10. Traces are written incrementally as JSON, one file per run, into `traces/`. Never accumulated in memory, never statically served, never committed.

## 4. Toolchain

- `pnpm` is not installed on this machine; do not assume it.
- Tests `vitest` · lint `oxlint` · format `oxfmt` · strict `tsconfig` including `noUncheckedIndexedAccess`, ESM, `tsc --noEmit`.
- Commands: `npm run dev`, `npm run test`, `npm run typecheck`, `npm run lint`, `npm run fmt`.
- `.gitattributes` sets `* text=auto eol=lf`, so the repository stores LF even though `core.autocrlf` is active on this machine. Keep formatting out of unrelated commits so it produces no line-ending churn.

## 5. Testing rules

- Every milestone has an exit test; work stops until it passes.
- No test may require the real model server, the network, or wall-clock timing.
- Golden transcripts under `test/` are recorded from `fake.ts` and reviewed by hand.
- Hardening scenarios are tests, not anecdotes: truncation, malformed `arguments`, a tool that exceeds its budget, a path-escape attempt, a tool that throws, a tool that hangs past its deadline.

## 6. Working method

- One milestone at a time, M0 → M8, in order. No speculative code for a later milestone.
- At each milestone: show the diff, show the passing test output, explain what the files do, stop.
- **Measure, do not assert.** Any performance, size, latency or availability claim names the command or API that produced it, its date, and — if the check was blocked or inconclusive — that fact.
- Architecture and structure decisions belong to the project owner. Propose, state the trade-off, ask. Do not decide silently.
- Local model server: **Strata**, OpenAI-compatible, `http://127.0.0.1:8080/v1`. Its API key is copied by hand into `.env`, never read into any committed file, never printed.
