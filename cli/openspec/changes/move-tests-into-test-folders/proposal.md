# Proposal

## Why

`@inflexa-ai/test-placement` is off in `oxlint.config.ts`, because it reports each
test file of cli: each `*.test.ts` and `*.test.tsx` sits beside the module that it
tests, and the rule wants a `test/` folder in each directory. Issue #804 (a child of
umbrella #608) moves each test first. Then each later rule-fix pull request of #608
touches each test where it now lives.

## What Changes

- Move each file of `cli/src` whose name matches `*.test.ts` or `*.test.tsx` into
  the `test/` folder of the directory that holds it: `src/<dir>/foo.test.ts` becomes
  `src/<dir>/test/foo.test.ts`. This includes each `*.render.test.tsx` file and the
  test files of `src/test_support/`. A file that is not a test (a helper of
  `src/test_support/`, a fixture folder) stays where it is.
- Change each relative import of each moved test, so that it resolves to its old
  target. Change each runtime path that a moved test computes from
  `import.meta.dir` in the same way. A relative path that is test data, not a
  location of the test, does not change.
- Replace the repeated `farm-parity` fixture path of the package-store tests with
  one shared constant of `src/test_support/`. Then no test computes that path from
  its own depth.
- `oxlint.config.ts`: delete the `"@inflexa-ai/test-placement": "off"` entry and its
  comment. Change the `excludeFiles` entries that name a test file to the new path.
- Change each directory-qualified path to a moved test in the live text of cli:
  `CLAUDE.md`, the specs, `docs/color_contrast_audit.md`, and the comments in the
  tests, in `src/test_support/`, and in `scripts/`.

## Capabilities

### New Capabilities

- `test-placement`: each test file of cli lives in a `test/` folder beside the code
  that it tests. The `@inflexa-ai/test-placement` oxlint rule is on and reports
  nothing.

### Modified Capabilities

- `fuzzy-scoring`: the requirement "Scoring contract is regression-locked by tests"
  names the suite at its new path `src/lib/test/fuzzy.test.ts`.
- `theme-system`: the requirement "WCAG AA contrast across the rendered pair matrix"
  names the contrast test at its new path `src/lib/test/design_system.contrast.test.ts`.

## Impact

- Each test file of `cli/src` moves. The import lines and the computed paths of each
  moved file change by one directory level. `bun test` finds a test by its name at
  any depth, and the `**/*.test.{ts,tsx}` globs of `oxlint.config.ts` and
  `typecheck.config.ts` do not depend on the depth.
- No source file outside the tests changes its behavior. The test support gets one
  new file, `src/test_support/fixtures.ts`. No public interface, no
  dependency, and no CI workflow changes.
- `bun run lint`, `bun run typecheck`, and `bun test` pass in cli. `bun test` keeps the
  counts of the base: the same number of files, tests, and expect() calls, 0 fail.
