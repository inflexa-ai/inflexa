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
user has explicitly asked to be durable — analyses, data-profile, and
ephemeral exploration — run as DBOS workflows, started from
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
step rows. User-named long operations (`executeAnalysis` and the
data-profile task) SHALL run as DBOS
workflows started from tools and SHALL be independent of the chat turn that
triggered them. Planned and ad hoc analysis modes SHALL both launch
`executeAnalysis`; there SHALL be no separate turn-scoped computation workflow.
The same `runAgent` body SHALL serve both modes through an injected `RunStep` —
`passthroughStep` in chat, `durableStep` inside workflow steps.

#### Scenario: A tool starts a workflow that outlives the chat turn

- **GIVEN** a chat turn whose agent dispatches `execute_analysis`
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
callables, registering that agent in the type-keyed agent registry `CoreRuntime`
exposes as its resolution surface (`agents` — see the thread-agent-resolution
spec); `CoreRuntime` SHALL NOT expose a bare `conversationAgent` field.
Registration order SHALL be preserved because the parent's child
dispatch closes over the registered child callable: the sandbox-step workflow
SHALL register before `executeAnalysis`, which receives that callable. All
workflows SHALL register in this one call before `launchDbos`, so they land under
one `applicationVersion` cohort.

#### Scenario: The parent workflow is built over the registered child callable

- **WHEN** `assembleCoreRuntime` runs
- **THEN** the sandbox-step workflow is registered first
- **AND** `executeAnalysis` is built with the registered sandbox-step callable, not a pre-built one

#### Scenario: The runtime exposes agents only through the resolution surface

- **WHEN** `assembleCoreRuntime` returns
- **THEN** `CoreRuntime` carries the agent resolution surface (`agents`) and the registered workflows
- **AND** the conversation agent is reachable only via `agents.forThread("conversation")`

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
hosted-service dependency. The external seams MUST be these:

- `RunAuthorizer`: the only constructor of a `RunSession`. `authorize` is a gate. `revoke` and `revokeByJti` are
  notices. The OSS realization is `createLocalRunAuthorizer`.
- `ArtifactRegistry`: the post-step record of the artifacts of a step. `register` is a gate, and `sync` is a notice.
  The OSS realization `createNoopArtifactRegistry` registers nothing outside the harness, and it reports zero
  failures. The harness itself writes the local `cortex_artifacts` ledger around the seam. An embedder without an
  external provenance system has nothing to register.
- `RunCharge`: the run-level billing bracket. `open` is a gate, and `close` is a notice. The OSS realization is
  `createNoopRunCharge`.
- `UsageRecorder`: it gets one usage record for each completed LLM call. `record` is a notice. The OSS realization is
  `createNoopUsageRecorder`.

The embedder can also give two optional hooks to the components that use their values:

- `resolveRequestHeaders` is a gate on each model provider. The provider adds the headers that the hook gives to each
  model request, and it does not read them (see the host-hooks spec).
- `resolveSandboxLabels` is a gate on the configuration of the sandbox client. The client calls it at each spawn, on
  the Docker backend and on the K8s backend (see the sandbox-labels spec).

Each hook MUST be a gate or a notice, and its type MUST show its kind (see the host-hooks spec). If an optional hook is
absent, the provider adds no headers, and the sandbox has no host labels. The harness has no `ResolveBilling` seam, and
it exports no `createNoopBillingResolver`. The shared `RunLauncher` seam (single realization `createDbosRunLauncher`)
SHALL be the only way tools start durable runs. Core SHALL NOT branch on which realization is bound.

#### Scenario: An embedder swaps a seam without touching core

- **GIVEN** an embedder that wires a cloud `ArtifactRegistry` at the composition root
- **WHEN** a workflow records artifacts through the seam
- **THEN** core calls the same interface and never inspects which realization is bound

#### Scenario: Tools reach the durability engine only through RunLauncher

- **GIVEN** the `execute_analysis` tool
- **WHEN** it starts a durable run
- **THEN** it calls `RunLauncher.launch` and never imports the DBOS engine directly

#### Scenario: The OSS ArtifactRegistry realization never fails a registration

