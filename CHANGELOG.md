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

### Added

- `src/harness/trace.ts` writes the run trace: one file per run into git-ignored `traces/`, one JSON
  record per line, appended the moment the event happens instead of collected and written at the end.
  The first line names the run and the model; every line after it is a harness event as it was
  yielded — the model's own `tool_call_id`, its `arguments` string still unparsed, and the
  provider-reported token counts. A run id that would place the file outside `traces/` is refused
  before anything is created. Recorded 2026-11-08 as the first step of M2: the writer was pulled
  forward from M5 because M2's exit test reads a real trace file, and M5 keeps the inspector page.
- Measured 2026-11-08: `test/trace-writer.test.ts`, 6 tests — one file per run with its own header;
  each event already on disk while the run is still in progress, proven by the scripted provider
  having been asked nothing at the moment asserted rather than by a clock; a cut-off `arguments`
  string recorded byte for byte and still unparseable; eight run ids refused (`../escaped`,
  `..\escaped`, `a/b`, `a\b`, `..`, `.`, an empty id, `C:evil`) with nothing written outside the
  directory; the directory created when absent; and the standing `traces/` default.
  `npm run test` → 5 files, 25 tests passed in 335 ms with no model server and no network;
  `npm run typecheck` → exit 0; `npm run lint` → exit 0.
- `runAgent` now records its own events. `RunOptions` accepts an optional trace: the caller opens it,
  because the caller decides which run this is, and the loop fills it. An event is written before it is
  handed to the consumer, so a caller that stops consuming early still leaves a record of everything
  that had already happened, and a sink that cannot write ends the run instead of letting it continue
  unrecorded. The sink is imported as a type, so the loop still has no runtime dependency on the
  filesystem.
- Measured 2026-11-08: `test/loop-trace-sink.test.ts`, 4 tests — the file holds the header plus all
  seven events in order; two events the caller discarded are still on disk; a sink that throws stops
  the run with zero provider calls spent; and the same scripted run, watched and unwatched, yields the
  identical event list. `npm run test` → 6 files, 29 tests passed in 319 ms with no model server and no
  network; `npm run typecheck` → exit 0; `npm run lint` → exit 0.
- `src/agent.run.ts` is the caller half of a run, and it has no framework in it: it opens a trace,
  drives `runAgent` and hands each `HarnessEvent` to the caller as the loop produces it, and its
  return value is a plain `RunSummary` — run id, finish reason, iterations, summed
  provider-reported usage and the last assistant text. The trace path is deliberately not
  returned: a browser must not learn where the server keeps its files. The provider is still the
  scripted one, so this step proves the composition rather than the model.
- `src/agent.functions.ts` has a second server function, `startRun`, whose handler is an async
  generator (`return yield* streamRun(data.prompt)`), so a page consumes it with `for await` and
  sees each iteration while the run is still going. It is the only request in the project with a
  validator: `z.object({ prompt: z.string() })`. The bridge exports server functions and types and
  nothing else. That boundary is a measurement, not a preference: the body of a server function
  stays on the server, but a plain function **exported** from a bridge file is served to the browser
  together with everything it imports. With `runRecorded` exported from the bridge the browser was
  served `src/harness/trace.ts` and the page failed with `Module "node:fs" has been externalized for
  browser compatibility. Cannot access "node:fs.appendFileSync" in client code`. After the split, the
  same request for the same file returned 35 lines: two framework imports and two call stubs, no
  harness import and no `node:fs`. Measured 2026-11-08 with the generator handler in place, the same
  request now returns 29 code lines, still two framework imports, no `agent.run`, no `openTrace` and
  no `node:fs`: a handler body stays server-side even when it is a generator and even when the
  validator is a zod schema.
- Measured 2026-11-08 on the call site, with a throwaway probe file that was then deleted: the page
  side of `startRun({ data: { prompt: 'a prompt' } })` typechecks, and its type is
  `Promise<AsyncGenerator<HarnessEvent, RunSummary, void>>` — events and the closing summary, which
  `for await` discards and a hand-driven `next()` loop keeps. A wrong shape is refused before
  anything runs: `{ data: { nope: 1 } }` gives "Object literal may only specify known properties, and
  'nope' does not exist in type '{ prompt: string; }'", and `{ data: 'a prompt' }` gives "Type
  'string' is not assignable to type '{ prompt: string; }'".
