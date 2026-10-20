## Context

See `proposal.md` for the two defects and the measured container counts.

The other keyless live files in `src/providers/integration/` share one form. A
header comment names the gate. A constant `LIVE` reads
`process.env.CORTEX_LIVE_API_TESTS`. The block is
`describe.skipIf(!LIVE)(...)`. `chembl.integration.test.ts` is an example.

`src/__tests__/integration/` holds only the Monarch file.

The container fallback keeps its container promise in the module state of
`postgres.ts` (`_startPromise`). Bun 1.4.2 evaluates that module one time for
each module registry. The measurement in `proposal.md` and a probe that counts
the module evaluations agree: one evaluation for a default run, one for each
file under `--isolate` and `--parallel`, and one for each worker under
`--parallel --no-isolate`.

## Goals / Non-Goals

**Goals:**

- Make a clean-checkout `bun test` make no call to Monarch or to the citation
  authorities.
- Make each text about the container count of the fallback match the measured
  behavior.

**Non-Goals:**

- No change to the behavior of the guard, the fallback, or `test:full`.
- No shared container across the module registries of an `--isolate` or
  `--parallel` run.
- No Monarch golden fixture. The fixture tier is a different requirement.

## Decisions

### D1. One change for the two findings

The two defects are in the test infrastructure of one subsystem, and both
correct a stated fact of the suite. Only the container count needs a spec
delta. The Monarch and citation corrections make code obey requirements that
already exist. Thus a separate change for them would have no delta.

### D2. Move the Monarch test to `src/providers/integration/`

The spec requires each real-upstream test under `src/providers/integration/`,
with the name `<name>.integration.test.ts`. A gate in place would leave that
violation. The new path is `src/providers/integration/monarch.integration.test.ts`.
The relative import of `monarch-client.js` stays `../../tools/lib/...`, because
both directories are two levels below `src/`.

The move uses a plain file move in the working tree. A `git mv` is a Git
mutation, and the user owns each Git mutation.

### D3. Gate the citation-resolution block on `CORTEX_LIVE_API_TESTS`

The block calls keyless public authorities. `NCBI_API_KEY` and
`CROSSREF_MAILTO` are optional. The spec names `CORTEX_LIVE_API_TESTS` as the
gate of each keyless block. Today, with its own variable, the block stays skipped when
a developer sets `CORTEX_LIVE_API_TESTS` to run each live block. No CI file,
document, or script names `CITATION_RESOLUTION_LIVE`.

### D4. Correct the text, not the fallback

An alternative is a fallback that shares one container across module
registries, for example through a lock file. This adds design to fix a cost
that only opt-in modes pay. `test:full` and `CORTEX_TEST_PG_URL` already give
one container in each mode.

### D5. Keep `test:full`, and restate its reason

A default run now also starts one container. But the script still has three
properties that the fallback does not have:

- It needs no ryuk. Its exit trap removes the container.
- It keeps one container under `--isolate` and `--parallel`.
- It matches CI, which sets `CORTEX_TEST_PG_URL` to one service container.

The header of `scripts/test-full.sh`, the comments of `postgres.ts` and
`require-reaper.ts`, and `CLAUDE.md` state these properties in place of the
per-file claim.

### D6. The refusal states the count for each mode

The refusal keeps its reason line and both routes. Its second paragraph states
the count when database test files reach the fallback:

- one container for a default run
- one container for each database test file under `--isolate` or `--parallel`
- one container for each worker under `--parallel --no-isolate`, when that
  worker runs a database test file

Without a reaper, each of those containers stays after the run.

The existing message tests assert the routes and the podman variables. They
stay. No test asserts the prose of the count, because such a test only
duplicates a string.

## Risks / Trade-offs

- [A later Bun changes the default isolation] → The spec ties the count to the
  Bun that `.bun-version` names. A Bun upgrade that changes the default must
  update the requirement.
- [A developer runs the moved Monarch file by its old path] → The file has no
  other reference in the repository. The gate comment names the variable that
  runs it.
