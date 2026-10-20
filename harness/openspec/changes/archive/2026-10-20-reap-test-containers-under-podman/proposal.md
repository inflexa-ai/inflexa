## Why

The guard of the container fallback (`src/__tests__/setup/require-reaper.ts`)
advertises a bypass: `CORTEX_TEST_ALLOW_LEAKED_PG=1` with
`TESTCONTAINERS_RYUK_DISABLED=true`. The refusal message, `CLAUDE.md`, and the
`postgres-storage-backend` spec name it. Agents take the bypass, and each run
leaves its `pgvector/pgvector:pg18` containers and their anonymous volumes
standing. One machine collected 10 running containers and 113
dangling volumes.

The bypass rests on a false premise: "ryuk does not start under podman". On a
rootful podman machine, ryuk starts when it runs privileged. SELinux in the VM
blocks the runtime socket for an unprivileged ryuk. A probe on such a machine
started ryuk with `TESTCONTAINERS_RYUK_PRIVILEGED=true` alone. After the process
exited, ryuk removed the pgvector container, its anonymous volume, and itself.

## What Changes

- **BREAKING** (test setup only): remove `CORTEX_TEST_ALLOW_LEAKED_PG`. No
  variable lets the fallback start a container without a running reaper.
- Keep the refusal when `TESTCONTAINERS_RYUK_DISABLED=true`.
- The guard sets `TESTCONTAINERS_RYUK_PRIVILEGED=true` when that variable is
  unset, before it starts the reaper. Thus a plain `bun test` on a rootful podman
  machine starts ryuk, and ryuk removes each container and its volume after the
  run. A value that the developer set stays.
- The refusal message names the podman variables in place of the bypass.
- Correct the text that says ryuk does not start under podman, in the guard
  comment, `CLAUDE.md`, and the spec.
- `scripts/test-full.sh` names its container and sets its exit trap before
  `docker run`. Thus an interrupt during `docker run` cannot leave a container
  and its anonymous volume.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `postgres-storage-backend`: the requirement "The container fallback starts a
  container only when ryuk runs" replaces the requirement "The container
  fallback refuses to leak a container". The new requirement has no
  accept-the-leak route. It records the privileged default of ryuk, and it names
  the podman variables in the refusal. A new requirement, "The full-suite script
  removes its container", records the cleanup of `test-full.sh` on an exit and
  on an interrupt.

## Impact

- `src/__tests__/setup/require-reaper.ts` and
  `src/__tests__/setup/require-reaper.test.ts`.
- `scripts/test-full.sh`.
- `CLAUDE.md`, the Testing section.
- `openspec/specs/postgres-storage-backend/spec.md`.
- No product code changes. CI is not affected, because the harness job sets
  `CORTEX_TEST_PG_URL` and never reaches the guard.
