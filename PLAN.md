# kōboku — architecture and build plan

The harness is the product. The UI is a client of it.

Status: M0, M1 and M2 complete, released as 0.0.1 and 0.0.2 (2026-11-06) and 0.0.3 (2026-11-08). M3 is
next. `CHANGELOG.md` records what exists; §6 below is the order.

---

## 1. Goal

A working agent that holds a conversation with a local model and executes the tools the model asks
for, with the message list, the loop, the tool definitions, the argument validation and the safety
boundary all written by hand rather than supplied by a framework.

Non-goals: shipping a product, matching a commercial harness, covering every feature.

Success measure: a completed run is fully accountable. Every line of a trace file is attributable —
what the model was told, what it asked for, what this code ran, what came back. And every exit test
below is deterministic: it passes on a repository with no model server running and no network.

---

## 2. Hard rules (invariants)

These hold at every milestone and are the reason later milestones stay cheap.

1. **`src/harness/` never imports TanStack, React, Vite or any framework.** The framework
   appears only in `src/routes/`, `src/components/` and `*.functions.ts` files. This keeps
   the loop testable without a browser and keeps "move the harness to another server later"
   a translation rather than an extraction.
2. **The harness core is a callable unit, and an async generator.** It accepts a message
   list plus tools and yields one event per iteration as it happens, rather than returning
   everything at the end. This is what makes live streaming available without a second
   code path.
3. **The provider is an interface with more than one implementation.** `strata.ts` (real)
   and `fake.ts` (scripted) satisfy the same interface. Every test uses `fake.ts`.
4. **The model is an untrusted source of work.** The model chooses paths, patterns, byte
   counts and tool names. Validation is therefore not only "are the types correct" but
   "is this request within budget". Budgets are enforced in code, never in the prompt.
5. **Nothing the browser may read goes through a static path.** Traces, workspace contents
   and provider configuration are reached only through server functions.
6. **Secrets stay server-side.** The provider key is read from `process.env` inside
   harness code. It never carries a `VITE_` prefix, never appears in a returned value, and
   never appears in a trace file.
7. **A tool failure is data, not a crash.** Tool errors are captured, described, and sent
   back to the model as a message. The loop continues and the model can change strategy.

---

## 3. Architecture

Three layers, one direction of dependency.

```
browser page  ->  server function (thin wrapper)  ->  harness core (framework-free)  ->  provider
                    type-safe RPC                          loop, tools, dispatch, jail
```

**Harness core.** Owns the agent loop: assemble the message list, call the provider, read
the stop reason, validate and execute any requested tool, append the results, repeat until
the model stops or a budget is reached. Framework-free and testable with no network.

**Bridge.** `*.functions.ts` files wrap harness calls in `createServerFn`. Streaming uses a
server function whose handler is an async generator, so each harness event arrives typed on
the client. No hand-built SSE transport and no server route needed for v1.

**UI.** A chat page and a trace inspector page. The pages render harness events; they hold
no agent logic.

**Provider.** One adapter per backend. v1 has `strata.ts` speaking the OpenAI-compatible
HTTP API, and `fake.ts` returning scripted responses for tests.

### Data model (defined in `src/harness/types.ts`)

- **Message** — one entry in the conversation: a role and content. Roles used in v1:
  system, user, assistant, tool.
- **ToolCall** — a request from the model to run a tool: an id the model invented, a name,
  and arguments. Note that providers deliver arguments as a *string* containing JSON, so
  parsing it is a distinct failure mode from the arguments being wrong.
- **ToolResult** — what our code produced for one ToolCall: the output, or a description of
  the failure, plus the matching id so the model can correlate it.
- **StopReason** — why the model stopped generating. The loop branches on this. v1 must
  handle at least: `stop`, `tool_calls`, `length`. Treating a truncated `length` response as
  success is a known and serious bug class.
- **HarnessEvent** — what the generator yields per iteration: model call started/finished,
  tool call requested, tool result, truncation warning, budget exhausted, run finished.
  This is what the trace file records and the UI renders.

---

## 4. Stack

