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
inspector page. A completed milestone leaves this heading and becomes its own versioned section, so
what is built is listed there and not here; what remains under this heading is work that has not yet
been released.

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

## 0.0.4 — 2026-11-08 — M3

A run can now be given tools. The harness keeps the list of tools it has, validates and bounds every
call the model asks for, and confines filesystem work to one directory it resolves before anything is
opened. `read_file` is the first tool a real run could use, and a real run used it unprompted.

### Added

- `src/harness/tools/registry.ts` — the tool contract, and the only place that knows which tools this
  harness has. Budgets belong to a tool's declaration rather than to each call, so a caller cannot ask a
  tool for more than its own record permits; `deadlineMs` is required, the other three budgets are
  optional. Construction refuses a duplicate name, a name outside a closed set of at most 64 characters,
  and an arguments schema that is not an object schema. It stores the strict version of every arguments
  schema, measured 2026-11-08 with node v24.12.0 against the installed zod 4.6.7: parsing an invented key
  against a plain object schema succeeds and silently drops it, while the JSON schema published from that
  same schema tells the model extra properties are not accepted. A tool carries its own `execute`.
- `src/harness/jail.ts` — resolve first, then contain. The root is canonicalised at open, so a workspace
  reached through a link and one reached directly are the same jail, and a root that cannot be opened
  raises there instead of producing a jail that quietly refuses everything. A candidate path is
  canonicalised through the nearest ancestor that exists, which makes *where a path would land* answerable
  before anything is opened; containment is then checked against the canonical root, case-insensitively on
  Windows because the filesystem there is. An empty candidate and a path containing a NUL byte are refused,
  and a refusal names the workspace it was refused against.
- `src/harness/tools/read-file.ts` — `read_file`, built on a jail and impossible to construct without one.
  It asks the filesystem for at most the byte budget rather than reading a file whole and slicing it; it
  reserves the bytes of its own truncation notice out of that budget before keeping any file content; it
  cuts at a UTF-8 character boundary rather than at a byte; it closes the descriptor in `finally`; and it
  reports truncation only when the file really is larger. Measured 2026-11-08: with the notice left
  unreserved, a 101-byte budget produced a 296-byte result.
- `src/harness/dispatch.ts` — one path from a model asking for a call to the model reading an answer, with
  five failure modes and each one ending as a result the model can read: an unknown name, an `arguments`
  string that is not parseable JSON, a well-formed object naming parameters the tool does not accept, a
  call that outlives its deadline, a tool that raises. Parse failure and invalid arguments are kept apart
  because a model needs different corrections for them, and the refusal for an invented parameter names the
  accepted parameters read back out of the same JSON schema the model was shown. The deadline is armed from
  the tool's own `deadlineMs` and the report quotes that same number; the report also says the tool *may
  still be running*, because the harness stopped waiting rather than stopped the tool. Every result,
  refusal included, carries the model's own `tool_call_id`. The byte cap is applied last, with the sentence
  that reports the cap put on top of the capped text.
- `src/harness/loop.ts` — a run is given a registry, and the tool list sent to the provider is
  `registry.definitions()` in declaration order rather than a hardcoded empty list. The interim
  unknown-name branch left the loop and became dispatch's, its wording kept verbatim so the M1 golden
  transcripts still pass unchanged.
- `src/harness/config.ts`, `.env`, `.env.example` — `KOBOKU_WORKSPACE_DIR`, default `workspace`, validated
  with the rest of the environment. The value is left as written: `openJail` canonicalises whatever root it
  is handed, and a second place that knows about paths is a second place that can disagree.
- `workspace/` — the directory the jail resolves over, tracked only through an empty `.gitkeep`. Everything
  written inside it is gitignored: `git check-ignore -v workspace/notes.txt` reported `.gitignore:22` and
  exited 0, measured 2026-11-08.
