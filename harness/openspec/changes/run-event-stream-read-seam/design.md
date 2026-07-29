## Context

Analysis runs write a typed event stream to DBOS durable streams under the key `"events"`. Two producers write it, and the split is load-bearing for any reader:

- The **parent** `executeAnalysis` workflow (workflow id = `runId`) writes `data-run-started`, `data-dag-state`, `data-synthesis-progress`, `data-run-completed`, `data-run-failed`.
- Each **child** `sandbox-step` workflow (workflow id = `${runId}-${idx}`) writes `data-step-activity`, `data-step-file-tree`, `data-loop-event`, `data-step-blocked`, `data-step-summary`, `data-step-output` — to **its own** stream, because `DBOS.writeStream` is body-only and cannot write to another workflow's stream.

`PART_REGISTRY` (`src/contracts/part-registry.ts`) already classifies each part with an `emitter`, a `consumer`, and two flags: `transient` and `reconciling`. Eleven parts declare `consumer: "sidebar"`. Nothing in the repository reads any of them.

The DBOS read primitive constrains the design more than any preference does. `DBOS.readStream(workflowID, key)` is an **async generator**, not a query: it starts at offset 0, yields values in write order, and when it runs out it checks the workflow's status — terminating if the workflow is inactive, otherwise waiting for a notification bounded by a one-second polling fallback. The public signature exposes **no cursor**.

## Goals / Non-Goals

**Goals:**

- A run-scoped subscription that delivers every event part a run produces, from both parent and child streams, to a caller-supplied handler.
- Correct convergence for a subscriber that attaches at an arbitrary point in a run's life, including after it started.
- No DBOS type in the seam's public signature.
- Failure isolation: an error in one child's stream, or in the caller's handler, never fails the run and never silently ends the subscription for the rest of the run.
- Bounded connection acquisition on the app pool.

**Non-Goals:**

- Sandbox command output. The sandbox server emits one event kind (`file-tree`); stdout/stderr return only in the terminal exec result. No read side changes that.
- Replacing `observeRun`. It stays the coarse, in-process run/step snapshot seam; this is the fine-grained durable channel beside it.
- A generic DBOS stream reader. The seam is scoped to run events; a general-purpose wrapper would leak the engine's model back into the surface this exists to quarantine.
- Historical archive/query over completed runs. The subscription terminates with the run; durable *records* of outcomes already live in the ledger and the thread.

## Decisions

### D1 — Push subscription with a callback, not a snapshot reader or an async iterator

**Decision.** The seam is a function that takes a run id, a handler, and an `AbortSignal`, and returns a promise resolving when the run is terminal and every stream has drained.

**Why.** A snapshot reader is not implementable on the public API: `DBOS.readStream` exposes no offset parameter, so "read what is new since X" cannot be expressed without reaching into the SDK's internal system-database object — which is the same class of internals access this change exists to remove. A merged async iterator was the other candidate; it reads well at a single call site but has to merge a *dynamically growing* set of sources, and expressing "a new child appeared, fold it into the iteration" is materially more code than invoking a handler. The callback also matches the harness's existing `EmitFn` idiom, so the delivered shape is the one the producers already speak.

**Consequence.** The consumer owns its own state. That is correct here: the CLI holds reactive stores, a managed host might hold a websocket fan-out, and neither wants the harness's buffering policy.

### D2 — Fan-in discovers children from `cortex_step_executions.child_workflow_id`

**Decision.** The parent stream is subscribed immediately. Children are discovered by reading `cortex_step_executions` for the run and subscribing to each row's `child_workflow_id`, re-checked as the run progresses so children that start later are picked up.

**Why.** The column is already written by the workflow bodies, and this is already the documented intent — `sandbox-step.ts` states that a reader must take "the parent's stream plus every active child's, addressed by `cortex_step_executions.child_workflow_id`". The alternatives are worse: DBOS's own `operation_outputs.child_workflow_id` is engine internals, and deriving child ids from the `${runId}-${idx}` naming would hard-code a scheme that belongs to the scheduler.

