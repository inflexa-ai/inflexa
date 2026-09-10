## Why

The `postgres-storage-backend` spec says that each database test runs against
"a single `pgvector/pgvector:pg18` container reused across the run". That is not
true on the container-fallback path. Bun gives each test file its own module
state. Thus the memoized promise in `src/__tests__/setup/postgres.ts` is not
shared. The fallback starts one container for each database test file.

Nothing but the ryuk sidecar removes those containers, and ryuk does not start
under podman. Thus a bare `bun test` left one standing container for each
database test file (issue #358). The fallback now refuses to start a container
until a reaper can remove it again. That refusal is a normative behavior of the
test setup, and the spec does not name it.

## What Changes

- Correct the container claim of the test-isolation requirement. One container
  serves a whole run only when `CORTEX_TEST_PG_URL` names one Postgres. On the
  fallback path each database test file starts its own container.
- Add the reaper guard as a requirement. The fallback refuses to start a
  container when no reaper will remove it again.
- Record the two refusal conditions that the guard reads from the environment,
  and the two that it reads from the container runtime.
- Record that the accept-the-leak route needs two variables, not one.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `postgres-storage-backend`: the test-isolation requirement drops the
  single-container claim, and a new requirement gives the reaper guard.

## Impact

- `openspec/specs/postgres-storage-backend/spec.md` — the two requirements above.
- No source change. `src/__tests__/setup/require-reaper.ts`,
  `src/__tests__/setup/postgres.ts`, and `CLAUDE.md` already hold the behavior
  that this change records.