- App wiring — `streamRun` takes an optional registry and forwards it to the loop, building none of its own;
  the `startRun` handler opens the jail over `config.workspaceDir` and hands the loop a registry holding one
  tool. The jail and the reader are used inside the handler body and never exported, which is the boundary
  rule the bridge file already records.
- `PLAN.md` — the M3 row now names `jail.ts`, and the M4 row carries `write_file` alone.

### Fixed

- `src/harness/tools/registry.ts` carried a comment saying dispatch did not exist yet and that nothing
  called `execute`. Both had been untrue since the loop started dispatching. The comment now says what
  dispatch actually hands a tool: a deadline armed from the tool's own `deadlineMs` and the budgets copied
  from its own declaration. Its own commit, no behaviour change.

### Tests

- `test/tool-registry.test.ts`, 10 tests — lookup by exact name carrying its own budgets; an invented name
  answered with `undefined` rather than a throw; budgets per tool rather than a shared default; descriptors
  produced in declaration order; descriptors built once so a schema that cannot be serialised fails at
  startup; an empty registry accepted; the validated description kept rather than the raw one; a strict
  arguments schema stored so an invented parameter is refused not dropped; a bad declaration refused with
  the tool it refused named; the same name declared twice refused.
- `test/jail.test.ts`, 10 tests — a relative path resolved to a canonical absolute path inside the
  workspace; `..` refused; an absolute path outside refused; an absolute path already inside accepted; a
  link pointing out refused; a path that does not exist yet resolved when it would land inside; the root
  itself treated as inside; a candidate that is not a path refused; a root that cannot be opened refused
  rather than quietly refusing everything; a differently cased path refused as a way round.
- `test/read-file-tool.test.ts`, 7 tests — a real file read end to end from the `arguments` string a
  provider sends. It is the only test file that reads a file through the tool itself, and every file it
  touches lives in a temp directory it creates and removes. A path outside the workspace refused with the
  boundary named; a link out refused; a missing file and a directory both reported; at most the byte
  budget read, with the cut named in the text the model sees; a multi-byte character not cut in half; and
  the tool accepted by the registry with the schema a model is shown. Measured on Windows, opening a
  directory fails before the read, so a directory reports "could not be opened" and the test asserts that
  wording.
- `test/tool-dispatch.test.ts`, 10 tests — a call run with the arguments already parsed and validated; the
  tool handed its own budgets; an undeclared name refused while naming the tools that do exist; an empty
  registry saying plainly that nothing is wired up; "I could not read it" kept separate from "that is not
  what it takes"; an invented parameter refused rather than run with it quietly dropped; a tool that raises
  turned into a result; a call that outlives its own deadline proved with no clock involved; output capped at
  the declared byte budget with the cap reported; output left alone when no byte budget is declared.
- `test/loop-registry-tools.test.ts`, 6 tests — the declared tools with their argument schemas handed to
  the provider; a call run and its output handed back as a tool message; an invented tool name and an
  invented parameter refused with the refusal readable to the model on the next call; invented arguments
  refused on a tool that does exist, before it runs; unparseable arguments reported as their own failure;
  and the pre-tools behaviour intact — every call answered as unknown — when no registry is given. These are
  the transcripts PLAN.md §6 names for a quantised model that invents names.
- `test/config.test.ts`, 4 tests — the workspace default; a named directory passed through unchanged,
  relative or absolute; an empty directory refused with the key named; and the provider key still required,
  so a new defaulted key cannot smuggle in a missing credential.
- `test/bridge-run.test.ts`, 8 tests, two of them new — a declared tool reaching the provider request and
  its result coming back as a tool result with the final answer after it; and no tools declared at all when
  the caller hands in no registry.
- Both new groups were proved non-vacuous by deliberate breakage, then restored before committing: changing
  the config default to another value failed with `expected 'other-dir' to be 'workspace'`; removing the
  registry forward failed with `expected [] to deeply equal [ 'read_file' ]`.
