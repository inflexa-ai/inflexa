## Why

The harness requires Postgres + pgvector + DBOS as its durable substrate (`harness/openspec/specs/postgres-storage-backend/spec.md`), and that substrate is the hard blocker for the CLI↔harness integration tracked in `docs/harness_integration/`. The prior research docs (`07`, `08`, `09`) over-engineered the problem: the CLI already hard-requires Docker or Podman to run CLIProxyAPI (`cli/src/modules/proxy/setup.ts:46` gates all of `inflexa setup` on `ensureReady(rt)`), so the simplest, lowest-risk path is to run a `pgvector/pgvector:pg18` container alongside the existing proxy container — the same `Bun.spawn`-the-CLI pattern `lib/container.ts` already centralizes. No embedded Postgres binaries, no `dockerode`, no new npm dependencies.

## What Changes

- **Docker Compose orchestration** — both the CLIProxyAPI proxy and the new Postgres container are managed under a single `docker-compose.yml` (or `podman-compose.yml`) generated into the CLI's data dir. The compose file puts both services on a shared `inflexa` network, so inter-container communication uses service names (`inflexa-postgres:5432`) rather than host-published ports. This eliminates the networking bug where `localhost` inside the proxy container means the proxy's own loopback, not the host's. Compose also gives a single `compose up -d` / `compose down` lifecycle for the entire inflexa infrastructure stack.
- **Rename `modules/proxy/` → `modules/infra/`** — the setup orchestrator has outgrown the "proxy" name now that it provisions two services. The module is renamed to `modules/infra/` and the orchestrator function remains `setup()`. Proxy-specific container plumbing (image, auth, config) stays in `infra/` (it's all one setup flow). The new `modules/postgres/` slice owns Postgres-specific logic (types, readiness gate, vector self-install).
- **Interactive prompts during `inflexa setup`** — the setup command now prompts for Postgres username, password, and port (with sensible defaults) via `@clack/prompts` (the existing text-command prompt layer in `lib/cli.ts`). The prompted values are persisted to `config.json` under the `postgres` key. Non-interactive terminals use the defaults silently.
- **Provision a `pgvector/pgvector:pg18` container** as part of `inflexa setup`, alongside the proxy. Container name `inflexa-postgres`, `--restart unless-stopped` (via compose), port-published, data dir bind-mounted for persistence. Image and major version are fixed — not user-overridable.
- **New `cli/src/modules/postgres/` feature slice** owning `ensurePostgresReady()` (launch-time gate, self-healing) and `ensurePostgresReadyOrExit()` (the exit-on-error wrapper the TUI calls). Reuses `lib/container.ts`'s `capture`/`inherit`/`ensureReady`/`mountArg` — no parallel spawn core.
- **Drop external-mode and image override** — the CLI always provisions its own Postgres container (mode is always `docker`). No `postgres.mode` config key, no `postgres.image` config key. This simplifies the code (no TCP probe, no psql-on-PATH external path, no mode radio in the TUI) and eliminates a failure mode (user picks a non-pgvector image). The user configures only: `host`, `port`, `database`, `user`, `password`.
- **Defaults the user can override:** database `inflexa`, user `inflexa`, password `inflexa`, host-published port `8432` (off the standard 5432). All overridable via `@clack/prompts` during setup and via the settings TUI afterward.
- **New `postgres` key in `lib/config.ts`'s zod schema** carrying the connection overrides, with a settings section in `tui/app_config.tsx` (fields: `host`, `port`, `database`, `user`, `password`). No `mode` or `image` fields.
- **New env paths** in `lib/env.ts`: `postgresDataDir` (`<data>/inflexa/postgres/`), `postgresPort` (default `8432`), and `composeFilePath` (`<data>/inflexa/docker-compose.yml`), surfaced in the `--help` Paths table.
- **Extend `inflexa setup`** to: (1) prompt for Postgres credentials/port, (2) generate the compose file, (3) run `compose up -d` to start both services, (4) wait for `pg_isready`, (5) run `CREATE EXTENSION IF NOT EXISTS vector`. Existing flags `--force` (re-pull images) and `--no-start` (set up only) extend naturally. A new `--no-postgres` flag skips the Postgres step.
- **Self-healing launch-time gate (best UX):** when `inflexa-postgres` is missing or stopped, the gate transparently provisions it (generates compose file if needed, runs `compose up -d`, waits for ready, installs pgvector). A first-time user running `inflexa` with no prior `inflexa setup` reaches a working Postgres without an explicit setup step.
- **Progress feedback** — every provisioning step surfaces clear progress messages: `"Pulling pgvector/pgvector:pg18…"`, `"Starting inflexa-postgres…"`, `"Waiting for Postgres to be ready…"`, `"Installing pgvector extension…"`. No silent waits.
- **pgvector self-install at every gate** (no `pg` npm dep): `CREATE EXTENSION IF NOT EXISTS vector` IS the install — one idempotent statement run via `docker exec psql` at `inflexa setup` AND at every launch-time gate.

## Capabilities

### New Capabilities

- `postgres-provisioning`: Provision, configure, self-heal, and lifecycle the local Postgres + pgvector container that backs the embedded harness. Owns the connection defaults & overrides, the interactive setup prompts, the compose-file generation, the `inflexa setup` integration, the self-healing launch-time gate, and the settings TUI section.

### Modified Capabilities

- `container-runtime`: Extended with compose-file support (generate and `compose up/down`). The existing `capture`/`inherit`/`ensureReady` wrapper stays unchanged; compose commands go through the same binary.

## Impact

- **Code:** rename `cli/src/modules/proxy/` → `cli/src/modules/infra/`; new `cli/src/modules/postgres/{setup.ts,types.ts,setup.test.ts}`; compose-file generation in `modules/infra/compose.ts`; edits to `cli/src/lib/{env,config}.ts`; a new `Section` variant in `cli/src/tui/app_config.tsx`; updated imports in `cli/src/cli/index.ts`.
- **Config:** `cli/src/lib/config.ts` zod schema gains an optional `postgres` object (`host`, `port`, `database`, `user`, `password`). No `mode` or `image` fields. Defaults reconstruct the `inflexa`/`inflexa`/`inflexa`/`8432` baseline.
- **Env:** `cli/src/lib/env.ts` gains `postgresDataDir`, `postgresPort`, and `composeFilePath` with corresponding `envDoc` entries.
- **Dependencies:** No new npm packages. `@clack/prompts` is already a dependency.
- **Tests:** `cli/src/modules/postgres/setup.test.ts` covers: default config reconstruction, override honor, env-path resolution, container-name/port construction. Compose-file generation tested via snapshot.
- **Out of scope:** calling `assembleCoreRuntime()` from the harness, mapping the provisioned connection into `PoolConfig` at the composition root, the `BusProvenanceAdapter`, and the `emitProvenance` callback. This change lands the substrate; the next change wires it.
