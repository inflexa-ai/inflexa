# harness-durable-runtime Specification

## Purpose

Defines the harness runtime architecture: how the same agent loop runs in two
execution modes, how durable work is composed and scheduled, how it survives
host restarts, and where the line between open-source core and a managed
embedder is drawn.

The shaping decision is that **chat is not a workflow**. Chat turns are
short-lived and bounded by user attention; if a host process dies mid-turn the
user re-sends the message, so paying the DBOS write tax (a workflow row plus a
step row per LLM/tool call) for every turn buys little. Only the operations the
user has explicitly asked to be durable — analyses, target assessments,
data-profile, and ephemeral exploration — run as DBOS workflows, started from
tools and independent of the chat turn that triggered them. The single
`runAgent` primitive runs in both contexts: in-process behind a no-op
`passthroughStep` for chat, and behind a `durableStep` that wraps each call as a
named `DBOS.runStep` inside a workflow body. The loop body never imports DBOS.

Composition is centralized. `assembleCoreRuntime` is the one host-neutral
assembly point: it registers the durable workflows and builds the conversation
agent over the registered callables, in a load-bearing order. Dependencies are
split by lifetime — construction-time collaborators (`Pool`, providers, logger,
sandbox factories, seam realizations) are injected when a module is built;
call-time values (`Session`, `AbortSignal`, `EmitFn`) are passed as explicit
parameters. There is no `AsyncLocalStorage`, no magic-key bag, and no ambient
accessor: a module's dependency list is its factory signature.

The runtime is a host-agnostic library behind a small set of injected capability
seams, runnable with filesystem/no-op defaults; each deployment is an embedder
that wires concrete realizations at the composition root and core never branches
on which realization is bound. Durable scheduling is dependency-gated rather
than wave-batched — each child workflow starts the moment its `depends_on` steps
complete, with fail-fast sibling cancellation — and it is written to replay
deterministically under DBOS recovery. Recovery itself rides a host-supplied
stable executor identity, with no standing recovery component or HTTP route in
core.
## Requirements
### Requirement: Chat runs in-process; durable operations run as DBOS workflows

Chat turns SHALL run in-process, single-replica per turn, with no workflow or
step rows. User-named long operations (`executeAnalysis`,
`executeTargetAssessment`, the data-profile task, and `runEphemeral`) SHALL run
as DBOS workflows started from tools and SHALL be independent of the chat turn
that triggered them. The same `runAgent` body SHALL serve both modes through an
injected `RunStep` — `passthroughStep` in chat, `durableStep` inside workflow
steps.

#### Scenario: A tool starts a workflow that outlives the chat turn

- **GIVEN** a chat turn whose agent dispatches `execute_plan`
- **WHEN** the tool launches the `executeAnalysis` workflow
- **THEN** the workflow runs independently of the in-process chat turn and continues if the turn ends

#### Scenario: A pod death mid-turn does not lose durable work

- **GIVEN** a chat turn that has already started a durable workflow
- **WHEN** the host process dies mid-turn
- **THEN** the user re-sends the message and the already-running workflow is unaffected

### Requirement: The durable RunStep adapter wraps calls as named DBOS steps

The harness SHALL provide a `durableStep` satisfying the `RunStep` seam
(`<T>(name, fn) => Promise<T>`) that executes `fn` as a `DBOS.runStep` named
`name`. The loop body SHALL remain unaware of DBOS, depending only on the
`RunStep` shape. The step name is the replay cache key (see the harness-agent-loop spec)
and SHALL NOT be reformatted at the adapter.

#### Scenario: durableStep runs the function as a named step

- **GIVEN** a launched runtime inside a workflow context
- **WHEN** `durableStep("llm-0", fn)` is invoked
- **THEN** `fn` runs as a DBOS step recorded under the name `llm-0`

### Requirement: assembleCoreRuntime is the single host-neutral composition root

`assembleCoreRuntime` SHALL be the one assembly point that registers the durable
workflows with DBOS AND builds the conversation agent over the registered
callables. Registration order SHALL be preserved because the parent's child
dispatch closes over the registered child callable: the sandbox-step workflow
SHALL register before `executeAnalysis`, which receives that callable. All
workflows SHALL register in this one call before `launchDbos`, so they land under
one `applicationVersion` cohort.

