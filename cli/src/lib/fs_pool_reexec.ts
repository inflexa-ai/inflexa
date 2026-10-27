import { err, ok, type Result } from "neverthrow";

import { SERVE_DETACHED_CHILD_FLAG } from "./child_flags.ts";
import { fsPoolVar, processEnv, serverChildEnv } from "./env.ts";
import { selfInvocation } from "./self_invocation.ts";

/** Replaces this process with `file`, run with `args` and `env`. It returns only when the replacement fails. */
export type Execve = (file: string, args: readonly string[], env: Record<string, string | undefined>) => void;

/** The root options of the CLI that take a value: the value is not the command word. */
const ROOT_VALUE_OPTIONS: ReadonlySet<string> = new Set(["--analysis", "--project"]);

/** The command word of `argv`: the first token that is not an option and not the value of a root option. */
function commandWord(argv: readonly string[]): string | null {
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token === undefined) return null;
        if (ROOT_VALUE_OPTIONS.has(token)) {
            i++;
            continue;
        }
        if (!token.startsWith("-")) return token;
    }
    return null;
}

/**
 * What {@link ensureServerFsPool} did when it returned: `not_needed` when this process keeps its pool, `replaced` when
 * `execve` returned with no error, which only an `execve` that a test gives can do.
 */
export type FsPoolReexec = "not_needed" | "replaced";

/** The replacement of the process failed, thus this process keeps the default file pool. */
export type FsPoolReexecError = { type: "execve_failed"; cause: unknown };

/**
 * Run the foreground `inflexa serve` again with the file pool of the server, through `execve`, when `env` does not size
 * the pool. `argv` holds the arguments after the executable and the entry. On success `execve` replaces the process and
 * this never returns.
 *
 * The pool size is read by the runtime at its first async file call, and an assignment to `process.env` inside the
 * process does not reach it. Only the environment of a new process sets it, thus the server process replaces itself. A
 * call on a hung mount holds its pool thread forever, and the default pool of one thread for each core is small enough
 * that one request can trap each thread of the server.
 *
 * It does nothing in these cases:
 * - The command is not `serve`.
 * - `--detach`: the parent starts no server, and it gives the pool to its child in the environment of the spawn.
 * - The detached child flag: the variable is in its environment already.
 * - `env` sets the variable: the value of the person wins, also when it is small.
 * - Windows: `process.execve` does not exist there, thus a foreground server on Windows keeps the default pool of
 *   libuv, 4 threads. The detached start, which each client uses, gives the pool on each platform.
 */
export function ensureServerFsPool(
    argv: readonly string[],
    execve: Execve | undefined,
    env: Record<string, string | undefined>,
    platform: NodeJS.Platform,
): Result<FsPoolReexec, FsPoolReexecError> {
    if (commandWord(argv) !== "serve") return ok("not_needed");
    if (argv.includes("--detach") || argv.includes(SERVE_DETACHED_CHILD_FLAG)) return ok("not_needed");
    if (platform === "win32" || execve === undefined) return ok("not_needed");
    if (env[fsPoolVar] !== undefined) return ok("not_needed");
    try {
        execve(process.execPath, selfInvocation(argv), serverChildEnv(env));
        return ok("replaced");
    } catch (cause) {
        return err({ type: "execve_failed", cause });
    }
}

// At the evaluation of this module, which the entry imports first: no module opened the log stream or started a file
// call yet. A failed replacement leaves a server with the default pool, which still serves, thus it warns and goes on.
ensureServerFsPool(process.argv.slice(2), process.execve, processEnv(), process.platform).match(
    () => undefined,
    (e) => console.error(`Could not start the server again with a larger file pool (${String(e.cause)}). It runs with the default pool.`),
);
