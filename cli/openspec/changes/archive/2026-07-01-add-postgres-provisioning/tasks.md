## 0. Module rename — `modules/proxy/` → `modules/infra/`

- [x] 0.1 Rename `cli/src/modules/proxy/` directory to `cli/src/modules/infra/`.
- [x] 0.2 Update all importers: `cli/src/cli/index.ts`, `cli/src/tui/app.launch.tsx` (or wherever `ensureProxyReady`/`ensureProxyReadyOrExit` is imported), and any other files that import from `modules/proxy/`.
- [x] 0.3 Verify `bun run typecheck` passes after the rename.
- [x] 0.4 Remove the TODO(slop) comment about the module name from the renamed `modules/infra/setup.ts`.

## 1. Config & env scaffolding

- [x] 1.1 Simplify the `postgres` object in `configSchema` (`cli/src/lib/config.ts`): remove `mode` and `image` fields. Keep only `host?`, `port?`, `database?`, `user?`, `password?`. Remove the TODO(slop) comments about external DB and image.
- [x] 1.2 Update `resolvePostgresConfig()` in `lib/config.ts`: return type drops `mode` and `image` fields (image is a constant in `types.ts`, not a config value). The return type is `{ host, port, database, user, password }`.
- [x] 1.3 Add `composeFilePath` (`<data>/inflexa/docker-compose.yml`) to `env.ts` alongside the existing `postgresDataDir` and `postgresPort`. Add matching rows to `envDoc`.
- [x] 1.4 Verify `bun run typecheck` passes.

## 2. Postgres module — types & constants

- [x] 2.1 Simplify `cli/src/modules/postgres/types.ts`: remove `mode` from `PostgresConnection` (always docker). Keep `image` as a constant (`DEFAULT_IMAGE`), not a field on the connection type. The `PostgresConnection` type becomes `{ host, port, database, user, password }`.
- [x] 2.2 Add constants: `DEFAULT_IMAGE = "pgvector/pgvector:pg18"` (used by compose generation and the gate, but not user-overridable).
- [x] 2.3 Remove `PostgresError` variants that only apply to external mode: `psql_missing`, `external_unreachable`. Keep: `runtime_not_ready`, `image_pull_failed`, `container_start_failed`, `ready_timeout`, `vector_install_failed`, `compose_not_available`.
- [x] 2.4 Update `SetupOptions`: keep `start`, `force`, `postgres` boolean fields.

## 3. Docker Compose generation