| Layer | Choice | Role |
|---|---|---|
| Model server | Strata, local | Runs the quantised model, HTTP on `127.0.0.1:8080/v1`, context 262,144 / output 16,384 |
| Model | `qwen3.8-flash-next-iq3_xxs` | Heavily quantised local model; reasoning **off**, temperature **0** |
| Runtime | Node.js | Executes the server code. Dev and production target, fixed |
| Framework | TanStack Start | Routing, SSR, server functions, typed streaming, client/server build |
| UI | React | Chat page + trace inspector |
| Styling | Tailwind CSS + shadcn | shadcn components are copy-paste code under `src/components`, with Radix primitives beneath them |
| Language | TypeScript, full strict | Checks our code before it runs. Erased when it runs |
| Build / dev server | Vite | Replaces `tsx` for running the app |
| Server runtime layer | Nitro (Node preset) | Optional portability layer; Node target only in v1. Plugin under active development |
| Validation + budgets | **zod** | The harness core's only runtime dependency. Tool schemas, argument validation, `z.toJSONSchema()` |
| Tests | vitest | Golden transcripts and hardening scenarios |
| Lint / format | oxlint / oxfmt | Dev-only |
| Package manager | npm | pnpm is not on PATH on this machine |
| Provider types | hand-written | We define Strata's request/response shapes ourselves |
| Deliberately absent | `@tanstack/ai`, any LLM SDK, any agent framework | They would supply the loop this project implements |

Why zod earns its place: one schema per tool serves simultaneously as the JSON Schema sent
to the model and the validator applied to what the model returned. Written separately, the
two drift apart silently.

---

## 5. Structure

```
koboku/                       folder name is ASCII; prose spells the name kōboku
  README.md  CHANGELOG.md  PLAN.md  AGENTS.md   rules, plan and state only; rationale lives outside the repo
  src/
    harness/                framework-free. No Start or React imports in here.
      types.ts              Message, ToolCall, ToolResult, StopReason, HarnessEvent
      loop.ts               async generator. The agent loop.
      provider/
        provider.ts         the Provider interface. The seam everything depends on.
        strata.ts           real adapter. Hand-written request/response types.
        fake.ts             scripted provider for tests. Same interface as strata.ts.
      tools/
        registry.ts         declarations, lookup, budgets per tool
        read-file.ts
        write-file.ts
      dispatch.ts           validation + budget enforcement + execution + error capture
      jail.ts               canonical absolute path resolution, then containment check
      trace.ts              incremental JSON event writer
      config.ts             server-side environment only
    routes/                 Start routes: chat page, trace inspector
    components/
    agent.run.ts            caller half of a run: open the trace, drive the loop. Framework-free.
    agent.functions.ts      thin server-function wrappers: the only bridge
  test/                     golden transcripts, hardening scenarios
  workspace/                the jail. The only path tools may touch.
  traces/                   one JSON file per run. Never statically served.
```

---

## 6. Milestones

Each has an exit test. Work stops at each one for review: the diff, the passing test output, and one
real trace file read line by line.

| | Milestone | Exit test |
|---|---|---|
| **M0** | Scaffold Start. Wire strict `tsconfig`, vitest, oxlint, oxfmt, `.env` + `.env.example`, `.gitignore`, `git init`. Write `types.ts`, the `Provider` interface, `strata.ts`, `fake.ts`, `config.ts`. | A vitest test round-trips a canned reply through the interface. A server function called from the page returns that same canned reply. |
| **M1** | `loop.ts` as an async generator, against `fake.ts` only. No real model, no tools. Includes the case where the fake provider asks for a tool that does not exist: unknown tool names are a handled failure mode, not an unhandled branch. | Golden transcript: canned responses in, exact expected message list out. Iteration cap proven to stop a looping fake model. |
| **M2** | Loop wired into a streaming server function; browser renders iterations live. First real Strata calls. Includes `trace.ts` writing incrementally to `traces/`, pulled forward from M5 because this exit test reads a real trace file. | Tokens/iterations appear in the page as they happen. A real trace file exists and matches what the UI showed. |
| **M3** | `registry.ts` + `dispatch.ts` (validation **and** budgets) + `read_file`. Native function calling against Strata. | The model reads a file unprompted and answers a question about its contents. A quantised model invents parameter and tool names, so the exit test runs against `fake.ts` transcripts that reproduce invented names, and the real-model run is recorded rather than gated. |
| **M4** | `write_file` + `jail.ts`. | Attempts to escape the jail via `..`, an absolute path, or a symlink are rejected, and the rejection is reported to the model as data. |
| **M5** | A trace inspector page, reading what M2's writer already produces. | A bad run can be diagnosed from the UI alone: iterations, tool calls, tool results, stop reasons, durations, provider-reported token usage. |
| **M6** | Measurement spike — the performance gate. See section 8. | Five recorded measurements, before any decision about a different server. |
| **M7** | Hardening scenarios. | All green and repeatable: unparseable `arguments` string, valid-typed-but-nonsense arguments, tool raises, `length` truncation, iteration cap exhausted, jail escape attempts. |
| **M8** | Targeted edit tool: find a span and replace it, with budgets and a bounded matching strategy. | The model changes one line without reproducing the whole file. |

