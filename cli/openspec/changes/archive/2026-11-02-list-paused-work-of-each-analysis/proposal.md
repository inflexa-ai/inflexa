# Proposal

## Why

A host that shows paused work across analyses must read `GET {A}/paused-work` for each busy analysis at each poll. Thus the count of its requests grows with the count of analyses. The harness now names what waits in each wait, and its `WorkSurface.list` gives the work of each analysis in one call. The cli server does not give either fact to a client yet, and the cli tests no longer compile against the new harness contract.

## What Changes

- Add `GET /api/v1/paused-work`: the paused work of each analysis, from one `work.list()` call with no analysis id. Each item has the shape of an item of `GET {A}/paused-work`, with its `analysisId`. The body has the usual list fields.
- The route leaves out the work of an analysis that has no SQLite row, the same rule as the attention read.
- The spec of `GET {A}/paused-work` names the waiter and the start of each waiting workflow. The route already passes both fields through from the harness.
- The route groups of the server get the group of the paused work of each analysis.
- The cli test fixtures obey the new harness contract: a `data-pause` part carries `cause` and `pausedAt`, and `WorkSurface.list` takes an optional analysis id.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: a new route lists the paused work of each analysis. The list of paused work of one analysis names the waiter and the start of each waiting workflow. The route groups name the new route.

## Impact

- `src/server/routes/paused_work.ts`, `src/server/app.ts`, and `src/api/paused_work.ts`.
- The tests: `src/server/routes/paused_work.test.ts`, `src/tui/hooks/pauses.test.ts`, `src/tui/hooks/conversation.test.ts`, and `src/server/routes/conversation.test.ts`.
- The cli typecheck and tests run against the working-copy harness, through `bun run harness:local`.
- No client of the cli calls the new route. A host such as Flamme reads it.
