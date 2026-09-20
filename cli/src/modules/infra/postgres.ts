import { type Result, ok, err } from "neverthrow";
import { ensureRuntime, resolveConnectionMode, resolvePostgresConfig } from "../../lib/config.ts";
import { capture, type ContainerRuntime, type CaptureResult } from "../../lib/container.ts";
import { DEFAULT_IMAGE, type PostgresConnection, type PostgresError, type ProvisionOutcome, type SetupOptions } from "./postgres_types.ts";
import { POSTGRES_CONTAINER_NAME, composeUp, writeComposeFile } from "./compose.ts";

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
// One exit during a first start is possible on a small machine, so a single restart is not yet a loop.
// The second restart lands a second or two after the first, so the margin costs almost nothing.
const CRASH_LOOP_RESTARTS = 2;
const LOG_TAIL_LINES = 20;

/**
 * The engine's count of policy restarts for the Postgres container, or `null` when it is unknown — the
 * container does not exist yet, the engine is unreachable, or the engine reports no such field. Unknown
 * is in-band, not an error: the caller then keeps its plain timeout path.
 */
async function readRestartCount(rt: ContainerRuntime): Promise<number | null> {
    const { code, stdout } = await capture(rt, ["container", "inspect", "--format", "{{.RestartCount}}", POSTGRES_CONTAINER_NAME]);
    if (code !== 0) return null;
    const text = stdout.trim();
    return /^\d+$/.test(text) ? Number(text) : null;
}

/**
 * The last lines of the Postgres container log as an indented message block, or `""` when the engine
 * cannot give them — a failed `logs` call must never hide the diagnosis it was meant to decorate. Both
 * streams are read, because the image's entrypoint writes the `initdb` failure to stderr. They are
 * joined stream by stream, so the order ACROSS the two streams is lost; for a 20-line tail whose job is
 * to show one fatal line, that is acceptable.
 */
async function logTailBlock(rt: ContainerRuntime): Promise<string> {
    const { code, stdout, stderr } = await capture(rt, ["logs", "--tail", String(LOG_TAIL_LINES), POSTGRES_CONTAINER_NAME]);
    if (code !== 0) return "";
    const lines = [stdout, stderr].flatMap((stream) => stream.split("\n")).filter((line) => line.trim() !== "");
    if (lines.length === 0) return "";
    return `\n  Last lines of the container log:\n${lines.map((line) => `    ${line}`).join("\n")}`;
}

/**
 * Poll `pg_isready` inside the container until it succeeds, the container proves to be in a restart loop,
 * or the timeout expires. 30s is generous for first-boot init (the image runs `initdb` on a fresh data dir).
 *
 * A restart loop is detected from the engine's restart COUNT, read after every failed poll:
 * - The count, not the status. In a loop the status moves between `running`, `exited`, and `restarting`,
 *   and a 500ms poll can read `running` every time. The count only rises.
 * - A RISE, not a value. The count lasts for the life of the container, so a container that the engine
 *   restarted once last month is healthy today. The first good read is the baseline, and only a rise
 *   above it during this wait counts.
 * - A rise of {@link CRASH_LOOP_RESTARTS}, not of 1 — see the constant.
 *
 * A healthy first boot never raises the count: the image's two-phase startup restarts the SERVER inside
 * the container, not the container. An engine that reports no count degrades to the plain timeout.
 *
 * Both failures carry the tail of the container log, because the cause (for example `initdb` failing to
 * `chmod` its data directory) is only there — without it a restart loop reads as a slow start.
 */
export async function waitForReady(rt: ContainerRuntime, conn: PostgresConnection): Promise<Result<void, PostgresError>> {
    const deadline = Date.now() + READY_POLL_TIMEOUT_MS;
    let lastStderr = "";
    let baselineRestarts: number | null = null;
    while (Date.now() < deadline) {
        const { code, stderr } = await capture(rt, ["exec", POSTGRES_CONTAINER_NAME, "pg_isready", "-U", conn.user, "-d", conn.database]);
        if (code === 0) return ok(undefined);
        lastStderr = stderr.trim();

        const restarts = await readRestartCount(rt);
        if (restarts !== null) {
            baselineRestarts ??= restarts;
            if (restarts - baselineRestarts >= CRASH_LOOP_RESTARTS) {
                return err({
                    type: "container_crash_loop",
                    message: `The Postgres container keeps restarting, so it cannot become ready.${await logTailBlock(rt)}\n  See the full log with \`${rt.bin} logs ${POSTGRES_CONTAINER_NAME}\`.`,
                });
            }
        }
        await Promise.sleep(READY_POLL_INTERVAL_MS);
    }
    return err({
        type: "ready_timeout",
        message: `Postgres did not become ready within ${READY_POLL_TIMEOUT_MS / 1000}s.${lastStderr ? `\n  ${lastStderr}` : ""}${await logTailBlock(rt)}\n  Check ${rt.label} logs with \`${rt.bin} logs ${POSTGRES_CONTAINER_NAME}\`.`,
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

    // Compose up is idempotent — starts only containers that aren't running. Regenerate the compose file
    // from current config first: the file the engine executes and the mount-source guard composeUp runs
    // then derive from the same connection mode in the same invocation, so a file left on disk under an
    // earlier mode cannot out-drift the guard.
    const mode = resolveConnectionMode();
    const composeWriteErr = writeComposeFile(conn, mode).match(
        () => null,
        (e) => e,
    );
    if (composeWriteErr) return err(composeWriteErr);

    // composeUp runs the mount-source integrity guard for this mode before the engine — the same seam
    // every compose-up path shares, so this gate needs no guard of its own.
    console.log("  Starting inflexa containers…");
    const upResult = await composeUp(rt, mode);
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
