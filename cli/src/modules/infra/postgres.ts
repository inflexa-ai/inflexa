import { type Result, ok, err } from "neverthrow";
import { ensureRuntime, resolveConnectionMode, resolvePostgresConfig } from "../../lib/config.ts";
import { capture, type ContainerRuntime, type CaptureResult } from "../../lib/container.ts";
import { DEFAULT_IMAGE, type PostgresConnection, type PostgresError, type ProvisionOutcome, type SetupOptions } from "./postgres_types.ts";
import { POSTGRES_CONTAINER_NAME, composeUp, ensureComposeFile } from "./compose.ts";

// `inflexa setup` provisions a Postgres + pgvector container alongside the existing
// CLIProxyAPI proxy via Docker Compose. Both services share the `inflexa` network so
// inter-container communication uses service names (`inflexa-postgres:5432`). The
// compose file is generated into the CLI's data dir and managed by the compose
// lifecycle helpers in modules/infra/compose.ts.
//
// The pgvector self-install is one idempotent statement — `CREATE EXTENSION IF NOT
// EXISTS vector` — run at every gate (setup-time AND launch-time). It is itself the
// probe and the install in one step; no separate "is installed?" check.
//
// Postgres is `restart: unless-stopped` (via compose) and outlives a CLI session,
// matching the proxy. The gate auto-starts a stopped container and auto-provisions
// a missing one — best UX: the user's first `inflexa` invocation is a complete path
// to a working substrate.

const VECTOR_SQL = "CREATE EXTENSION IF NOT EXISTS vector";

// --- readiness + vector self-install ---------------------------------------

const READY_POLL_INTERVAL_MS = 500;
const READY_POLL_TIMEOUT_MS = 30_000;

/**
 * Poll `pg_isready` inside the container until it succeeds or the timeout expires.
 * 30s is generous for first-boot init (the image runs `initdb` on a fresh data dir).
 */
export async function waitForReady(rt: ContainerRuntime, conn: PostgresConnection): Promise<Result<void, PostgresError>> {
    const deadline = Date.now() + READY_POLL_TIMEOUT_MS;
    let lastStderr = "";
    while (Date.now() < deadline) {
        const { code, stderr } = await capture(rt, ["exec", POSTGRES_CONTAINER_NAME, "pg_isready", "-U", conn.user, "-d", conn.database]);
        if (code === 0) return ok(undefined);
        lastStderr = stderr.trim();
        await Promise.sleep(READY_POLL_INTERVAL_MS);
    }
    return err({
        type: "ready_timeout",
        message: `Postgres did not become ready within ${READY_POLL_TIMEOUT_MS / 1000}s.${lastStderr ? `\n  ${lastStderr}` : ""}\n  Check ${rt.label} logs with \`${rt.bin} logs ${POSTGRES_CONTAINER_NAME}\`.`,
    });
}

const VECTOR_RETRY_INTERVAL_MS = 1000;
const VECTOR_RETRY_TIMEOUT_MS = 30_000;

/**
 * Run `CREATE EXTENSION IF NOT EXISTS vector` via the image's bundled `psql`.
 * This single idempotent statement is both the probe and the install.
 *
 * Retries on transient connection failures: the PG Docker entrypoint runs a
 * two-phase startup (temp init server → fast shutdown → real server). Our
 * `pg_isready` poll can succeed during phase 1, so `CREATE EXTENSION` may
 * hit the fast-shutdown window and get `FATAL: terminating connection due to
 * administrator command`. The retry absorbs this — once the real server is
 * up, the next attempt succeeds.
 */