#### Scenario: The parent workflow is built over the registered child callable

- **WHEN** `assembleCoreRuntime` runs
- **THEN** the sandbox-step workflow is registered first
- **AND** `executeAnalysis` is built with the registered sandbox-step callable, not a pre-built one

### Requirement: Dependencies are split by lifetime with no ambient lookups

The runtime SHALL inject construction-time dependencies (`Pool`, `ChatProvider`,
`EmbeddingProvider`, logger, sandbox factories, seam realizations) when a module
is built. Call-time values (`Session`, `AbortSignal`, `EmitFn`) SHALL be passed
as explicit parameters. The runtime SHALL NOT use `AsyncLocalStorage`, a
magic-key context bag, or module-level ambient accessors for dependencies.
Modules SHALL be factory closures whose dependency list is their factory
signature.

#### Scenario: A module declares its dependencies in its factory signature

- **GIVEN** a module that needs the connection pool
- **WHEN** it is constructed
- **THEN** it receives the pool as a factory dependency rather than reaching for an ambient accessor

### Requirement: Capability seams isolate core from managed realizations

Core SHALL declare its external capabilities as injected seams and ship trivial
local realizations, so it runs with filesystem/no-op defaults and no
hosted-service dependency. The five external seams SHALL be `RunAuthorizer`
(the sole constructor of a `RunSession`; OSS `createLocalRunAuthorizer`),
`ResolveBilling` (attribution headers at the wire call; OSS noop returns `{}`),
`ArtifactRegistry` (post-step recording; OSS `createNoopArtifactRegistry` —
registers nothing externally and reports zero failures, because the local
`cortex_artifacts` ledger is written by the harness itself around the seam and
an embedder without an external provenance system has nothing to register),
`RunCharge` (run-level billing bracket; OSS `createNoopRunCharge`), and
`PreviewPublisher` (report preview URLs; OSS `UnavailablePreviewPublisher`). The
shared `RunLauncher` seam (single realization `createDbosRunLauncher`) SHALL be
the only way tools start durable runs. Core SHALL NOT branch on which realization
is bound.

#### Scenario: An embedder swaps a seam without touching core

- **GIVEN** an embedder that wires a cloud `ArtifactRegistry` at the composition root
- **WHEN** a workflow records artifacts through the seam
- **THEN** core calls the same interface and never inspects which realization is bound

#### Scenario: Tools reach the durability engine only through RunLauncher

- **GIVEN** the `execute_plan` and `run_ephemeral` tools
- **WHEN** they start a durable run
- **THEN** they call `RunLauncher` (`launch` / `launchAndAwait`) and never import the DBOS engine directly

#### Scenario: The OSS ArtifactRegistry realization never fails a registration

- **GIVEN** a runtime assembled with `createNoopArtifactRegistry`
- **WHEN** a step registers its artifacts through the seam
- **THEN** `register` returns `{ registered: [], failed: [], failedCount: 0 }` and `sync` resolves without effect, so the post-step fail-fast gate never trips on the local default

### Requirement: The scheduler replays deterministically

