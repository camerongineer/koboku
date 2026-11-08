# Changelog

All notable changes to kōboku are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), the added/changed/fixed/removed headings
match Conventional Commits types, and this project adheres to semantic versioning from the first
release.

The **Unreleased** section describes the product as it will be at v1: what a reader gets when the
milestones below are complete. Each completed milestone is recorded as its own versioned section,
with the date and the tests that proved it.

## Unreleased — planned scope of v1

The scope of v1, as planned: a local, single-user agent harness with a browser chat page and a trace
inspector page. Tools are recorded under this heading as they are implemented, not before.

### Toolchain

- TanStack Start on Vite and React, Node target only. Tailwind CSS and shadcn carry the styling; the
  starter theme and its remote font import were removed, leaving Tailwind plus the shadcn tokens.
- Commands `npm run dev`, `test`, `typecheck`, `lint` and `fmt`. Lint is oxlint and format is oxfmt;
  the scaffold's biome/eslint toolchain was declined at creation time.
- TypeScript strict including `noUncheckedIndexedAccess`. Tests run through a separate
  `vitest.config.ts` so that they do not load the Start plugin.
- Configuration is read from `process.env` and validated with zod. Non-secret `KOBOKU_*` values live
  in the committed `.env`, the provider key belongs in git-ignored `.env.local`, and `.env.example`
  lists every key with no values.

### Fixed

- `src/harness/provider/strata.ts` now serialises an assistant message that carries tool calls:
  `tool_calls` with the model's own `id`, `type` set to `function`, and the `arguments` string sent
  back exactly as stored — a cut-off string stays cut-off. Without it the loop's assistant turns were
  dropped, so the next call would show the model the result of a request it was never shown making.
  Recorded open at M0 and again at M1, closed in its own follow-up commit on 2026-11-08.
- Measured 2026-11-08: `test/provider-strata-wire.test.ts`, 4 tests — the tool-call turn, a partial
  `arguments` string, a turn that writes no `tool_calls` key at all, and a tool result carrying
  `tool_call_id` with no tool name, since the wire has no place for one. `npm run test` → 4 files,
  19 tests passed in 597 ms with no model server and no network; `npm run typecheck` → exit 0;
  `npm run lint` → exit 0.

## 0.0.2 — 2026-11-06 — M1

The agent loop exists as an async generator, and both halves of the M1 exit test pass against
`fake.ts` with no model server and no network.

### Added

- `src/harness/loop.ts` — `runAgent()`, the agent loop as an async generator that yields one
  `HarnessEvent` per iteration as it happens, consumed with `for await`. It branches on the stop
  reason: `stop` ends the run, `tool_calls` continues, `length` ends the run as truncated and is
  never treated as a success, and no further round is attempted after a cut-off completion because
  the arguments of a call cut off mid-write may themselves be partial. The caller owns the message
  list: the loop appends to it and never rewrites an entry. A provider failure reaches the caller
  rather than being turned into a tool result.
- The iteration budget is a loop parameter — `maxIterations`, default `DEFAULT_MAX_ITERATIONS = 8` —
  not an environment key. A budget that is not a positive integer raises before any provider call,
  so a bad value cannot spend model inference.
- Unknown tool names are answered **in data**: a `ToolResult` with `isError: true`, the model's own
  `tool_call_id` and tool name, and a sentence saying no tool is wired up yet, then the loop
  continues so the model can change strategy. At M1 no tool exists, so the loop sends no tool list
  and every requested name is unknown. This interim branch moves into `dispatch.ts` at M3; no
  registry was built in anticipation.
- `src/harness/types.ts` — `HarnessEvent`, the union of the five variants the loop can produce
  today: `ModelCallStartedEvent`, `ModelCallFinishedEvent`, `ToolCallRequestedEvent`,
  `ToolResultEvent`, `RunFinishedEvent`, plus `RunFinishReason`
  (`model_stop` | `model_truncated` | `iteration_cap_exhausted`). Truncation warnings and
  tool-budget variants are a tool's own failure, so they are not declared before the tools exist.
  `Message.toolCalls` was added: without it the conversation a provider sees is missing the model's
  own request.
- `test/loop-golden-transcript.test.ts` and `test/loop-iteration-cap.test.ts` — 11 tests, the two
  halves of the exit test.

### Exit test, both halves

- Golden transcript: canned responses in, exact message list out, exact event list out. Recorded
  from `fake.ts`, every expectation written by hand. Covers one spoken answer; a tool name that does
  not exist answered with the model's own `tool_call_id`, where the second model call is shown the
  refusal; `arguments` carried through unparsed; `length` reported as truncated rather than as a
  completed answer, including a tool call that arrived inside a cut-off completion; and a provider
  error reaching the caller.
- Iteration cap: a fake that always asks for another tool call is stopped after exactly the budget —
  3 model calls, 13 events, 7 messages, ending in `run_finished` with
  `reason: 'iteration_cap_exhausted'` and `iterations: 3`. The same script cut to exactly 3 turns
  passes without the fake raising `RangeError`, which proves the loop never asked for a fourth turn.
  Given no budget the run stops at 8, and the fake recorded exactly 8 calls.