---

## 7. Safety boundaries

There is no interactive approval gate in v1. The jail is the safety boundary, and it is
enforced structurally rather than by instruction.

- **The jail.** Resolve to a canonical absolute path *first*, then compare against the
  resolved workspace root. A naive "does the path start with `workspace/`" check is bypassed
  by `..`, by absolute paths, and by symlinks.
- **Reads are capped by streaming.** `read_file` reads at most N bytes and stops; it does not
  load the file and then slice. Truncation is reported to the model explicitly, because a
  model that receives silently clipped text will confidently assert facts about content it
  never saw.
- **Budgets live in the tool contract**, alongside argument validation: max bytes, max depth,
  max results, per-call wall-clock deadline. A CPU-heavy tool with a hard cap is not
  CPU-heavy.
- **Dispatch treats a subprocess as a normal tool implementation.** Calling a function and
  spawning a program share the same interface, budgets, timeout, cancellation and error
  capture. Decided at M0 rather than retrofitted later.
- **Consequence of no gate:** the workspace folder is the blast radius. Nothing in v1 can
  reach outside it, and there is no shell tool.

---

## 8. Performance policy

The cost of an agent run is dominated by model inference. Estimates to be replaced by
measurements at M6.

| Stage | Expected cost |
|---|---|
| Server function: route, parse, validate, dispatch | sub-millisecond |
| Loopback HTTP hop to Strata | ~0.1–1 ms |
| File tool on a bounded file | ~0.1–1 ms |
| Model inference, one iteration | hundreds of ms to many seconds |
| Full run, 5–10 iterations | 10–120 s |

The failure modes that *can* add seconds, and the mitigations:

| Failure mode | Mitigation |
|---|---|
| A layer buffers the streamed response, so first-token latency becomes full-run latency | Fixed Node runtime. No edge/dev runtime for the streaming milestone. |
| CPU-bound tool work stalls the single event loop, delaying every other request | Budgets first, streaming-and-stop-early second, subprocess third, `worker_threads` last |
| Strata serialises concurrent requests | Measured at M6 before designing any multi-session behaviour |
| Windows process spawn cost and Defender scanning during filesystem traversal | Long-lived pooled processes; a Defender exclusion for `workspace/` |
| Local tokenisation paid on every iteration | Never local. Use the provider's reported `usage`. Characters÷4 only as a pre-call estimate, labelled as an estimate |
| Traces accumulated in memory and written at the end | `trace.ts` writes incrementally |

M6 measurements, all recorded in the trace data:

1. Total non-model time per run (harness overhead).
2. Same prompt direct from browser to Strata versus through the server function. The delta
   *is* the backend's cost, measured.
3. Parse/validate/serialise cost at a deliberately enormous context (~1M characters).
4. Head-of-line blocking: three concurrent runs with one deliberately CPU-bound fake tool.
5. Strata tokens per second, and whether a concurrent request queues behind another.

Language escalation ladder, only if the measurements justify it: Node → Bun (same code,
runtime swap) → native sidecar for the specific heavy tool → a separate harness server in
another language. Rewriting the whole server is the last option, not the first.

---

## 9. Deferred, deliberately

Interactive approval gate (pause the loop, persist state, resume). File search (arrives as a
ripgrep subprocess, not JavaScript traversal). Shell execution. Rebuild with `@tanstack/ai` as
a deliberate comparison so the mature harness can be diffed against ours. MCP. Subagents.
Context compaction and summarisation. Embeddings and semantic search. Multi-session and
multi-user. Hosted or serverless deployment — note that file tools and the jail cannot work
on a serverless host at all. Streaming through `@tanstack/ai`'s client (coupled to its
server, so not a partial adoption).

---

## 10. Standing defaults

- Max iterations per run: **8**. Lives as the loop's own parameter — `runAgent({ maxIterations })`,
  default `DEFAULT_MAX_ITERATIONS` in `loop.ts` — not as an environment key. Decided at M1.
- Tool output cap: **800 lines / 20,000 bytes**, truncation reported
- Temperature: **0**. Reasoning: **off** (a config flag, enabled later deliberately)
- System prompt: short, in its own file, versioned separately so it can be experimented on
- One git commit per milestone
- Single-user, local-only, in-memory session state
