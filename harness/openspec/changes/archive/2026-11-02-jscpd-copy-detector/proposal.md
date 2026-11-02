# Proposal

## Why

The lint stack (#724) turned on the oxlint preset, but no tool finds copied code.
The review of the stack (#733) found copies by hand and fixed them in
`01a46598`: the shared `asyncIterableOf` test helper (`src/lib/test/async-iterable.ts`)
replaced three array→`AsyncIterable` doubles, and the `ErrnoCodeSchema` pair and
the `holdsNoRank` inline predicate went. Decision 2 of #607 says that the fix of a
repeated shape is an abstraction that removes the shape. A copy detector gives
that decision a gate in CI (#734, part of #607), so a pull request that adds a
copy above the threshold fails instead of waiting for a hand find.

## What Changes

- harness installs `jscpd@5.4.2` as a dev dependency at an exact version.
- `harness/.jscpd.json` configures the scan: the code formats `typescript`, `tsx`,
  `javascript`, `python`, `r`, and `bash`; ignores `**/node_modules/**`,
  `**/dist/**`, and the generated gallery data directories
  (`src/report-render/gallery/data/`, `data.new/`, `data.old/`); the copy floor
  `minTokens: 100` and `minLines: 20`; and the reasons — for the floor, for each
  ignored tree, and for the data formats that stay outside the scan — in a `"//"`
  key, because JSON has no comments. The `dupes` script names the `src` and
  `scripts` trees on its command line.
- `harness/package.json` gains the script `dupes`, which runs the scan with
  `--exit-code` (exit 1 when a clone is reported) and `--fail-on-empty` (exit 1
  when the filters match no file, so a config drift cannot pass silently).
- `.github/workflows/lint.yml` runs `bun run dupes` in the `lint (harness)` job.
- Each copy that the first run reports at the chosen floor (23 clones on
  `main` at `26b04a6f`) collapses into a named shared abstraction that removes
  the shape; an ignore region keeps only a copy whose reason the design accepts,
  and the reason sits in a comment beside the marker. The production copies
  (`resolveDerivation` plus the row-selection block and the table row-bound and
  projection body, each held by `src/report-model/fixture-resolver.ts` and
  `src/report-model/production-resolver.ts`) collapse into shared helpers in
  `src/report-model/`; the test repetitions collapse into shared test helpers or
  parameterized cases. No call site is edited in place to keep its duplicate.

## Capabilities

### New Capabilities

- `copy-detection`: the jscpd gate of the harness — the pinned tool, the committed
  configuration, the `dupes` script, the CI step, and the duty of a deliberate
  copy to carry its reason.

### Modified Capabilities

None. The lint-family specs (`syntax-bans`, `test-placement`, `test-shape`) govern
the oxlint rules and keep their scope; the copy gate is a separate tool.

## Impact

- `harness/package.json` and `harness/bun.lock`: the dev dependency and the
  `dupes` script.
- `harness/.jscpd.json`: new configuration file.
- `.github/workflows/lint.yml`: one step in the `lint (harness)` job.
- The files that hold the 23 first-run clones: `src/report-model/fixture-resolver.ts`,
  `src/report-model/production-resolver.ts` (production code), and the test files
  `src/sandbox/test/k8s-client.test.ts`, `src/app/test/data-profile-orientation.test.ts`,
  `src/app/test/data-profile-view.test.ts`, `src/tools/research/test/inspect-data-profile.test.ts`,
  `src/app/test/spawn-report-session.test.ts`, `src/tools/test/start-report-session.test.ts`,
  `src/tools/test/execute-analysis.test.ts`, `src/report-model/test/validate.test.ts`,
  `src/execution/test/reconcile-manifest.test.ts`, `src/loop/test/metrics.test.ts`,
  `src/loop/test/prompt-cache.test.ts`.
- No public interface of the harness changes: the resolvers are internal, and the
  shared helper lands beside them.