- Commands, 2026-11-06, Node v24.12.0: `npm run test` → 3 files, 15 tests passed in 190 ms;
  `npm run typecheck` → exit 0; `npm run lint` → exit 0. No model server was contacted, no network
  request was made, and no test depends on wall-clock time.

### Gaps recorded at M1

- The gap recorded at M0 is now reachable: the loop appends assistant messages that carry tool
  calls, and `strata.ts` `toWireMessage` drops `toolCalls`, so a real tool round-trip through Strata
  is malformed. Left unfixed on purpose — a provider change inside a loop milestone mixes two
  things. It is its own follow-up commit, and M2 needs it.
- `npm run fmt` was not run. `npx oxfmt --list-different`, 2026-11-06: 18 files listed, including
  untouched M0 files, because oxfmt has no config file in the repository and its defaults are double
  quotes with semicolons while this codebase is written single-quote and semicolon-free. Running it
  would rewrite the whole tree. The new files match the existing style; a `.oxfmtrc.json` is a
  separate decision.
- Still nothing outside the harness core: no streaming server function, no tools, no jail, no trace
  writer, and the model server has still never been contacted.

## 0.0.1 — 2026-11-06 — M0

The Provider seam exists, and both halves of the M0 exit test pass.

### Added

- `src/harness/types.ts` — `Message`, `ToolCall`, `ToolResult`, `StopReason`, `TokenUsage`,
  `AssistantTurn`. Hand-written: no SDK defines these shapes.
- `src/harness/provider/provider.ts` — the `Provider` interface. One `generate()` call: a message list
  and a tool list in, one assistant turn out.
- `src/harness/provider/fake.ts` — a scripted provider with the same interface. It records every
  request it receives and raises `RangeError` rather than invent a turn it was not given.
- `src/harness/provider/strata.ts` — the real adapter: hand-written OpenAI-compatible request and
  response shapes, validated with zod. A `finish_reason` outside `stop`, `tool_calls` or `length`
  raises an error naming the value.
- `src/harness/config.ts` — environment reading validated with zod. A failure names the offending keys
  and the rules they broke, never the values.
- `src/agent.functions.ts` — the server-function bridge, and a page at `/` that calls it. The bridge
  calls `loadConfig()`, so configuration is read and validated on the server before the provider is
  reached. The key is validated but never returned: a server-function response goes to the browser.

### Exit test, both halves

- Vitest half: `npm run test`, 2026-11-06 — 1 file, 4 tests passed in 174 ms, no model server and no
  network.
- Server-function half: `npm run dev`, 2026-11-06 — a click on the page, and the browser network log
  showing `GET /_serverFn/…` returning 200 in 72 ms. The page rendered the same canned reply the test
  asserts.
- Re-run with configuration live, `npm run dev`, 2026-11-06 — 200 in 88 ms, zero console errors, and the
  page rendered `model qwen3.8-flash-next-iq3_xxs`, which came from `loadConfig()` across the boundary.

### Configuration, measured 2026-11-06

All commands run against Node v24.12.0 on this machine.

- `node -e` with no env file sees no `KOBOKU_*` key. `node --env-file=.env --env-file=.env.local` loads
  all five. `--env-file= is not allowed in NODE_OPTIONS`. `--env-file-if-exists` warns and continues
  when a file is absent (exit 0); plain `--env-file` on an absent file exits 9.
- Under `vite dev --port 3000`, with no `--env-file` in the script, the bridge's `loadConfig()`
  succeeded. `KOBOKU_PROVIDER_API_KEY` is the only key with no default, so this proves TanStack Start on
  Vite loads both `.env` and `.env.local` into `process.env` in dev. No KOBOKU_ variable is set in the
  process, user or machine environment, so nothing outside these files supplied the value.
- Failure mode measured rather than assumed: `loadConfig()` with only `.env` present throws
  `config: environment is not valid (KOBOKU_PROVIDER_API_KEY: Invalid input: expected string,
  received undefined)` — key names and rules, no value.
- The browser receives no harness code. The client copy of `src/agent.functions.ts` replaces the handler
  with `createClientRpc(<id>)`; the `loadConfig` and fake-provider imports are stripped. No module served
  to the browser contains the key, and `config.ts` carries the key names but never their values.
  `git check-ignore .env.local` exits 0.

### Gaps recorded at M0

- `strata.ts` sends `tool_call_id` on tool messages but does not yet send an assistant message that
  carries tool calls. Nothing produces one until the loop exists at M1.
- A request to a path with no route logs `notFoundError` on `__root__` and renders TanStack Router's
  generic Not Found; no `defaultNotFoundComponent` is configured. The offending path is still not
  identified. Ruled out from the browser network log: no `.ico` or robots request. The only non-2xx
  requests were TanStack Devtools' own `POST /__tsd/console-pipe` and `GET /__tsd/console-pipe/sse`,
  both 502, which makes them the strongest candidate but not a proven cause. Dev server log, 2026-11-06.
- Strata has never been contacted. `config.ts` now runs in the real server runtime, but no request has
  been sent to the model server. Deliberate: M2 reaches it once the loop exists.
- No loop, no tools, no jail, no traces. `HarnessEvent` is not defined; it arrives with the loop at M1.