- [x] 3.1 Create `cli/src/modules/infra/compose.ts` with a `generateComposeFile(conn: PostgresConnection): string` function that produces a `docker-compose.yml` defining:
  - Service `inflexa-cliproxy`: image `eceasy/cli-proxy-api:latest`, port `{cliproxyPort}:{cliproxyPort}`, volumes for config and auth, `restart: unless-stopped`, on network `inflexa`.
  - Service `inflexa-postgres`: image `pgvector/pgvector:pg18`, port `{conn.port}:5432`, env vars `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, volume for data dir, `restart: unless-stopped`, on network `inflexa`.
  - Network `inflexa` with `driver: bridge`.
- [x] 3.2 Create `writeComposeFile(conn: PostgresConnection): Result<void, ComposeError>` that writes the generated compose file to `env.composeFilePath`.
- [x] 3.3 Create compose lifecycle helpers using `capture(rt, ["compose", "-f", composeFilePath, ...])`:`composeUp(rt)`, `composePull(rt)`, `composeDown(rt)`.
- [x] 3.4 Add a `composeAvailable(rt): Promise<boolean>` check that runs `{runtime} compose version` and returns whether compose is available. Surface an actionable error when missing.
- [x] 3.5 Verify the generated compose file is valid YAML and `docker compose config` accepts it.

## 4. Postgres module — provisioning functions (simplified)

- [x] 4.1 Simplify `modules/postgres/setup.ts`: remove ALL external-mode code paths (TCP probe, psql-on-PATH, `ensureExternalReady`). Remove `activeRuntimeSafe` wrapper (use `activeRuntime` directly from config).
- [x] 4.2 Keep `waitForReady(rt, conn)` — poll `pg_isready` via `docker exec`.
- [x] 4.3 Keep `ensureVectorExtension(rt, conn)` — but remove the external-mode `psql`-on-PATH branch. Only the `docker exec psql` path remains.
- [x] 4.4 Simplify `provisionPostgres(options)`: no mode check (always docker), no external skip. Orchestrates: ensureReady → composeUp → waitForReady → ensureVectorExtension.
- [x] 4.5 Remove `imageExists`, `pullImage`, `containerId`, `isPostgresRunning`, `recreateContainer`, `removeContainer`, `startStoppedContainer`, `containerMountArg` — these are replaced by compose lifecycle commands.

## 5. Interactive prompts during setup

- [x] 5.1 In `modules/infra/setup.ts`, after the proxy auth step and before Postgres provisioning, add interactive prompts using `@clack/prompts` (via `lib/cli.ts`'s `promptText`) for:
  - Username (default: `inflexa`, validation: non-empty)
  - Password (default: `inflexa`, validation: non-empty)
  - Port (default: `8432`, validation: positive integer, not already in use by the proxy)
- [x] 5.2 Persist the prompted values to `config.json` via `writeConfig`.
- [x] 5.3 If existing config already has `postgres` values, show them as defaults and offer to keep or change.
- [x] 5.4 On non-interactive terminals, skip prompts and use defaults (or existing config values).

## 6. `inflexa setup` integration (revised)

- [x] 6.1 Rewrite the setup orchestrator in `modules/infra/setup.ts` to:
  1. Ensure runtime ready
  2. Write proxy config
  3. Prompt for and authenticate provider (existing)
  4. If `options.postgres`: prompt for Postgres credentials (Section 5)
  5. Generate compose file (Section 3)
  6. If `options.start`: run `compose up -d` (starts both services)
  7. If `options.force`: run `compose pull` first (re-pulls both images)
  8. Wait for Postgres ready (`pg_isready`)
  9. Install pgvector extension
  10. Print combined next-steps
- [x] 6.2 Add progress feedback using `@clack/prompts` spinners or clear console messages at each step.
- [ ] 6.3 Verify `inflexa setup`, `inflexa setup --force`, `inflexa setup --no-start`, and `inflexa setup --no-postgres` produce expected behavior.

## 7. Self-healing launch-time gate (revised)

- [x] 7.1 Simplify `ensurePostgresReady()`: always docker mode. Generate compose file if missing → `compose up -d` → `waitForReady` → `ensureVectorExtension`. Progress messages via `console.log`.
- [x] 7.2 Keep `ensurePostgresReadyOrExit()` — calls `ensurePostgresReady()`, exits non-zero with actionable error.
- [x] 7.3 Verify error messages name the failing step and recovery path.

## 8. Settings TUI section (simplified)

- [x] 8.1 Simplify the Postgres section in `app_config.tsx`: remove `postgres_mode` section (no mode selector). Remove `image` field. Keep only: `host`, `port`, `database`, `user`, `password` as editable text fields.
- [x] 8.2 Verify the existing runtime/theme sections remain unchanged.
- [ ] 8.3 Verify the settings TUI opens cleanly via `inflexa config`.

## 9. Tests

- [x] 9.1 Update `cli/src/modules/postgres/setup.test.ts`: remove external-mode tests. Update `PostgresConnection` type tests (no `mode`, no `image` field on connection).
- [x] 9.2 Add tests for compose file generation: verify the YAML contains both services, the shared network, the correct ports and env vars.
- [ ] 9.3 Add tests for the interactive prompts: verify default values, custom values persisted, non-TTY fallback.
- [x] 9.4 Verify `bun test`, `bun run typecheck`, and `bun run lint` all pass.

## 10. `inflexa up` / `inflexa down` lifecycle commands

- [x] 10.1 Create `cli/src/modules/infra/lifecycle.ts` with `up()` and `down(options)` functions.
- [x] 10.2 `up()`: ensure runtime ready → ensure compose file → `compose up -d` → print proxy URL + Postgres port.
- [x] 10.3 `down(options)`: ensure runtime ready → if `--delete-data`: prompt "I understand" via `@clack/prompts` → `compose down` → optionally delete `postgresDataDir` and `cliproxyAuthDir`.
- [x] 10.4 Register `inflexa up` and `inflexa down --delete-data` in `cli/src/cli/index.ts`.

## 11. Environment-aware container naming (TODO(slop) resolution)

- [x] 11.1 Add `env.isDev` to `lib/env.ts` (reads `NODE_ENV`).
- [x] 11.2 In `compose.ts`, derive container/network names from `env.isDev`: `inflexa-dev-*` in dev, `inflexa-*` in prod.
- [x] 11.3 Export `PROXY_CONTAINER_NAME` and `POSTGRES_CONTAINER_NAME` from `compose.ts`; remove stale `CONTAINER_NAME` from `types.ts`.
- [x] 11.4 Update `postgres/setup.ts` to import container name from `compose.ts`.
- [x] 11.5 Update tests to use dynamic container names.

## 12. pgvector install retry (init-phase race fix)

- [x] 12.1 Add retry loop to `ensureVectorExtension` in `postgres/setup.ts`: retry on transient connection failures (terminating connection, server closed, could not connect), fail immediately on permanent errors (missing extension, privilege denied).
- [x] 12.2 30s timeout, 1s interval between retries.

## 13. Docs update

- [x] 13.1 Update the decision banners in `docs/harness_integration/08-postgres-shipping.md` and `09-postgres-options-deep-research.md` to reflect the Docker Compose approach.
- [x] 13.2 Update `docs/harness_integration/00-progress.md` with the revised decision.