- `src/routes/index.tsx` gained a run section: a prompt box, a button, and one rendered line per
  event as it arrives, read from the stream with `for await`.
- Measured 2026-11-08 in the running dev server (`npm run dev`, port 3000, Chromium): one click on
  `start the run` produced one `POST /_serverFn/…` whose response carried `content-type:
  application/x-tss-framed; v=1` and `transfer-encoding: chunked`, and the page rendered, in order,
  `iteration 1: asking the model`, `iteration 1: stop stop, 0 tool calls, tokens 0/0`, `run closed:
  model_stop after 1 iteration(s), total tokens 0/0`, with no console error. The run left
  `traces/run-mw8k027w-svsobljn.jsonl` written at 16:59:29 with four records — `run_header`, then the
  same three events the page rendered. Measured the same way, an earlier run whose page consumer threw
  left a complete four-record trace behind: the file does not depend on how the run is consumed.
- Measured 2026-11-08, and it contradicts the type: what `startRun` hands the caller is an async
  iterable, not a generator — `[object AsyncGenerator]`, `typeof next: undefined`, `typeof return:
  undefined`, `typeof Symbol.asyncIterator: function`, no own keys, prototype `null`. Only yielded
  values cross the wire: three arrived, no fourth. So `for await` is the only way to read it, and the
  handler's return value — `RunSummary` — reaches no one yet, which is why the page shows no run id
  and no final assistant text.
- Measured 2026-11-08: the served modules stay clean on both sides of the split. `GET
  /src/agent.functions.ts` returns 33 code lines: two framework imports, no `agent.run`, no
  `openTrace`, no `node:fs`. The route's component chunk imports `/src/agent.functions.ts` and React
  and nothing under `src/harness/` — the `HarnessEvent` import is type-only and compiles away.
- Measured 2026-11-08 in the running dev server (`npm run dev`, port 3000, Chromium): the page
  calls `getCannedReply`, renders `the canned reply` with `model qwen3.8-flash-next-iq3_xxs`, and
  the console holds no error. `loadConfig` reads `process.env` and `npm run dev` passes no env
  file, and `loadConfig` refuses to return without the API key — so a rendered page is also the
  proof that the standing configuration, key included, reaches the server runtime as the dev
  script stands. No test reads that key.
- Measured 2026-11-08: `test/bridge-run.test.ts`, 6 tests — a whitespace-only prompt refused, and
  proven to refuse on the first `next()` because an async generator body does not run at the call,
  with the directory listed before and after showing no new file; events handed over one at a time
  with the trace already two records ahead while the caller holds only the first, in the order
  `model_call_started`, `model_call_finished`, `run_finished`, and the summary arriving as the
  `done` result rather than as a fourth event, at the same path the mid-run file had; one spoken
  iteration reported as `model_stop` after 1 iteration with the scripted zero counts; a trace written
  into `traces/` by the loop itself, header first and `run_finished` last, four records for one
  spoken iteration; the generated run id accepted by the trace guard; and a summary with no path in
  it. `npm run test` → 7 files, 35 tests passed in 444 ms with no model server, no network and no
  browser; `npm run typecheck` → exit 0; `npm run lint` → exit 0. The suite deletes every trace file
  it writes — measured: 0 files left in `traces/` afterwards.
- Gaps recorded at this step: the writer records no timestamps or durations, so M5's "durations"
  clause is still unmet; one open-write-close per event is a cost that has been accepted here and
  measured nowhere, which is an M6 measurement; the stream carries harness events only, so `runId` and
  the final assistant text are on the server and not in the page; a rejected request — a prompt field
  that is missing or not a string — has been refused at compile time but never observed from the page;
  "as they happen" is proved in order, not in wall-clock time, because the scripted provider answers
  all three events at once and no separated paint has been measured — that needs a real model call;
  and a run id is built from the clock and randomness, with nothing checking that two runs cannot
  collide.

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
