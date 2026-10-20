# Design

## Context

- `launchStoredPlan` reads the plan, validates it, and reads the active run (`src/tools/execute-analysis.ts:584-605`). Then `launchReservedRun` links the packages, reserves the run, authorizes it, and starts the workflow (`:455-528`). `reservePlanRun` inserts the row with one statement on the pool (`:534-558`). No transaction holds the active-run read and the insert together.
- `queryActiveRun` matches only a `running` row (`src/state/runs.ts:157-172`). Thus a plan whose run ended starts a new run on each launch.
- `queryRunIdsByPlan` gives the run ids of a plan, newest start first, with the run id as the tie break (`src/state/runs.ts:341-352`). The plan read of the cli gives these ids as `runIds` (`cli/src/server/routes/runs.ts:262-285`). The index `idx_cortex_runs_plan` serves this order.
- `insertRun` writes `started_at` from the clock of the host, at a resolution of one millisecond (`src/state/runs.ts:75`). `reservePlanRun` mints the run id with `randomUUID()` (`src/tools/execute-analysis.ts:538`). Thus a tie of start times, or a host clock that is behind, can sort a later row below an earlier row.
- `insertRun` rejects its promise with `RunDedupCollisionError` on a collision of the active-plan index (`src/state/runs.ts:74-103`). It does not give an `err`.
- `withTransaction` runs a body on one `PoolClient` and rolls back each body that does not reach `COMMIT` (`src/lib/db-result.ts:209-237`). A throw that escapes the body rolls back, releases the client, and rejects the promise. The thread history serializes the writes of one thread with `pg_advisory_xact_lock(hashtext($1))` inside such a transaction (`src/memory/thread-history.ts:400-401`).
- `launchReservedRun` gives the reservation back unchanged when it is an `err` or when `started` is `false` (`src/tools/execute-analysis.ts:470-472`). Thus a reservation that starts nothing authorizes nothing.
- `throwLaunchRefusal` switches over each refusal of the tool with a `never` default (`src/tools/execute-analysis.ts:620-638`).

## Goals / Non-Goals

**Goals:**

- A launch that a caller can bind to the newest run that it saw.
- Reservations of one plan that occur one after the other, each with a row that becomes the newest run of the plan.
- A view that is stale before the launch links nothing, reserves nothing, and authorizes nothing.
- A view that becomes stale during the link pass reserves nothing and authorizes nothing.

**Non-Goals:**

- No change of the observable behavior of `execute_analysis`.
- No lock across the link pass. The link pass calls a function of the host, which can take many seconds.
- No change of the ad hoc reservation. Its plan id and its run id belong to one tool call.
- No migration.

## Decisions

### D1. An optional `newestRunId` on the launch, a required one on the approval

`launchPlanRun(deps, { session, planId, newestRunId? })`, with `newestRunId?: string | null`. An absent member means "compare nothing", which is the plan mode of the tool. `null` means "the caller saw no run". A string is the newest run that the caller saw.

`ApprovePlanInput` gets `newestRunId: string | null` as a required member, and `approve` passes it to `launchPlanRun`. Thus an approval always compares.

Alternative: a second exported launch function for the approval. It duplicates the steps of the launch, and the spec names one launch function.

Alternative: a nested member `{ view: { newestRunId } }`, which makes the absent state explicit. It adds a type for one field. The required member on the approval input keeps the absent state out of the approval path.

### D2. One read of the newest run, and the compare before the link pass

Add `queryNewestPlanRun(querier, { analysisId, planId })` to `src/state/runs.ts`. It gives `{ runId, startedAt } | null` for the first row of `ORDER BY started_at DESC, run_id DESC`, the order of `queryRunIdsByPlan`. The package root does not export it.

In `launchStoredPlan`, after the plan validation and before the active-run read, a launch with a `newestRunId` reads `queryNewestPlanRun(pool, ...)`. With `newest` as the run id of that row, or `null` for no row:

- `newest === newestRunId`: continue to the active-run read.
- `newest !== null`: give `ok({ runId: newest, started: false })`.
- `newest === null`: give `err({ type: "run_not_found", runId: newestRunId })`.

