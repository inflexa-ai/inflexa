# Proposal

## Why

Issue #806 (umbrella #608) turns back on the three assertion rules that the oxlint move (#610) left off under their `#806` entries: `@inflexa-ai/require-assertion-safety`, `typescript/no-unsafe-type-assertion`, and `@inflexa-ai/no-double-cast`. On this branch, the rules give 1694 reports at 717 unique `file:line` sites, and 559 of the sites are in test files. Most sites are a cast where the code trusts data with no check. #608 is not done while a preset rule stays off outside the bun-types test exception.

## What Changes

- Remove the three `off` entries and their `#806` comment line from `cli/oxlint.config.ts`.
- Fix each report with an abstraction at the boundary that owns the data, not with a comment at each site. Three independent reviewers (Codex, Pi, a Claude reviewer) and the coordinator chose each fix shape with no dissent. Design D1 to D6 records the shapes and the reviewer record:
  - The success body of the local-server wire keeps one documented trust point in `src/client/api.ts`.
  - The error body gets one zod schema that the client and the route tests share. It replaces the hand guard `isApiError`.
  - The route tests read each JSON body as `unknown` and assert it with whole-value matchers. A test that computes on the body parses a small schema.
  - The database reads bind the row type on the statement (`query<Row, Params>`).
  - The test doubles get complete builders, narrow structural parameter types, and a typed `fetch` stub.
  - The lost narrowings get a zod parse, an errno helper, and a cast-free membership guard.
- Keep each boundary that skips one bad item today. Add a test with a malformed item at each such boundary that this change edits (#733 W1).
- Keep a `SAFETY:` comment only on a cast that the compiler already accepts as a widening and that holds a real invariant. Keep an inline `oxlint-disable-next-line typescript/no-unsafe-type-assertion -- <reason>` only where no parse, guard, or type can carry the invariant. `notes.md` lists each survivor.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `type-strictness`: add the requirement that the three assertion rules report nothing and that no override turns them off. The fix shapes are design rules of this change, not spec obligations.

## Impact

- Configuration: `cli/oxlint.config.ts` (the `#806` entries go).
- Source: each file under `cli/src/` and `cli/scripts/` that holds a report. The largest are `src/db/primary_query.ts`, `src/modules/infra/setup.ts`, `src/modules/libs/store_download.ts`, `scripts/build.ts`, `src/modules/harness/config.ts`, `src/modules/embedding/setup.ts`, and `src/client/api.ts`.
- Tests: each test file that holds a report, led by `src/server/routes/test/`. New shared test helpers go in `src/test_support/`.
- `src/api/common.ts` gets the error-body schema. No wire format, route, database schema, or provenance change. No new dependency.
- No behavior change on valid input. Design D6 lists the documented deviations on malformed input, for example `unpackTo`: a function that promises a `Result` and throws today on a parseable but malformed input gives its existing error variant. The error-body schema accepts exactly the bodies that `isApiError` accepts today.
