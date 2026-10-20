# Design

## Context

- The route reads the body with `readBody(c, z.object({ threadId: z.string().min(1) }))` and gives the approval `{ analysisId, threadId, planId, identity, auth }` (`src/server/routes/runs.ts:287-314`).
- The route answers each success with 201, and it notes the activity only for `started: true` (`src/server/routes/runs.ts:306-311`). Thus a stale view that the harness answers with `started: false` needs no new code in the success path.
- `approvalRefusal` switches over each `ApprovePlanRefusal` with a `never` default (`src/server/routes/runs.ts:479-509`). The harness change adds `run_not_found` to that union.
- The route answers an unknown `threadId` of the body with 404 `not_found` (`src/server/routes/runs.ts:482-483`).
- `ApprovePlanBody` and `PlanApprovalResult` are the wire types of the route (`src/api/runs.ts:107-124`).

## Goals / Non-Goals

**Goals:**

- A route that gives the harness the newest run that the client saw, on each approval.

**Non-Goals:**

- No client fetcher in the cli. The consumer of the route is the web client.
- No change of the plan read. Its `runIds` already give the order that the harness compares.

## Decisions

### D1. A required `newestRunId` in the body

The body schema becomes `z.object({ threadId: z.string().min(1), newestRunId: z.string().min(1).nullable() })`. An absent value fails the schema, thus it gets 400 `validation_error`. The route gives the value to the approval as `newestRunId`.

Alternative: an optional value that turns the compare off. A client that omits it keeps the stale-view defect, and the harness approval input requires the value.

### D2. `run_not_found` is 404 `not_found`

`approvalRefusal` maps `run_not_found` to `apiError(c, "not_found", "Plan <planId> has no run <runId>.")`. The request names a run that the server does not hold, the same as an unknown `threadId` of the body.

Alternative: 409 `conflict` with a new `details.reason`. Each 409 reason now refuses a plan or a launch that exists. Flamme maps a 409 with an unknown reason to the failure `other`, and a 404 to `gone` (himmel `apps/flamme/src/data/plans.ts:110-121`).

### D3. The wire types tell the new meaning

`ApprovePlanBody` gets `newestRunId: string | null` with a JSDoc that names its source. The JSDoc of `PlanApprovalResult` tells that `started: false` means an active run or a stale view, and that `runId` names that run.

## Risks / Trade-offs

- [A client that sends `{ threadId }` only gets 400] → The issue asks that Flamme send the newest id of `runIds`. The 400 makes a client that omits it fail loudly, and it starts no run.
