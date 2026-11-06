# kōboku

**kōboku** is a local, single-user agent harness in TypeScript, with a chat page in the browser.

An agent harness is the layer between a language model and a machine: the model asks for something
to be done, the harness does it and reports back, and the conversation continues from there. kōboku
writes that layer itself rather than taking it from a framework.

- **local** — the model server runs on this machine;
- **single-user** — one session at a time;
- **bounded** — the agent can only touch what the harness lets it touch;
- **run records** — every run is recorded, and the recorded run can be reviewed in the page.

Tool-by-tool detail lives in the code and in `CHANGELOG.md` as tools are implemented, not here.

**No code exists yet.** Implementation starts at M0 (PLAN.md, section 6).

## In this repository

1. **AGENTS.md** — the binding rules: repository scope, commit convention, the architecture
   invariants that hold at every milestone, toolchain and testing rules.
2. **PLAN.md** — the architecture, the invariants, the stack, the file layout, and the M0–M8
   milestone plan with exit tests.
3. **CHANGELOG.md** — what the app is at the current point in time.

Rationale, naming research, logo work and reference notes are kept **outside** this repository. This
repository holds the rules and the code, not the arguments behind them.

**kōboku** is the name of the app. Prose uses **kōboku**; the folder, package name and repository
name use ASCII **`koboku`**. Pronounced koh-BOH-koo.
