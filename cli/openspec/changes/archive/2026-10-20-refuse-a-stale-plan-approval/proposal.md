# Proposal

## Why

GitHub issue #686: `POST {A}/plans/:planId/approve` refuses a second run only while a run of the plan is active. A stale view of a plan whose run ended thus starts a second run that the person did not ask for. Flamme reads the plan before it posts (himmel `apps/flamme/src/data/plans.ts:137-147`), but a client cannot close the gap between its read and its post.

The harness change `refuse-a-stale-plan-approval` binds the launch of an approval to the newest run that the client saw. This change connects that value to the route.

## What Changes

- **BREAKING** The body of the approve route becomes `{ threadId, newestRunId }`. `newestRunId` is the first id of the `runIds` that the client read, or `null` when that list was empty. A body with no such value gets 400 `validation_error`.
- A stale view gets 201 with `started: false`, the newest run of the plan as `runId`, and `message: null`. This is the answer that an active run gets now.
- A `newestRunId` for a plan with no run gets 404 `not_found`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the approve route takes the newest run that the client saw, and it answers a stale view with the newest run.

## Impact

- cli code: `src/api/runs.ts`, `src/server/routes/runs.ts`, and their tests.
- The harness: the route uses the harness change. Thus `bun run harness:local` comes before the typecheck and the tests.
- Clients: a client of the approve route must send `newestRunId`. Flamme sends the newest id of `runIds` from its read of the plan.