- **GIVEN** a runtime assembled with `createNoopArtifactRegistry`
- **WHEN** a step registers its artifacts through the seam
- **THEN** `register` gives `ok({ registered: [], failed: [], failedCount: 0 })`, and `sync` gives `ok` with no effect
- **AND** the local default never fails a step

#### Scenario: A runtime without the optional hooks adds no host values

- **GIVEN** a runtime whose providers have no `resolveRequestHeaders` and whose sandbox client has no `resolveSandboxLabels`
- **WHEN** a step sends a model request and spawns a sandbox
- **THEN** the model request carries no host headers, and the sandbox carries only the harness labels

#### Scenario: The harness exports no billing resolver

- **WHEN** an embedder imports the public exports of `@inflexa-ai/harness`
- **THEN** the exports hold no `ResolveBilling` and no `createNoopBillingResolver`

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

`bootHarness` SHALL return a `shutdown(signal)` handle that drives
`runShutdownSequence` wired with the harness-owned callbacks (`markDraining`,
`shutdownDbos`, and closing the app pool). The HTTP-drain, logger-flush,
telemetry-shutdown, and process-`exit` callbacks SHALL default to no-ops so a
library host that owns none of those (and owns its own process lifecycle) is not
forced to supply them; an embedder overrides any it does own (e.g. a server host
supplies `closeHttpServer` and `exit`).

#### Scenario: Shutdown ordering is preserved

- **GIVEN** a host wires all shutdown callbacks
- **WHEN** `runShutdownSequence` runs
- **THEN** DBOS shutdown runs after HTTP drain and before pool close

#### Scenario: The boot handle closes the pool without an embedder callback

- **GIVEN** an embedder that supplies no `closeHttpServer` / `exit` override
- **WHEN** the returned `shutdown` handle runs
- **THEN** draining is marked, DBOS is shut down, and the app pool is closed, and the missing callbacks default to no-ops rather than failing

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

A step can settle as `failed` or as `blocked`, or its child can throw for a cause that is not a suspension. Such a
settlement MUST NOT cancel the in-flight siblings, and it MUST NOT stop the scheduler. The parent MUST record the step
as failed. It MUST continue to await the in-flight children, and it MUST dispatch each step that becomes
dependency-satisfied.

Only the failed step's transitive dependents are affected — they can never become
dependency-satisfied (a failed step never enters the completed set) and SHALL
never be dispatched. The parent SHALL run a dispatch round after every child
settlement, not only after completions. The run-level `failureReason` SHALL
record the first failure in checkpointed settlement order; per-step errors ride
on the step ledger and the DAG snapshot.

The halt cascade cancels each in-flight child with an explicit `DBOS.cancelWorkflow`, and it stops the scheduler. The
parent MUST start the halt cascade only on these paths:

- A child settles as a suspension, as a result or as a throw. The parent knows this from the typed suspension message
  of the child (see the workflow-suspension spec).
- The `neverFits` plan-validation guard finds a step that can never fit the budget. The resource-budgeted-scheduling
  capability owns the semantics of this guard.
- An external cancel stops the run.

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
- **WHEN** one child workflow throws for a cause that is not a suspension
- **THEN** its step is recorded failed with the thrown error, the sibling is not cancelled, and scheduling continues

#### Scenario: A blocker is treated exactly like a failed step

- **GIVEN** a plan with a blocked step and an independent ready sibling
- **WHEN** the step settles `blocked`
- **THEN** only the blocked step's transitive dependents are never dispatched and the independent sibling still runs

#### Scenario: A suspension still halts the run

- **GIVEN** three in-flight children
- **WHEN** one child settles as a suspension
- **THEN** the parent cancels the other in-flight children with `DBOS.cancelWorkflow`, and it dispatches no more steps

#### Scenario: A suspension that comes as a throw halts the run

- **GIVEN** a child that sent a typed suspension message and then canceled itself
- **WHEN** `getResult` of that child throws `DBOSWorkflowCancelledError`
- **THEN** the parent identifies the settlement as a suspension, and it starts the halt cascade

### Requirement: Unreachable dependents are visible as skipped in the DAG stream