export async function ensureVectorExtension(rt: ContainerRuntime, conn: PostgresConnection): Promise<Result<void, PostgresError>> {
    const deadline = Date.now() + VECTOR_RETRY_TIMEOUT_MS;
    let lastResult: CaptureResult | null = null;

    while (Date.now() < deadline) {
        const result: CaptureResult = await capture(rt, ["exec", POSTGRES_CONTAINER_NAME, "psql", "-U", conn.user, "-d", conn.database, "-c", VECTOR_SQL]);
        if (result.code === 0) return ok(undefined);

        lastResult = result;
        const stderr = result.stderr.trim();

        // Transient: the init-phase fast shutdown killed our connection, or the
        // server isn't accepting connections yet after restart. Retry.
        if (/terminating connection|server closed the connection|connection to server was lost|could not connect/i.test(stderr)) {
            await Promise.sleep(VECTOR_RETRY_INTERVAL_MS);
            continue;
        }

        // Permanent: the extension files are missing from the image.
        if (/extension "vector" does not exist|could not open extension control file/i.test(stderr)) {
            return err({
                type: "vector_install_failed",
                message: `The pgvector extension is not available in the image ${DEFAULT_IMAGE}.\n  Re-pull with \`inflexa setup --force\`.\n  ${stderr}`,
            });
        }
        // Permanent: privilege issue.
        if (/permission denied|must be superuser/i.test(stderr)) {
            return err({
                type: "vector_install_failed",
                message: `Failed to install the vector extension — the configured user lacks superuser privilege.\n  Grant CREATEDB/SUPERUSER to \`${conn.user}\`, or run this SQL as a superuser:\n  ${VECTOR_SQL};\n  ${stderr}`,
            });
        }

        // Unknown failure — retry in case it's transient.
        await Promise.sleep(VECTOR_RETRY_INTERVAL_MS);
    }

    const stderr = lastResult?.stderr.trim() ?? "";
    return err({
        type: "vector_install_failed",
        message: `Failed to install the vector extension after ${VECTOR_RETRY_TIMEOUT_MS / 1000}s of retries.\n  ${stderr}`,
    });
}

// --- setup-time orchestration ----------------------------------------------

/**
 * Provision Postgres as part of `inflexa setup`. The compose file is generated
 * and `compose up -d` is run by the caller (modules/infra/setup.ts) — this
 * function handles the Postgres-specific post-start steps: readiness wait and
 * pgvector self-install. Returns `skipped_disabled` when `--no-postgres`.
 */
export async function provisionPostgres(options: SetupOptions): Promise<Result<ProvisionOutcome, PostgresError>> {
    const conn = resolvePostgresConfig();

    if (!options.postgres) return ok({ kind: "skipped_disabled", conn });

    const rtResult = await ensureRuntime();
    if (rtResult.isErr()) {
        return err({ type: "runtime_not_ready", message: rtResult.error.message });
    }
    const rt = rtResult.value;

    if (!options.start) return ok({ kind: "skipped_no_start", conn });

    const readyResult2 = await waitForReady(rt, conn);
    if (readyResult2.isErr()) return err(readyResult2.error);

    const vectorResult = await ensureVectorExtension(rt, conn);
    if (vectorResult.isErr()) return err(vectorResult.error);

    return ok({ kind: "provisioned", conn });
}

// --- self-healing launch-time gate -----------------------------------------

/**
 * The self-healing launch-time gate. Transparently provisions the substrate:
 * generates the compose file if missing, runs `compose up -d`, waits for ready,
 * and runs the pgvector self-install. A first-time user running `inflexa` with
 * no prior `inflexa setup` reaches a working Postgres without an explicit setup
 * step.
 */
export async function ensurePostgresReady(): Promise<Result<PostgresConnection, PostgresError>> {
    const conn = resolvePostgresConfig();

    const rtResult = await ensureRuntime();
    if (rtResult.isErr()) {
        return err({ type: "runtime_not_ready", message: rtResult.error.message });
    }
    const rt = rtResult.value;

    // Compose up is idempotent — starts only containers that aren't running.
    // The caller (ensurePostgresReadyOrExit or the TUI launch path) generates
    // the compose file if missing before calling this function; when this gate
    // is what generates it, shape it for the configured connection mode.
    const composeWriteErr = ensureComposeFile(conn, resolveConnectionMode()).match(
        () => null,
        (e) => e,
    );
    if (composeWriteErr) return err(composeWriteErr);

    console.log("  Starting inflexa containers…");
    const upResult = await composeUp(rt);
    if (upResult.isErr()) return err(upResult.error);

    console.log("  Waiting for Postgres to be ready…");
    const readyResult2 = await waitForReady(rt, conn);
    if (readyResult2.isErr()) return err(readyResult2.error);

    const vectorResult = await ensureVectorExtension(rt, conn);
    if (vectorResult.isErr()) return err(vectorResult.error);
    return ok(conn);
}

/**
 * The exit-on-error variant of {@link ensurePostgresReady} for the TUI launch path:
 * print actionable guidance and exit non-zero rather than throwing. The error
 * message names the failing step, the active runtime, and the recovery path.
 */
export async function ensurePostgresReadyOrExit(): Promise<PostgresConnection> {
    const result = await ensurePostgresReady();
    if (result.isErr()) {
        console.error(`\n  ${result.error.message}\n`);
        process.exit(1);
    }
    return result.value;
}