**Consequence.** Child discovery is only as timely as the ledger write that records the child id, which happens as the child starts. A child's first few parts are therefore delivered on subscribe via replay rather than live — which D3 makes harmless.

### D3 — Replay from zero is relied upon, and each workflow is subscribed exactly once

**Decision.** Every stream is read from offset 0, and the seam tracks which workflow ids it has already subscribed so none is read twice.

**Why.** Replay is not a cost to be worked around; it is what makes a mid-run attach correct. A subscriber joining at minute ten receives the run's whole history, and folding it yields the true current state. Re-subscribing the same workflow, by contrast, would re-deliver every part and — for non-reconciling parts — duplicate them.

### D4 — The seam folds reconciling parts; it does not fold transient ones

**Decision.** Parts whose registry entry sets `reconciling: true` are folded latest-wins by part `id` before delivery, so the handler sees one current value per reconciling id rather than the whole history. Non-reconciling parts are delivered in write order, each exactly once.

**Why.** `reconciling` already exists in `PART_REGISTRY` and already means "later emissions of this id supersede earlier ones" — `data-step-activity` uses a stable id per `(runId, stepId)` precisely so a fold collapses every phase transition. Reading that flag rather than hard-coding a list of part types keeps one source of truth: a part added to the registry later is folded correctly without touching this seam.

**Rejected.** Delivering the raw stream and making every consumer implement the fold. That guarantees each consumer re-derives the same rule, and gets it subtly differently.

### D5 — Ordering is guaranteed per stream, not across streams

**Decision.** Parts from one workflow are delivered in write order. No total order is imposed across the parent and its children.

**Why.** The streams are independent Postgres rows written by concurrently executing workflows; a cross-stream total order would have to be synthesised from timestamps that were never intended to be a clock, and would imply a guarantee the producers do not provide. Consumers do not need it: each part is addressed by `runId`/`stepId`, and the reconciling fold is per id.

### D6 — Failure isolation mirrors the emit side

**Decision.** A handler that throws, and a child stream that errors, are both contained: the error is logged through the injected `Logger` and the subscription continues for every other stream. Only an aborted signal or run termination ends it.

**Why.** The producers already take this stance — `safeEmit` swallows stream-write failures because "a dropped UI frame is non-fatal and must not fail the step". A read side that tore down on one bad part would be strictly less robust than the write side it observes.

### D7 — Bounded connection acquisition on the app pool

**Decision.** The application pool sets a connection-acquisition timeout.

**Why.** `pg.Pool` defaults to waiting forever for a client. Any caller that awaits a query on a saturated pool therefore has no failure mode, only an indefinite hang — and a hang inside a caller's own in-flight guard is indistinguishable from work still in progress. A bounded wait converts a silent stall into a surfaced error the caller can degrade on. This seam adds long-lived readers to a process that already holds the pool, which raises the stakes on that default enough to fix it here rather than leave it latent.

## Risks / Trade-offs

- **A long-lived subscription holds a pool client while tailing** → The reader's waiting path is the SDK's notification listener plus a one-second poll, not a held transaction; combined with D7 the pool cannot be silently exhausted without surfacing. Subscription count is bounded by the number of workflows in one run.
- **Child discovery lags the child's first writes** → Harmless by D3: subscribing later replays from zero, so nothing is lost, only delivered slightly later than written.
- **Replay cost grows with run length for a late subscriber** → Bounded by the parts one run emits, and paid once per workflow per subscription. Accepted rather than mitigated with a cursor, since no public cursor exists (D1).
- **The seam depends on `PART_REGISTRY` staying honest** → A new part added without a registry entry would not be classifiable. That is already true of every consumer of the contract, and the registry is exhaustively typed by `CortexChatPartType`, so a missing entry is a compile error rather than a runtime surprise.
- **Two observation seams now exist** (`observeRun` and this) → Deliberate, and the boundary is written into both specs: `observeRun` carries run/step state only and says so; this carries the sub-step detail that one explicitly defers. The risk is a future contributor extending the wrong one, which the cross-reference is there to prevent.
