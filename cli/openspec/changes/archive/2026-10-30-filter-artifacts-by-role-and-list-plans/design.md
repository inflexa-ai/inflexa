# Design

## Context

`GET {A}/artifacts` (`src/server/routes/artifacts.ts`) reads each filter with `filterValue` and validates `sort` with a zod enum. A bad `sort` gets 400 `validation_error` with `fieldErrors`, before the ledger read. The harness gives the zod enum `ArtifactRole` in `@inflexa-ai/harness/state/schema.js`, and `src/api/artifacts.ts` already imports its type from that path.

The plan routes are in `runRoutes` (`src/server/routes/runs.ts`). The harness reads come in through `RunRoutesOpts`, thus a route test replaces each read and needs no Postgres. `planTitleOf` gives the `planTitle` of a run summary: the trimmed string title, or `null`.

The harness change `filter-artifacts-by-role-and-list-plans` gives the `role` filter of `queryArtifactPage` and the read `queryPlanPage`. The cli resolves the harness through its `dist/`, thus the harness build comes before the cli typecheck and tests.

## Goals / Non-Goals

**Goals:**

- The `role` query value, validated where the input enters.
- `GET {A}/plans` in the list shape, with one harness read for each request.

**Non-Goals:**

- A filter of the plans by thread. The harness design gives the reason.
- A `createdAt` in `GET {A}/plans/:planId`. The list gives the time of each plan.
- A client fetcher or a TUI view. No client in this repository reads the two routes.

## Decisions

### The role value

The route reads `role` with `filterValue` and parses it with the harness `ArtifactRole` enum. Thus the members of the role have one definition. A local `z.enum` like `sortQuery` was the alternative. It makes a second list of the members that can go out of agreement with the ledger.

A bad value gets the refusal shape of `sort`: 400 `validation_error`, the message, and `fieldErrors.role`. The refusal comes before the ledger read.

### The plan list route

`GET /plans` goes into `runRoutes`, beside `GET /plans/:planId`. `RunRoutesOpts` gets `listPlans(pool, analysisId, { limit, offset })`, and its default is `queryPlanPage`. The route uses `parsePage` and `listEnvelope("plans", items, total, page)`. Thus `total` is exact, and `hasMore` comes from the shared helper.

### The wire type

`src/api/runs.ts` gets `PlanSummary` and `PlanList = ListEnvelope<"plans", PlanSummary>`. The fields are `planId`, `createdAt`, `title`, `parentPlanId`, `supersededBy`, and `newestRunId`, in the order of identity, core data, and references. `title` is `string | null`, not optional, because each other nullable field of the item is explicit.

### The title rule

The harness gives the stored string title or `null`. The route trims it with the rule of `planTitleOf`. The string test of `planTitleOf` moves into one function in the same file, and `planTitleOf` and the list route use that function. Thus the `title` of a list item and the `planTitle` of a run summary agree.

## Risks / Trade-offs

- [A client asks for each plan in one request.] → The list shape caps `perPage` at 200. The harness read sends two statements, whatever the page size.
