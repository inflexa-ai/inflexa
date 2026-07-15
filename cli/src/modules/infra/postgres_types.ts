// Postgres substrate for the embedded harness. The CLI provisions a
// `pgvector/pgvector` container alongside the existing CLIProxyAPI proxy
// (Docker or Podman, see lib/container.ts), and the future harness-wiring change
// reads the resolved {@link PostgresConnection} to build a `PoolConfig` at the
// composition root.
//
// The provisioning lifecycle lives in setup.ts (with its owning module, rather
// than in lib/ which is reserved for cross-cutting infrastructure). The pieces
// the TUI/launch path reuse are `ensurePostgresReady()` and its exit-on-error
// variant `ensurePostgresReadyOrExit()`.

/**
 * Fixed image — PG 18 + pgvector bundled. Matches the harness's own
 * testcontainer convention (harness/AGENTS.md: `pgvector/pgvector:pg18`).
 * Not user-overridable; power users edit the compose file directly.
 */
export const DEFAULT_IMAGE = "pgvector/pgvector:pg18";

/**
 * Default host-published port. Off the standard 5432 (clashes with a user's
 * system PG) and 5433 (claimed by the harness testcontainer). Rhymes with the
 * proxy's owned port 8317.
 */
export const DEFAULT_PORT = 8432;

/** Default database, user, and password — local-only, user-overridable via config. */
export const DEFAULT_DATABASE = "inflexa";
export const DEFAULT_USER = "inflexa";
export const DEFAULT_PASSWORD = "inflexa";

/** In-container Postgres port — the image listens here; we publish {@link DEFAULT_PORT} over it. */
export const CONTAINER_PG_PORT = 5432;

/**
 * In-container Postgres data path. PG 18+ uses major-version-specific subdirectories
 * under `/var/lib/postgresql/` (e.g. `18/main`), so the mount MUST be at the parent
 * directory — NOT at `/var/lib/postgresql/data` (which PG 18 rejects as a legacy
 * layout). See https://github.com/docker-library/postgres/pull/1259.
 */
export const CONTAINER_DATA_PATH = "/var/lib/postgresql";

/**
 * Fully-resolved Postgres connection — every field populated, no `undefined`.
 * Produced by {@link resolvePostgresConfig} (lib/config.ts) from the optional
 * `config.json` `postgres` key + per-field defaults. The future harness-wiring
 * change hands this to `createPool` as a `PoolConfig`.
 */
export type PostgresConnection = {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
};

/**
 * Expected, user-actionable provisioning failures. Discriminated by `type` per
 * the cli error convention (domain errors are unions, not Error subclasses) so
 * callers get exhaustive `switch` and zero prototype overhead.
 */
export type PostgresError =
    | { type: "runtime_not_ready"; message: string }
    | { type: "image_pull_failed"; image: string; message: string }
    | { type: "container_start_failed"; message: string }
    // The mount-source integrity guard could not make a bind-mount source usable before the engine ran
    // (e.g. a non-empty entry occupies the file-typed proxy config path). Its message already carries the
    // diagnosis + remediation naming the path, so consumers render it verbatim like the other variants.
    | { type: "mount_source_unavailable"; message: string }
    | { type: "container_stop_failed"; message: string }
    | { type: "compose_file_write_failed"; message: string }
    | { type: "ready_timeout"; message: string }
    | { type: "vector_install_failed"; message: string }
    | { type: "compose_not_available"; message: string };

/** Ordinal result of a provisioning run — what the orchestrator did (or skipped). */
export type ProvisionOutcome =
    | { kind: "provisioned"; conn: PostgresConnection }
    | { kind: "skipped_disabled"; conn: PostgresConnection }
    | { kind: "skipped_no_start"; conn: PostgresConnection };

/** Options threaded from the `inflexa setup` command flags. */
export type SetupOptions = {
    start: boolean;
    force: boolean;
    postgres: boolean;
};
