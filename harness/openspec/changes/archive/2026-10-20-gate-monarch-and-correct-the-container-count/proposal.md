## Why

Two facts of the harness test suite are wrong.

The Monarch live test (`src/__tests__/integration/monarch.test.ts`) makes a real
call to the Monarch Initiative API on each `bun test`. It has no gate. The
`integration-tests-external-api` spec requires the gate
`describe.skipIf(!process.env.CORTEX_LIVE_API_TESTS)` for a keyless provider.
Thus the suite depends on the network: a Monarch 502 failed one full run.

The test documents say that Bun gives each test file its own module state. Thus,
they say, the container fallback starts one container for each database test
file. This is false for the pinned Bun (1.4.2, `.bun-version`). A default
`bun test` runs each file in one process with one module registry, and it
starts one container for the whole run. Only `--isolate` and `--parallel` give
a fresh module registry to each file. The spec, the refusal message of the
guard, and `CLAUDE.md` state the wrong cost, and agents read them.

Measured on a rootful podman machine, with `CORTEX_TEST_PG_URL` unset:

| Command | Database test files | pgvector containers |
| --- | --- | --- |
| `bun test` | 3 | 1 |
| `bun test --isolate` | 3 | 3 |
| `bun test --parallel=2` | 4 | 4 |
| `bun test --parallel=2 --no-isolate` | 4 | 2 |

## What Changes

- Gate the Monarch live block on `CORTEX_LIVE_API_TESTS`, with the pattern of
  the other keyless files in `src/providers/integration/`.
- Move the Monarch live test to
  `src/providers/integration/monarch.integration.test.ts`. The spec requires
  that location and that name for a real-upstream test.
- Gate the live citation-resolution block on `CORTEX_LIVE_API_TESTS` in place
  of `CITATION_RESOLUTION_LIVE`. The block is keyless, and the spec names
  `CORTEX_LIVE_API_TESTS` for each keyless block. No other file names
  `CITATION_RESOLUTION_LIVE`.
- Correct the container count of the fallback in these places:
  - the comments of `src/__tests__/setup/postgres.ts` and
    `src/__tests__/setup/require-reaper.ts`
  - the refusal message
  - the header of `scripts/test-full.sh`
  - the Testing section of `CLAUDE.md`
  - the spec
- Keep the guard and `bun run test:full` with no behavior change. A default run
  still starts one container, and only ryuk removes it. The script still starts
  one container without ryuk, and it keeps one container under `--isolate` and
  `--parallel`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `postgres-storage-backend`: the test-isolation requirement states the container count of the fallback for each Bun test mode,
  in place of one container for each test file. Its scenario for the fallback
  changes to match.

The `integration-tests-external-api` requirements do not change. The Monarch
and citation-resolution files start to obey them.

## Impact

- `src/__tests__/integration/monarch.test.ts`, moved to
  `src/providers/integration/monarch.integration.test.ts`.
- `src/providers/integration/citation-resolution.integration.test.ts`.
- `src/__tests__/setup/postgres.ts` and `src/__tests__/setup/require-reaper.ts`.
  The tests in `src/__tests__/setup/require-reaper.test.ts` stay unchanged.
- `scripts/test-full.sh`, the header comment only.
- `CLAUDE.md`, the Testing section.
- `openspec/specs/postgres-storage-backend/spec.md`.
- No product code changes. CI is not affected: the harness job sets
  `CORTEX_TEST_PG_URL`, and it sets no live-test variable.
