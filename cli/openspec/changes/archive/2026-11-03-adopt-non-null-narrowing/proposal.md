# Proposal

## Why

Issue #807 (umbrella #608) turns back on the three rules that the oxlint move (#610) left off under their `#807` entries: `typescript/no-non-null-assertion`, `typescript/no-unnecessary-type-assertion`, and `typescript/no-unnecessary-condition`. With the rules forced on, this branch gives 626 non-null assertions (488 in tests), 50 unnecessary conditions, and 6 unnecessary type assertions. `noUncheckedIndexedAccess` is on in cli, thus each `!` on an index read hides an absent case that the types show. #608 is not done while a preset rule stays off outside the bun-types test exception.

## What Changes

- Remove the three `off` entries and their `#807` comment line from `cli/oxlint.config.ts`.
- Add one presence helper to `src/lib/` that asserts that a value is present, narrows its type, and fails with an error that names the read. The tests and the source use the same helper. Three independent reviewers (Codex, Pi, a Claude reviewer) and the coordinator chose each fix shape. Design D1 to D6 records the shapes, the reviewer record, and the dissent:
  - A test reads each value that it built through the helper. A `!` that is the whole argument of an `expect` whose matcher fails on an absent value goes with no helper.
  - A source `!` becomes a type that makes the value present (a restructure), or the existing absence path of its function (the `Result` error, the `null`, the skip). Only an invariant read that neither can carry uses the helper.
  - The hot typed-array and byte reads of the search index and the walk record decode read through accessor methods and a `DataView`. A measurement of `rank` before and after records the cost.
  - A condition that guards a value from outside the program keeps its guard, and a narrow parameter type corrects the type. A dead guard on a value that the program parsed, or on the one-member harness `Scope`, goes. A guard on a flag that a closure sets stays. A device clears its report. The last resort is a per-site directive that `notes.md` lists.
- No `!` becomes a `?? <placeholder>` that hides the absent case (#733 defect class), and no `!` becomes an `as`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `type-strictness`: add one requirement. The three rules report nothing, and no override turns them off. No non-null assertion remains in the TypeScript source of cli. The fix shapes are design rules of this change, not spec obligations.

## Impact

- Configuration: `cli/oxlint.config.ts` (the `#807` entries go).
- Source: each file under `cli/src/` and `cli/scripts/` that holds a report. The largest are `src/modules/fs/search_index.ts`, `src/modules/fs/walk_child.ts`, `src/tui/app_config.tsx`, `src/server/routes/analyses.ts`, and `src/tui/components/dialog/dialog_host.tsx`.
- Tests: each test file that holds a report, led by `src/modules/prov/test/`, `src/modules/infra/test/setup.test.ts`, and `src/modules/harness/test/prov_bridge.test.ts`.
- A new helper file `src/lib/present.ts` with its test. No wire format, route, database schema, or provenance change. No new dependency.
- No behavior change on a reachable path. Design D3 lists the documented differences: a broken invariant fails with an error that names the read, where today a `TypeError` follows or a wrong value flows on.
