# Tasks

## 1. Toolchain bump, flags, rule flips

- [x] 1.1 Pin `@inflexa-ai/oxlint-plugin` and `@inflexa-ai/typecheck` to exactly `0.8.0` in `package.json` (keep `oxlint` at `1.85.0`), run `bun install`, and verify `bun.lock` records the two pins. Then re-run `bun run lint` and `bun run typecheck` with the rules still off: if 0.8.0 adds lint reports under rules this change does not own, add an `off` entry for each such rule with the comment that names its owning child of #607 (the #609 pattern; never the six rules of this change), so both commands pass. A new typecheck error that the 0.8.0 `@inflexa-ai/typecheck` introduces is root-caused, not suppressed: fixed if it is in this change's scope, otherwise recorded for the parent. Write the re-baselined counts and any 0.8.0 drift per rule into `openspec/changes/adopt-index-access-strictness/notes.md`
- [x] 1.2 Set `noUncheckedIndexedAccess` in `harness/tsconfig.json`, remove the six `off` entries (`@inflexa-ai/no-conditional-spread`, `typescript/no-unsafe-argument`, `-assignment`, `-call`, `-member-access`, `-return`) from `oxlint.config.ts` with their `#705` comment, and verify `tsc` reaches both `src` and `scripts/**/*.ts` under the flag. A failing `bun run typecheck` at this point is the expected mid-state. Capture the fresh error count and the per-rule lint counts into `notes.md` as the worklist for groups 2-5

## 2. Index-access fallout in the render and model layer

- [x] 2.1 Fix the `noUncheckedIndexedAccess` errors of `src/report-render` (chart.ts, render.ts, number-format.ts, chart-renderers.ts, figures/*) and `src/report-model` (production-resolver.ts, draft-operations.ts, fixture-resolver.ts) by narrowing or restructuring per design D2, making one shared helper per module only where a lookup shape repeats, and verify `bun run typecheck` reports no error in those directories

## 3. Index-access fallout in the rest of src and scripts

- [x] 3.1 Fix the remaining `noUncheckedIndexedAccess` errors of `src` outside report-render/report-model (tools/*, sandbox/*, state/*, runtime/*, lib/*, workspace/*, workflows/*, tasks/*, providers/*, input-scan/*) and in `scripts/refresh-fixtures.ts` per design D2, and verify `bun run typecheck` reports no error outside `src/**/test/` and `src/**/__tests__/`

## 4. Index-access fallout in tests

- [x] 4.1 Fix the `noUncheckedIndexedAccess` errors of the test files under `src/**/test/` and `src/**/__tests__/` per design D2: a `!` only where the read's target is constructed in the same test or expression, everything else narrowed or restructured. Record the count of added `!` with the permitted-use rule and the #706 pointer in `notes.md`, and verify `bun run typecheck` passes with zero errors

## 5. Unchecked-value reports

- [x] 5.1 Fix each `typescript/no-unsafe-*` report of the live lint run by typing the value at its source per design D4 (no new `as`, no directives), and verify the five rules report nothing while the other rules of the run are unchanged

## 6. Conditional-spread reports

- [x] 6.1 Replace each `@inflexa-ai/no-conditional-spread` report with the direct property assignment per design D3 (named-variable `if`-form only where a consumer distinguishes an absent key), and verify the rule reports nothing

## 7. Final verification

- [x] 7.1 Run `bun run format:file` on each changed `src/` file, then run `bun run lint`, `bun run typecheck`, and `bun test` in `harness/` and verify all three pass (re-run a red `bun test` once before counting it as a failure, per design). Verify the emitted declarations stay consumable: run `bun run build`, then `cd ../cli && bun run harness:local && bun run typecheck`, and verify the cli typecheck passes. Verify acceptance condition 3 on the diff against the baseline commit: no added `as `, `@ts-expect-error`, `@ts-ignore`, or `oxlint-disable` line in `src` and `scripts`, and no added `!` outside the permitted test construction of design D2. Record the final counts, the added-`!` count, and the 0.8.0 drift for other children of #607 in `notes.md`; the final report carries the drift table to the parent