The `DagStepState.status` vocabulary in the `data-dag-state` part SHALL gain a
`"skipped"` value. When a step settles as a failure or as a blocker, and not as a suspension, the parent MUST walk the
plan DAG. The parent MUST mark each transitive dependent of the failed step as `"skipped"` in the emitted snapshot. A
dependent that is already terminal keeps its status. Thus the snapshot shows which steps can never run and which steps
will still run.

The walk consumes only workflow-input plan data and checkpointed settlement state, so it replays
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

#### Scenario: A suspension marks no dependent as skipped

- **GIVEN** a plan `A → B → D`, where D has the status `pending` and B has the status `running`
- **WHEN** B settles as a suspension
- **THEN** the next `data-dag-state` emission does not show D as `"skipped"`

### Requirement: The harness owns the ordered boot sequence

`bootHarness` (`runtime/boot.ts`) SHALL be the harness-owned boot sequence that
wraps `assembleCoreRuntime` with the effectful, order-dependent boot steps, and
SHALL return a `{ runtime, shutdown }` handle. `assembleCoreRuntime` SHALL stay
synchronous and pure (registration only). The steps SHALL run cheapest-failure
first, in this order:

1. injected telemetry init (default no-op, so a library host acquires no
   process-wide telemetry it did not ask for),
2. `validateAgentSkills(skillsDir, SANDBOX_AGENT_META)`,
3. `initCortexState(pool)`,
4. `assertConnectionBudget(...)`,
5. `assembleCoreRuntime(core)`,
6. an optional embedder `beforeLaunch()` hook (host-specific pre-launch work —
   scheduled sweeps, an ephemeral reap, an agent-switch install — that must
   attach before DBOS launch re-emits events),
7. `launchDbos(...)`.

Boot-step failures SHALL propagate to the caller (the embedder's composition
root releases whatever it acquired). Only `shutdown` swallows per-step failures.

#### Scenario: Skills are validated before launch

- **GIVEN** `bootHarness` is called with a `skillsDir` under which a declared skill has no readable `SKILL.md`
- **WHEN** the harness boots
- **THEN** it SHALL reject before `assembleCoreRuntime` and `launchDbos` run

#### Scenario: The embedder hook runs after registration and before launch

- **GIVEN** a `beforeLaunch` hook is supplied
- **WHEN** `bootHarness` runs to launch
- **THEN** `beforeLaunch` SHALL run after `assembleCoreRuntime` registers the workflow cohort and before `launchDbos`

### Requirement: Legacy ephemeral rows are cancelled before recovery

The runtime SHALL retain an executor-scoped pre-launch migration
sweep that marks pending legacy ephemeral workflows cancelled before DBOS
recovery while upgrades from binaries that created `ephemeral:*` rows remain
supported. No registered tool or workflow in the new runtime SHALL create an
`ephemeral:*` row.

#### Scenario: Upgrade encounters a pending legacy row

- **GIVEN** a pending `ephemeral:*` workflow owned by the runtime's stable executor id
- **WHEN** the new runtime performs its pre-launch migration hooks
- **THEN** it cancels that row before DBOS recovery starts
- **AND** no ephemeral workflow registration is required to execute it

### Requirement: The DAG snapshot names each step by its plan name

`DagStepState.name` SHALL carry the plan step's human-readable name, not its identifier.
The parent workflow's input already holds the validated plan steps, each of which carries
both an id and a name, so the value requires no new threading.

A step's name is the only field in the snapshot that says what the step is *for* in
language a reader understands; its id is a slug chosen for dependency wiring. Emitting the
id under a field the contract documents as a name leaves every consumer — the durable event
stream's readers and the run-observation seam alike — rendering slugs while believing they
render names.

The `id` field SHALL continue to carry the identifier, so a consumer that needs to join
against ledger rows or dependency lists is unaffected.

#### Scenario: A snapshot step carries its plan name

- **GIVEN** a plan step whose id is a slug and whose name is a human phrase
- **WHEN** a DAG snapshot is emitted for a run of that plan
- **THEN** the step's `name` is the human phrase and its `id` is the slug

#### Scenario: Dependency wiring still uses ids

- **WHEN** a consumer resolves a step's dependencies from a snapshot
- **THEN** the dependency entries and the step `id` values match the plan's identifiers, unchanged by the name correction