- Gates as this milestone closed, measured 2026-11-08 at 18:54: `npm run test` → 13 files, 84 tests in 710 ms
  with no model server, no network and no clock-dependent assertion; `npm run typecheck` → exit 0; `npm run
  lint` → exit 0. `traces/` held 17 files both before and after the suite ran, so it added none and left no
  new one.

### Exit test, both halves

- **Scripted half.** The invented-name and invented-parameter cases PLAN.md §6 requires are recorded at
  `test/loop-registry-tools.test.ts:96` and `test/loop-registry-tools.test.ts:134`, and the same failures at
  the dispatch seam alone at `test/tool-dispatch.test.ts:73` and `test/tool-dispatch.test.ts:110`. All green.
- **Real-model half, recorded rather than gated.** Measured 2026-11-08 in the running app (`npm run dev`, port
  3000, Chromium), prompt typed into the page: `What number is kept in notes.txt?` The number 7311 appears
  only inside `workspace/notes.txt`, which is gitignored and was never committed, so a model that reports it
  read the file. Two runs are recorded, because the page was driven more than once:
  - `traces/run-mw8ngyrb-x785vq8c.jsonl`, 1023 bytes written 18:36:40, eight records — `run_header` for model
    `qwen3.8-flash-next-iq3_xxs`; iteration 1 finished with `stopReason: tool_calls`, one call, usage 358/44;
    `read_file` asked for `{"path":"notes.txt"}`; the tool result carries the model's own
    `tool_call_id` `call_741738e9f6d5465a90d01fed`, the file text, and `isError: false`; iteration 2 finished
    with `stopReason: stop`, 0 calls, usage 454/40; `run_finished` with `model_stop` after 2 iterations and
    totals 812/84.
  - `traces/run-mw8nkbbl-7abh2gir.jsonl`, 782 bytes written 18:39:44 — the same eight records, usage 358/59
    then 454/37, totals 812/96, `model_stop` after 2 iterations.
- The page rendered the same numbers, read out of the browser at 18:43: `iteration 1: read_file asked for
  {"path":"notes.txt"}`, `iteration 1: read_file returned …7311…`, `iteration 2: stop stop, 0 tool calls,
  tokens 454/37`, `run closed: model_stop after 2 iteration(s), total tokens 812/96`, and the final answer
  `The number kept in notes.txt is **7311**`. No console error. The harness contributed no token numbers of
  its own.
- Measured alongside it: `GET http://127.0.0.1:8080/v1/models` without credentials answers `401 Unauthorized`,
  so a completed and authenticated run is proof the standing configuration — key included — reached the server
  runtime, `KOBOKU_PROVIDER_API_KEY` being the only config value with no default. And
  `git check-ignore -v workspace/notes.txt` reported `.gitignore:22` and exited 0: the file the model read
  never entered the repository.

### Gaps recorded at M3

- The handler that opens the jail is guarded by no test. No test may reach the model server, so the wiring is
  proven by the two recorded runs and by nothing automated.
- `maxResults` and `maxDepth` are declared budgets no tool consumes yet.
- There is no per-call budget override: a model cannot ask for a different byte budget, and cannot raise one.
- A deadline stops the harness waiting, not the tool. Nothing cancels a tool that keeps running past its
  `deadlineMs`, and the report says so rather than implying it did.
- Two runs share one workspace root with nothing deciding what happens when one writes a file another has
  read. `write_file` makes that live at M4.
- Opening a jail costs one `realpathSync` per run request. Measured nowhere, which is an M6 number.
- The wording for a directory differs by system: on Windows the open fails first and the model reads "could
  not be opened". Asserted for this platform, observed on no other.
- A trace records no per-tool duration, so a slow call is visible only as part of the iteration it belongs to.
- The workspace root has no in-app knob: changing it means editing the environment and restarting.

## 0.0.3 — 2026-11-08 — M2

A run is started from the page, reaches the local model server through the real adapter, streams its
iterations back as they happen, and leaves a trace file that says the same thing the page said. Both
halves of the exit test were measured in the running app.