The parent workflow body SHALL reach the same durable operations in the same
order on replay. The "which child finished first" decision SHALL use
`DBOS.waitFirst` (a checkpointed step), NOT `Promise.race` over `getResult`.
Budget admission decisions SHALL derive only from the workflow input (the
snapshotted budget, the plan's declared step resources) and checkpointed
completion state, so every replay admits the same steps in the same order. UI
emits from the workflow body SHALL be awaited in loop order, and any conditional
post-step emit driven by a non-deterministic producer SHALL gate on a value
checkpointed in `DBOS.runStep`.

#### Scenario: The completion order is checkpointed

- **GIVEN** multiple completed child workflows whose `getResult` resolves instantly on replay
- **WHEN** the scheduler selects the next finished child
- **THEN** it uses `DBOS.waitFirst` so the winning workflow id is recorded and replays identically

#### Scenario: Admission decisions replay identically

- **GIVEN** a recovered parent workflow whose original execution held a step for capacity
- **WHEN** the scheduler loop replays from the checkpointed completion sequence
- **THEN** the same admission decisions are recomputed and the same child workflows are dispatched in the same order

### Requirement: DBOS launches with a stable executor identity and recovers under it

The host SHALL call `launchDbos` after configuring and registering workflows.
Configuration SHALL set `executorID` from the host's stable process identity, an
optional `applicationVersion`, and an `adminPort`. When the same process slot
relaunches under the same `executorID`, DBOS SHALL be able to reclaim the pending
workflows its predecessor left behind. Core SHALL NOT ship an HTTP recovery route
or a standing recovery component; operator controls for retired executor ids are
a host concern.

#### Scenario: Executor identity is provided by the host

- **GIVEN** a host has chosen executor id `"core-worker-0"`
- **WHEN** `launchDbos` runs
- **THEN** DBOS is configured with `executorID = "core-worker-0"`

#### Scenario: A restart under the same identity can recover in-flight workflows

- **GIVEN** a host process that crashed with pending workflows under `executorID = "core-worker-0"`
- **WHEN** a new process launches under the same `executorID`
- **THEN** DBOS can reclaim those pending workflows without any core-owned recovery route

### Requirement: runEphemeral is a turn-scoped workflow

`runEphemeral` SHALL run as a real DBOS workflow so its sandbox callbacks route
through DBOS messaging, but it SHALL be turn-scoped: awaited inline by the
`run_ephemeral` tool via `RunLauncher.launchAndAwait`, cancelled on chat
disconnect (`DBOS.cancelWorkflow`), and never recovered. Because DBOS has no
zero-recovery knob, the launch path SHALL cancel any `ephemeral:`-prefixed
`PENDING` workflow owned by this executor BEFORE recovery runs, so a dead pod's
ephemeral run never re-executes.

#### Scenario: An ephemeral run is cancelled on chat disconnect

- **GIVEN** a `run_ephemeral` call awaiting its workflow result inline
- **WHEN** the chat turn's `AbortSignal` fires
- **THEN** the launcher cancels the workflow and returns a `{ status: "cancelled" }` outcome

#### Scenario: A dead pod's ephemeral workflow is never recovered

- **GIVEN** an `ephemeral:`-prefixed `PENDING` workflow left by a crashed process
- **WHEN** a new process launches under the same executor id
- **THEN** the pre-launch sweep marks it `CANCELLED` before DBOS recovery selects it

### Requirement: Lifecycle flags are process-local

Core SHALL expose process-local lifecycle helpers so a host can mark the process
draining and use that fact in its own readiness/traffic policy.

#### Scenario: Draining flag flips

- **WHEN** `markDraining()` is called
- **THEN** `isDraining()` returns `true`

### Requirement: Graceful shutdown order is injectable

`runShutdownSequence` SHALL mark draining, close the host's HTTP server through
an injected callback, shut DBOS down, close the app pool, flush telemetry/logs,
and exit. Core SHALL NOT own the HTTP server itself.

#### Scenario: Shutdown ordering is preserved

- **GIVEN** a host wires all shutdown callbacks
- **WHEN** `runShutdownSequence` runs
- **THEN** DBOS shutdown runs after HTTP drain and before pool close

### Requirement: DBOS owns its system connections; the application pool is bounded per process

DBOS SHALL manage its own system-database connections. Application queries use
the app pool. `runtime/connection-budget.ts` SHALL verify the per-process
connection footprint fits inside Postgres `max_connections`.

#### Scenario: Pools are distinct

- **WHEN** the runtime launches
- **THEN** application queries use the app pool
- **AND** DBOS uses its own system-database pool

#### Scenario: Per-process budget is documented and configurable

- **GIVEN** Postgres exposes a known `max_connections`
- **WHEN** the application pool `max` is configured
- **THEN** the guard checks one process's footprint and reports available headroom

### Requirement: Step scheduling is dependency-gated and failure-isolated

`executeAnalysis` SHALL start each step's child workflow when all of its
`depends_on` steps have completed AND the machine resource budget admits it
(see the resource-budgeted-scheduling capability), with no wave barrier. When
the workflow input carries no budget, dependency satisfaction alone SHALL start
the step. A computed topological level MAY be persisted and emitted for UI
layout but SHALL NOT gate execution.

A step settling as `failed`, as `blocked`, or by throwing for any non-budget
cause SHALL NOT cancel in-flight siblings and SHALL NOT stop scheduling: the
parent SHALL record the step as failed, continue awaiting in-flight children,
and keep dispatching every step that becomes dependency-satisfied. Only the
failed step's transitive dependents are affected — they can never become
dependency-satisfied (a failed step never enters the completed set) and SHALL
never be dispatched. The parent SHALL run a dispatch round after every child
settlement, not only after completions. The run-level `failureReason` SHALL
record the first failure in checkpointed settlement order; per-step errors ride
on the step ledger and the DAG snapshot.

The halt cascade (cancel in-flight children via explicit `DBOS.cancelWorkflow`
and stop scheduling) SHALL be reserved for the budget paths — a
`budget_exceeded` settlement (graceful or thrown) and the `neverFits`
plan-validation guard — whose semantics are owned by the
resource-budgeted-scheduling capability, and for external cancel.

#### Scenario: A ready step starts without waiting for an unrelated sibling

- **GIVEN** a step whose single dependency has just completed and a budget with sufficient remaining capacity
- **WHEN** the scheduler recomputes the ready set
- **THEN** that step starts immediately even if an unrelated step is still running

#### Scenario: A ready step is held while the budget is exhausted

- **GIVEN** a step whose dependencies have all completed and in-flight siblings whose declared resources consume the full budget
- **WHEN** the scheduler recomputes the ready set
- **THEN** the step is not started until an in-flight sibling settles and frees capacity

#### Scenario: A failure dooms only its transitive dependents

- **GIVEN** a plan `A → B → D` and `A → C → E` where B and C run concurrently after A completes
- **WHEN** B settles as `failed` while C is still running
- **THEN** C keeps running, E is dispatched when C completes, and D is never dispatched
- **AND** the run finalises `partial` with per-step errors on the ledger and `failureReason` recording B's failure

#### Scenario: A thrown child is treated exactly like a failed step

- **GIVEN** two independent in-flight steps
- **WHEN** one child workflow throws for a non-budget cause
- **THEN** its step is recorded failed with the thrown error, the sibling is not cancelled, and scheduling continues

#### Scenario: A blocker is treated exactly like a failed step

- **GIVEN** a plan with a blocked step and an independent ready sibling
- **WHEN** the step settles `blocked`
- **THEN** only the blocked step's transitive dependents are never dispatched and the independent sibling still runs

#### Scenario: Budget-exceeded still halts the run

- **GIVEN** several in-flight children
- **WHEN** a child settles with `budget_exceeded`
- **THEN** the parent cancels the remaining in-flight children via `DBOS.cancelWorkflow` and schedules no further steps

### Requirement: Unreachable dependents are visible as skipped in the DAG stream

The `DagStepState.status` vocabulary in the `data-dag-state` part SHALL gain a
`"skipped"` value. When a non-budget failure or blocker settles, the parent
SHALL walk the plan DAG and mark every transitive dependent of the failed step
that is not already terminal as `"skipped"` in the emitted snapshot, so doomed
steps are distinguishable from steps that will still run. The walk consumes
only workflow-input plan data and checkpointed settlement state, so it replays
deterministically. The `StepExecutionRow.status` database enum SHALL NOT
change: ledger rows stay `pending` until the terminal sweep flips them to
`skipped` (see the workflow-failure-lifecycle capability) — skipped visibility
during the run is a stream concern only.

#### Scenario: Dependents of a failed step show as skipped immediately

- **GIVEN** a plan `A → B → D` with D pending and B running
- **WHEN** B settles as `failed`
- **THEN** the next `data-dag-state` emission shows D as `"skipped"` while independent steps keep their own statuses

#### Scenario: The ledger is not written at doom-marking time

- **GIVEN** a step marked `"skipped"` in the stream after its upstream dependency failed
- **WHEN** its `cortex_step_executions` row is read while the run is still in flight
- **THEN** the row still reads `pending`; it reaches `skipped` only via the terminal sweep