The read comes before the link pass because the link pass can take many seconds, and it extends the farm of the analysis. A stale view must not do that work. The active-run read stays as it is. A plan whose active run is the newest run that the caller saw still gives that run with `started: false`.

### D3. Each plan reservation under the lock of the plan

`reservePlanRun` takes the optional `newestRunId`. For each launch of a stored plan, bound or not, it runs one `withTransaction(deps.pool, ...)` body on the client:

1. `SELECT pg_advisory_xact_lock(hashtext($1))` with the key `plan-launch:<planId>`. The plan id is the primary key of `cortex_plans`, thus the key names one plan.
2. `queryNewestPlanRun(client, { analysisId, planId })`. A bound launch compares its run id as D2 tells, and a mismatch inserts nothing.
3. `insertRun(client, ...)` with the new run id and a start time that is later than the start of the newest run (D4).

The body gives a value that tells the three outcomes apart: the insert, a newer run, or no run. `withTransaction` commits each outcome. A mismatch wrote nothing, thus its commit is empty. Outside the transaction, the reservation maps a newer run to `ok({ runId: newest, started: false })`, and no run to `run_not_found`.

The lock orders each reservation of one plan, also a reservation of the tool. A second approval waits until the first commits its row. Then it reads that row as the newest run, and it gives `started: false`. This is true also when the first run ended before the second read, for example after a refused authorization.

A collision of the active-plan index still occurs for an unbound launch while a run of the plan is active. `insertRun` then rejects inside the body. The rejection escapes `withTransaction`, which rolls back and releases the client. The reservation catches it as it does now, and it reads `queryActiveRun` on the pool. It must not read on the transaction client, because Postgres refuses each statement of a transaction after an error.

Alternative: a lock for a bound launch only. A launch of the tool can then insert and end its run between the read and the insert of an approval. That lets a second row in.

Alternative: one `INSERT ... SELECT ... WHERE` statement that compares and inserts. Under `READ COMMITTED` its snapshot does not see a run that a concurrent launch committed after the start of the statement. The lock removes the window by order, not by time.

Alternative: the `SERIALIZABLE` isolation level. It needs a retry loop on a serialization failure, and the harness has no such pattern.

Alternative: a lock that holds across the link pass. The transaction then holds a pool connection for the whole call of the host function.

### D4. A start time after the newest start

`InsertRunInput` gets an optional `startedAt`. Without it, `insertRun` writes the clock of the host, as it does now. Under the lock, the reservation gives a `startedAt` value. It is the later of two times: the clock of the host, and the newest start plus one millisecond. Thus the new row sorts first in the order of D2, whatever the clock of the host and whatever the random run id.

Alternative: the clock of the database for each run. It changes each writer of `started_at`, and a tie in one millisecond still sorts by the random run id.

### D5. The refusal `run_not_found`

`LaunchPlanRunRefusal` gets `{ type: "run_not_found"; runId: string }`. It passes through `ApprovePlanRefusal` with no change. It occurs only for a caller that names a run while the plan has no run. The harness removes a run only with its analysis (`src/state/purge-analysis.ts:84`), thus a correct view never causes it.

`throwLaunchRefusal` gets a case for it that throws an `Error` that names the plan and the run. The tool gives no `newestRunId`, thus the case cannot occur there. The case exists because the switch is exhaustive.

### D6. The meaning of `started: false`

`PlanLaunch` and `PlanApproval` keep their shapes. `started: false` now means "this call started nothing". `runId` names the active run, or the newest run of the plan when the view was stale. The JSDoc of `PlanLaunch`, `launchPlanRun`, and `PlanApproval` tells both cases.

## Risks / Trade-offs

- [The lock key shares the `hashtext` space with the thread lock] → A collision of two hashes only makes two short transactions wait for each other. It changes no outcome.
- [Each plan reservation holds one pool connection for four statements] → An approval is a click of a person. A plan launch of the agent is one tool call. Thus the rate is low.
- [A start time can be later than the clock of the host] → The shift is at most the skew between the hosts. The start time stays in the order of the inserts.
- [`ApprovePlanInput` gets a required member] → Each embedder that calls the approval must give the value. The cli does this in its companion change.

## Migration Plan

No migration. The read uses the existing index `idx_cortex_runs_plan`.
