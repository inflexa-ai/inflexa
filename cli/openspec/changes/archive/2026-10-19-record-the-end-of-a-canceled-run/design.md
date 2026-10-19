# Design

## Context

The cancel route (`src/server/routes/runs.ts`) builds one harness run canceler for each pool in `DEFAULT_RUN_ROUTES_OPTS.cancelRun`, with the noop run charge and the local run authorizer. It passes no `ProvenanceSeam`. The route runs under `analysisGuard`, thus in the process that holds the lock of the analysis and its recorder.

The boot installs one provenance seam for each runtime (`installProvenanceSeam`, `src/modules/harness/runtime.ts`), and `provenanceSeam()` reads it. Each boot makes a new pool, thus the canceler of a pool sees the seam of its boot.

The harness change of the same name adds `provenance?: ProvenanceSeam` to `RunCancelerDeps`, and it widens the session parameter of the run emit to `AgentSession`.

## Goals / Non-Goals

**Goals:**

- The canceler of the cancel route gets the installed `ProvenanceSeam`.
- A test pins that binding.

**Non-Goals:**

- A change to the bridge, the agent switch, the activity time, or the recorder. Each reads the events already.
- A change to the TUI. The abort path of issue #250 does not change.

## Decisions

**Read the seam when the canceler is made.** `cancelRun` makes the canceler at the first cancel of a pool, with `provenance: provenanceSeam()`. This is the pattern of `buildExecuteAnalysisDeps` (`src/modules/harness/run_deps.ts`). The route needs the runtime (`runtimeGate`), thus the boot installed the seam before the first cancel. The run emit of the seam is the stable delegating handle of the boot, thus a later model switch reaches it with no new canceler.

**A named builder for the deps of the canceler.** A function in `src/server/routes/runs.ts` makes the deps of the production canceler from the pool. It gives the noop run charge, the local run authorizer, and the installed `ProvenanceSeam` when one exists. `cancelRun` uses it. Thus a test can pin the binding with no database. The production canceler itself makes a DBOS client at its first engine cancel, and the cli suite runs with no database.

## Risks / Trade-offs

- [No offline test runs a cancel through the route to the signed document.] → The builder test pins the binding. The harness tests cover the emits of the canceler. The bridge, agent-switch, and recorder tests cover the consumers of the events.
