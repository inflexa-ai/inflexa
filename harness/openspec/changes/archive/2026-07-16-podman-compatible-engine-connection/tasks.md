# Tasks

## 1. Engine connection seam

- [x] 1.1 Add `engineSocketPath?: string` to `DockerClientConfig` (`src/sandbox/docker-client.ts`) with JSDoc carrying the docker-API-engine rationale, and construct the client as `new Docker({ socketPath })` when set — unset keeps the bare `new Docker()`; the injected test `docker?:` instance keeps precedence over both.
- [x] 1.2 Add `engineSocketPath?: string` to `CreateSandboxClientConfig` (`src/sandbox/create-sandbox.ts`, "Docker:"-scoped JSDoc beside `libStorePath`/`platform`) and thread it into the `createDockerSandboxOps` construction.
- [x] 1.3 Tests (`docker-client.test.ts`, `create-sandbox.test.ts`): a configured socket path reaches the dockerode construction; unset config produces default construction; the injected instance wins over a configured path.

## 2. Engine-agnostic recovery reconciliation

- [x] 2.1 Rework `createOrAdopt` (`src/sandbox/docker-client.ts`): drop the `statusOf(...) !== 409` gate; on any create failure, inspect the checkpointed name — a standing container enters the existing owner-guard flow unchanged (adopt running owned, remove-and-recreate stopped owned, refuse foreign), and when the inspect finds nothing the original create error is returned (the inspect's own failure is never surfaced).
- [x] 2.2 Tests: adoption succeeds when the engine answers the duplicate-name create with HTTP 500 (podman's shape) and with 409 (Docker's); a foreign-owner container is still refused with `name_conflict`; a create failure with no standing container returns the original `container_create_failed` error, not the inspect 404; a stopped owned container is removed and recreated.

## 3. Step-tree access mode

- [x] 3.1 Add `stepTreeAccess?: "world-writable"` to `CreateSandboxClientConfig` with JSDoc explaining honest-bind-ownership engines (podman machine virtiofs) vs Docker Desktop's masking layer; in `precreateStepTree`, after the mkdirs, `chmod` the step dir and each `STEP_SUBDIRS` entry to `0o777` when set — explicit `chmod` (mkdir's mode is umask-masked), applied on replay when the dirs already exist.
- [x] 3.2 Tests (`create-sandbox.test.ts`): modes applied to fresh and pre-existing step trees when set; default modes untouched when unset; read-only mount sources never re-moded.

## 4. Verification

- [x] 4.1 `tsc -p tsconfig.json` and `bun test` pass across the package.
- [x] 4.2 `bun run format:file` on every touched file under `src/`.
- [x] 4.3 `openspec validate podman-compatible-engine-connection` passes and the delta spec archives cleanly against `openspec/specs/docker-sandbox-provider/spec.md`.