### Added

- `src/harness/trace.ts` writes the run trace: one file per run into git-ignored `traces/`, one JSON
  record per line, appended the moment the event happens instead of collected and written at the end.
  The first line names the run and the model; every line after it is a harness event as it was
  yielded — the model's own `tool_call_id`, its `arguments` string still unparsed, and the
  provider-reported token counts. A run id that would place the file outside `traces/` is refused
  before anything is created. The writer was pulled forward from M5 because this exit test reads a
  real trace file, and M5 keeps the inspector page.
- `runAgent` records its own events. `RunOptions` accepts an optional trace: the caller opens it,
  because the caller decides which run this is, and the loop fills it. An event is written before it
  is handed to the consumer, so a caller that stops consuming early still leaves a record of
  everything that had already happened, and a sink that cannot write ends the run instead of letting
  it continue unrecorded. The sink is imported as a type, so the loop still has no runtime dependency
  on the filesystem.
- `src/agent.run.ts` is the caller half of a run, with no framework in it: it opens the trace, drives
  `runAgent`, hands each `HarnessEvent` to the caller as the loop produces it, and closes the stream
  with the run's `RunSummary` — run id, finish reason, iterations, summed provider-reported usage and
  the last assistant text — yielded as a value tagged `run_summary` rather than returned. Plain data,
  and deliberately no trace path: a browser must not learn where the server keeps its files. The
  provider and the configuration are handed in by the caller, which is what lets the tests run against
  `fake.ts` while the page runs against Strata through the same composition.
- `src/agent.functions.ts` gained `startRun`: a POST server function whose handler is an async
  generator delegating to that composition, with `z.object({ prompt: z.string() })` validating the
  request before any run exists. The bridge exports server functions and types and nothing else. That
  boundary is a measurement, not a preference: the body of a server function stays on the server, but
  a plain function **exported** from a bridge file is served to the browser together with everything
  it imports. With the composition exported from the bridge the browser was served
  `src/harness/trace.ts` and the page failed with `Module "node:fs" has been externalized for browser
  compatibility. Cannot access "node:fs.appendFileSync" in client code`. In its final shape the same
  request returns 45 code lines — two framework imports and two call stubs — with no `agent.run`, no
  `trace.ts`, no `provider/strata.ts`, no `config.ts` and no `process.env` anywhere in what the browser
  is given.
- `src/routes/index.tsx` has a run section: a prompt box, a button, and one rendered line per value as
  it arrives, read with `for await`.

### What the streaming wire turned out to carry, measured 2026-11-08

- What `startRun` hands the caller is an async iterable, not a generator: `[object AsyncGenerator]`,
  `typeof next: undefined`, `typeof return: undefined`, `typeof Symbol.asyncIterator: function`, no
  own keys, prototype `null`. Only yielded values cross — three events arrived with no fourth value —
  so `for await` is the only way to read it, and a summary returned by the handler reached no one.
  That is why `RunSummary` is a yielded, tagged last value. Each run is one `POST /_serverFn/…` whose
  response carries `content-type: application/x-tss-framed; v=1` and `transfer-encoding: chunked`.
- The validator is what makes a call possible at all, and the compiler is the gate. With no validator
  `startRun({ data: 'a prompt' })` is refused with "Type 'string' is not assignable to type
  'undefined'"; with the zod object it typechecks, and a wrong shape is refused before anything runs —
  `{ data: { nope: 1 } }` gives "Object literal may only specify known properties, and 'nope' does not
  exist in type '{ prompt: string; }'". Measured with throwaway probe files, then deleted.
- `loadConfig` reads `process.env` and `npm run dev` passes no env file, and it still works: the page
  renders `model qwen3.8-flash-next-iq3_xxs`, and `loadConfig` refuses to return without the API key,
  so a rendered page is proof that the standing configuration, key included, reaches the server
  runtime as the dev script stands. `GET http://127.0.0.1:8080/v1/models` with no credentials answers
  `401 Unauthorized`, which is how the model server was confirmed to be listening without sending it a
  key. No test reads that key.

