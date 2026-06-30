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
 */
export function runCli(args: string[], opts?: { cwd?: string }): CliResult {
    // Forward the full environment explicitly — crucially the test preload's sandboxed XDG_* dirs.
    // Bun.spawnSync's default env is a STARTUP SNAPSHOT that omits vars set at runtime (the preload
    // sets XDG after startup), so without this the child silently falls back to the real
    // ~/.local/share DB. `Bun.env` (not `process.env`) is the live env and sidesteps the
    // no-restricted-properties lint.
    const proc = Bun.spawnSync(["bun", "run", ENTRY, ...args], { env: { ...Bun.env }, cwd: opts?.cwd });
    return {
        exitCode: proc.exitCode,
        stdout: proc.stdout.toString(),
        stderr: proc.stderr.toString(),
    };
}
