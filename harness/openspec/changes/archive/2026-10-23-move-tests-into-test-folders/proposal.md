# Proposal

## Why

`@inflexa-ai/test-placement` is off in `oxlint.config.ts` because it reports every
test file of the harness: each `*.test.ts` sits beside the module it tests, and the
rule wants a `test/` folder in each directory. Issue #703 (a child of umbrella
#607) moves each test first, so that each later rule-fix PR of the umbrella
touches each test where it now lives.

## What Changes

- Move each `*.test.ts` file of `harness/src` into the `test/` folder of the
  directory that holds it: `src/<dir>/foo.test.ts` becomes
  `src/<dir>/test/foo.test.ts`. These are pure file moves: no test content is
  rewritten, no source file changes, and no lint report of another rule is
  fixed. The pinned lint run behind #607 counted 299 test files at its snapshot
  commit; the tree now holds 358, and each one moves.
- Change each relative import of each moved test (module imports,
  `__tests__/setup/*` imports, `__fixtures__/*` imports) and each runtime path
  that reads a fixture (`import.meta.dir` joins, `readFileSync`), by the one
  directory level that the move introduces.
- `oxlint.config.ts`: delete the `"@inflexa-ai/test-placement": "off"` entry,
  and update the `no-console` exemption path `src/lib/console-logger.test.ts`
  to `src/lib/test/console-logger.test.ts`.
- The move covers each reported file class: the 16
  `src/providers/integration/*.integration.test.ts` files, the test files inside
  `__fixtures__` trees, and the `.test.ts` files inside `src/__tests__/setup/`
  and `src/workflows/__tests__/dbos/`. A setup file whose name does not match
  `*.test.ts` stays where it is.

## Capabilities

### New Capabilities

- `test-placement`: each test file of the harness lives in a `test/` folder
  beside the code it tests; the `@inflexa-ai/test-placement` oxlint rule is on
  and reports nothing.

### Modified Capabilities

- `integration-tests-external-api`: the requirement "Real-upstream integration
  tests live under src/providers/integration and auto-skip without a key" names
  the directory `src/providers/integration/test/` after the move.

## Impact

- 358 test files move; the import and fixture paths inside the moved files
  change by one directory level. `bun test` discovery is glob-based and is
  unaffected; the tsconfig and typecheck globs are depth-independent and are
  unaffected. CI runs `bun test` unmodified.
- No public API, no source file, and no dependency changes. `bun run lint`,
  `bun run typecheck` and `bun test` must pass with the same counts as the base:
  6116 pass, 0 fail, 51 skip, 358 files.