### Requirement: Absent snapshot fields stay absent rather than invented

`DagStepState` fields the parent workflow does not hold SHALL be left unpopulated rather
than filled with a substitute. Specifically, the per-step artifact count and summary SHALL
remain absent: the parent has neither at snapshot time, and supplying a placeholder would
make a consumer's rendering confidently wrong rather than honestly incomplete.

#### Scenario: Unheld fields are omitted

- **WHEN** a DAG snapshot is emitted
- **THEN** per-step artifact count and summary are omitted from steps for which the workflow holds no value, rather than defaulted

### Requirement: A `Result` survives a DBOS checkpoint

The harness MUST register the neverthrow classes `Ok` and `Err` with `DBOS.registerSerialization` one time, before
DBOS launches. DBOS saves each workflow input, step output, workflow output, and message with SuperJSON. Without this
registration, SuperJSON does not keep the class of an `Ok` or an `Err`. In that case, a replay gives a plain object that
has no methods of a `Result`.

After the registration, a step and a workflow can return a `Result` as a value. An `err` that a step returns is a
value, not a failure of the step. DBOS records the step as a success. A replay returns the same `err`, and it does not
run the step again. The body MUST use that `err`.

#### Scenario: A replay returns the same err of a step

- **GIVEN** a workflow whose step returned `err(e)`, and a host that stopped after the checkpoint of that step
- **WHEN** DBOS recovers the workflow, and the body runs again
- **THEN** the step does not run again, and the body gets an `Err` whose `isErr()` is `true` and whose `error` is `e`

#### Scenario: The output of a workflow keeps the class of its Result

- **GIVEN** a workflow that returns `err({ kind: "suspended", reason: "payment_required" })`
- **WHEN** the caller reads the output with `getResult`
- **THEN** the caller gets an `Err` whose `isErr()` is `true`, not a plain object

#### Scenario: The registration comes before the launch

- **WHEN** DBOS launches
- **THEN** DBOS already has the serialization recipes of `Ok` and `Err`, and the harness registered each recipe one time

### Requirement: The harness throws only at a DBOS boundary or at the tool dispatch

The harness MUST throw an exception only at these places:

- A step or a workflow that must fail.
- A step that DBOS must retry, because DBOS retries a step only on a throw.
- The self-cancel of a suspension.
- A tool `execute` body. The dispatch catch of the loop changes the throw into an error tool result.

`unwrapOrThrow` MUST be the one bridge from a `Result` to a throw. A failure that must fail a step MUST cross the
DBOS boundary as a throw, as the workspace-root-resolution spec also states. Then DBOS records the step as failed.

The harness MUST catch an exception only at a DBOS boundary, an API boundary, a client boundary, or the dispatch
catch of the loop. A DBOS boundary is a workflow body that gets the throw of a failed step or a failed child workflow.
Then the body runs its failure path. An API boundary is an entry point
where a caller outside the harness gets the outcome of a call. A client boundary is a thin wrapper around a call to
code outside the harness, for example the `pg` driver or a third-party SDK. The wrapper changes the throw into an
`err`.

An exception from DBOS, for example `DBOSWorkflowCancelledError`, MUST reach DBOS with no change. The harness MUST NOT
change such an exception into an `err`. A call to a host hook has no `try` and no `catch` around it (see the
host-hooks spec). Thus `executeAnalysis` MUST NOT put a `try` or a `catch` around a hook call.

#### Scenario: A cancel from DBOS reaches DBOS with no change

- **GIVEN** a workflow that an operator cancels while a step body runs
- **WHEN** the next DBOS call of the body throws `DBOSWorkflowCancelledError`
- **THEN** the exception reaches DBOS with no change, and no harness code changes it into an `err`

#### Scenario: A failure that must fail a step crosses as a throw

- **GIVEN** a step body whose workspace root does not resolve
- **WHEN** the step runs
- **THEN** the failure crosses the DBOS boundary as a throw through `unwrapOrThrow`, and DBOS records the step as failed

#### Scenario: A client boundary changes a throw into an err

- **GIVEN** a query that the `pg` driver refuses with an exception
- **WHEN** the wrapper of the query catches the exception
- **THEN** the caller of the wrapper gets an `err`, and it gets no exception

