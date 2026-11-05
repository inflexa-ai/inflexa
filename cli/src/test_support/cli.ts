import { randomUUIDv7 } from "bun";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Absolute path to the CLI entry, resolved off this file's location so an optional `cwd` override
// (for anchor/cwd-sensitive commands) cannot break a relative entry path.
const ENTRY = join(import.meta.dir, "..", "index.ts");

/** The observable result of a CLI run: the three things an e2e test asserts on. */
export type CliResult = { exitCode: number; stdout: string; stderr: string };

/**
 * Run the CLI as a real subprocess (`bun run src/index.ts <args>`) and return its observables. The
 * child inherits this process's environment, so the test preload's sandboxed XDG_* dirs flow through
 * and the subprocess reads/writes the SAME isolated DB + config as the parent test (seed in the
 * parent via the test's helpers, then assert what the command prints).
 *
 * The child's streams are redirected to FILES under a fresh temp directory, and the files are read
 * back after it exits — NOT captured through pipes. Piped capture holds under a single test file but
 * empties out once the whole suite runs — the child still starts, does its work, and exits with the
 * right status, but `proc.stdout`/`proc.stderr` arrive as `""`, so every assertion about what a
 * command PRINTED fails while its exit-code assertion passes. A file has no capacity limit to hit
 * and no reader to schedule, so it is unaffected by how many other tests are running.
 */
function runWithCapturedStreams(spawn: (outFd: number, errFd: number) => number): CliResult;
function runWithCapturedStreams(spawn: (outFd: number, errFd: number) => Promise<number>): Promise<CliResult>;
function runWithCapturedStreams(spawn: (outFd: number, errFd: number) => number | Promise<number>): CliResult | Promise<CliResult> {
    const dir = mkdtempSync(join(tmpdir(), `inflexa-cli-${randomUUIDv7()}-`));
    const outPath = join(dir, "stdout");
    const errPath = join(dir, "stderr");

    // The tail both runners share. Closed before the files are read: this end must be done with them
    // for the child's writes to be guaranteed visible, and a spawn that faulted must not leak the
    // descriptors either.
    function collect(outFd: number, errFd: number, exitCode: number): CliResult {
        try {
            closeSync(outFd);
            closeSync(errFd);
            return { exitCode, stdout: readFileSync(outPath, "utf8"), stderr: readFileSync(errPath, "utf8") };
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }

    // Opened inside the guard, and each closed independently: opening the second can fail once the
    // first has succeeded, and an unguarded pair would leak that descriptor for the life of the test
    // process.
    let outFd: number | undefined;
    let errFd: number | undefined;
    try {
        outFd = openSync(outPath, "w");
        errFd = openSync(errPath, "w");
        const opened = { outFd, errFd };
        const exitCode = spawn(outFd, errFd);
        if (!(exitCode instanceof Promise)) return collect(outFd, errFd, exitCode);
        // The async runner's exit code lands after the child exits, so the collect — and the same
        // no-leak guard for a faulted wait — ride the promise.
        return exitCode.then(
            (code) => collect(opened.outFd, opened.errFd, code),
            (cause: unknown) => {
                closeSync(opened.outFd);
                closeSync(opened.errFd);
                rmSync(dir, { recursive: true, force: true });
                throw cause;
            },
        );
    } catch (cause) {
        if (outFd !== undefined) closeSync(outFd);
        if (errFd !== undefined) closeSync(errFd);
        rmSync(dir, { recursive: true, force: true });
        throw cause;
    }
}

/**
 * The synchronous runner: the child inherits this process's environment, and the test preload's
 * sandboxed XDG_* dirs flow through. `Bun.env` (not `process.env`) is the live env and sidesteps the
 * no-restricted-properties lint — Bun.spawnSync's default env is a STARTUP SNAPSHOT that omits vars
 * set at runtime (the preload sets XDG after startup), so without the explicit forward the child
 * silently falls back to the real ~/.local/share DB.
 */
export function runCli(args: string[], opts?: { cwd?: string; env?: Record<string, string> }): CliResult {
    return runWithCapturedStreams(
        (outFd, errFd) =>
            Bun.spawnSync(["bun", "run", ENTRY, ...args], {
                env: { ...Bun.env, ...opts?.env },
                cwd: opts?.cwd,
                stdout: outFd,
                stderr: errFd,
            }).exitCode,
    );
}

/**
 * {@link runCli}, but the parent waits without a block of its event loop. Use it for an `instance` command
 * against a server of `startTestServer` (test_support/server.ts): that server runs in THIS process, and the
 * `Bun.spawnSync` of {@link runCli} blocks the event loop that must answer the requests of the child, thus a
 * sync run waits on itself until the child gives up. Pass `server.childEnv` as `env`.
 */
export async function runCliAsync(args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<CliResult> {
    return runWithCapturedStreams(async (outFd, errFd) => {
        const proc = Bun.spawn(["bun", "run", ENTRY, ...args], { env: { ...Bun.env, ...opts?.env }, cwd: opts?.cwd, stdout: outFd, stderr: errFd });
        return await proc.exited;
    });
}
