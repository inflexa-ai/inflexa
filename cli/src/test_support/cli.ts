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
 * Runs the CLI as a real subprocess (`bun run src/index.ts <args>`) and returns its observables.
 * The child inherits this process's environment, so the test preload's sandboxed XDG_* dirs flow
 * through and the subprocess reads/writes the SAME isolated DB + config as the parent test (seed in
 * the parent via {@link freshDb}, then assert what the command prints).
 *
 * Uses `Bun.spawnSync`, NOT async `Bun.spawn` + piped stdout: the async form returns empty piped
 * output under `bun test` (oven-sh/bun#24690).
 *
 * The child's streams are redirected to FILES rather than captured through pipes, and the files are
 * read back after it exits. Piped capture holds under a single test file but empties out once the
 * whole suite runs — the child still starts, does its work, and exits with the right status, but
 * `proc.stdout`/`proc.stderr` arrive as `""`, so every assertion about what a command PRINTED fails
 * while its exit-code assertion passes. A file has no capacity limit to hit and no reader to schedule,
 * so it is unaffected by how many other tests are running.
 */
export function runCli(args: string[], opts?: { cwd?: string }): CliResult {
    const dir = mkdtempSync(join(tmpdir(), `inflexa-cli-${randomUUIDv7()}-`));
    const outPath = join(dir, "stdout");
    const errPath = join(dir, "stderr");
    const outFd = openSync(outPath, "w");
    const errFd = openSync(errPath, "w");
    try {
        let exitCode: number;
        try {
            // Forward the full environment explicitly — crucially the test preload's sandboxed XDG_* dirs.
            // Bun.spawnSync's default env is a STARTUP SNAPSHOT that omits vars set at runtime (the preload
            // sets XDG after startup), so without this the child silently falls back to the real
            // ~/.local/share DB. `Bun.env` (not `process.env`) is the live env and sidesteps the
            // no-restricted-properties lint.
            exitCode = Bun.spawnSync(["bun", "run", ENTRY, ...args], { env: { ...Bun.env }, cwd: opts?.cwd, stdout: outFd, stderr: errFd }).exitCode;
        } finally {
            // Closed before the files are read: this end must be done with them for the child's writes
            // to be guaranteed visible, and a spawn that threw must not leak the descriptors either.
            closeSync(outFd);
            closeSync(errFd);
        }
        return { exitCode, stdout: readFileSync(outPath, "utf8"), stderr: readFileSync(errPath, "utf8") };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
