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