### Tests

- `test/trace-writer.test.ts`, 6 tests — one file per run with its own header; each event already on
  disk while the run is still in progress, proven by the scripted provider having been asked nothing at
  the moment asserted rather than by a clock; a cut-off `arguments` string recorded byte for byte and
  still unparseable; eight run ids refused (`../escaped`, `..\escaped`, `a/b`, `a\b`, `..`, `.`, an
  empty id, `C:evil`) with nothing written outside the directory; the directory created when absent;
  and the standing `traces/` default.
- `test/loop-trace-sink.test.ts`, 4 tests — the file holds the header plus all seven events in order;
  two events the caller discarded are still on disk; a sink that throws stops the run with zero
  provider calls spent; and the same scripted run, watched and unwatched, yields the identical event
  list.
- `test/bridge-run.test.ts`, 6 tests — a whitespace-only prompt refused on the first `next()`, because
  a generator body does not run at the call, with the directory listed before and after showing no new
  file and `provider.calls` empty; values handed over one at a time with the trace already two records
  ahead while the caller holds only the first, in the order `model_call_started`,
  `model_call_finished`, `run_finished`, `run_summary`, and nothing left in the generator's return; one
  spoken iteration reported as `model_stop` with the scripted zero counts, and the trimmed prompt read
  back out of `provider.calls[0].messages[0].content`; a trace written into `traces/` by the loop
  itself, header first and `run_finished` last, four records for one spoken iteration; the generated
  run id accepted by the trace guard; and a summary with no path in it.
- Gates as this milestone closed: `npm run test` → 7 files, 35 tests in 375 ms with no model server, no
  network and no browser; `npm run typecheck` → exit 0; `npm run lint` → exit 0. The suite deletes
  every trace file it writes — measured: 0 files left in `traces/` afterwards.

### Exit test, both halves

Measured 2026-11-08 in the running app (`npm run dev`, port 3000, Chromium), one click starting one
real run:

- **Iterations and tokens appear in the page as they happen.** 125 ms after the click the page held
  only `iteration 1: asking the model`, its button read `running`, and `run closed` was not on screen:
  the model was still answering. The page then rendered `iteration 1: stop stop, 0 tool calls, tokens
  62/107`, `run closed: model_stop after 1 iteration(s), total tokens 62/107`, then the run id and the
  final text, with no console error.
- **A real trace file exists and matches what the UI showed.** The run id the page displayed is the
  file name: `traces/run-mw8kd2l3-ozxqurop.jsonl`, 376 bytes written at 17:09:39, holding `run_header`
  for model `qwen3.8-flash-next-iq3_xxs`, `model_call_started` at iteration 1, `model_call_finished`
  with `stopReason: stop` and usage 62/107, and `run_finished` with `model_stop` after 1 iteration and
  the same 62/107 totals. The harness contributed no numbers of its own.
- Measured alongside it: a run whose consumer broke still left a complete trace. The earlier
  `stream.next is not a function` failure left `traces/run-mw8jjtyv-lc3ngw19.jsonl` holding all four
  records.

### Gaps recorded at M2

- Nothing guards a bridge file against exporting a plain function. `npm run test`, `npm run typecheck`
  and `npm run lint` all passed while the page was broken by exactly that, and no test catches it.
- The trace records no timestamps or durations, so M5's "durations" clause is still unmet; one
  open-write-close per event is a cost accepted here and measured nowhere, which is an M6 measurement.
- A request rejected by the validator has been refused at compile time but never observed from the
  page.
- Nothing stops a run when its consumer goes away: measured above, the server finished a run that
  nobody was reading.
- Nothing reads a trace file back yet, and no size budget bounds what a trace may grow to.
- A run id is built from the clock and randomness, with nothing checking that two runs cannot collide.

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
