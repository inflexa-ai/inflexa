import { SHUTDOWN_DRAIN_LIMIT_MS, type ShutdownAccepted, type ShutdownMode } from "../api/server.ts";
import { abortRunningTurns, refuseNewTurns, runningTurnCount, whenNoRunningTurns } from "./turns.ts";

/**
 * How long a stop waits for the aborted turns to unwind. Each turn then records its end and sends its terminal
 * frame before the process exits.
 */
export const ABORT_GRACE_MS = 5_000;

/** The stop of one server process, as the routes see it. */
export type ServerLifecycle = {
    /**
     * Start the stop of the server, and give at once. The first request sets the mode. A later request starts
     * nothing and gives the mode of the first.
     */
    requestShutdown(mode: ShutdownMode): ShutdownAccepted;
    /** The mode of the stop in progress, or `null` while the server runs. */
    stopping(): ShutdownMode | null;
    /**
     * A stop signal: Ctrl+C, SIGTERM, or SIGHUP. With no stop in progress, it starts a `now` stop that exits with
     * `exitCode`. During a stop, it exits at once with `exitCode`, and the mode of that stop stays.
     */
    stopForSignal(exitCode: number): void;
    /** True when a signal started the stop in progress. */
    stoppedBySignal(): boolean;
};

/** The turn registry, the clock, and the process exit of a stop. Tests replace each one. */
export type ServerLifecycleOpts = {
    readonly drainLimitMs: number;
    readonly abortGraceMs: number;
    readonly refuseNewTurns: () => void;
    readonly runningTurnCount: () => number;
    readonly abortRunningTurns: () => void;
    readonly whenNoRunningTurns: () => Promise<void>;
    readonly sleep: (ms: number) => Promise<void>;
    /**
     * End the process. Real: `shutdown(0)` of `lib/shutdown.ts`, which runs the shutdown hooks (the runtime, the
     * provenance flush) and then the exit hooks (the discovery file, the instance locks). `code` is 0 for a stop
     * that a client asked for, and the conventional 128 + signal number for a signal.
     */
    readonly exit: (code: number) => Promise<unknown>;
};

/** The production {@link ServerLifecycleOpts}, without the process exit, which the composition root supplies. */
export const DEFAULT_SERVER_LIFECYCLE_OPTS: Omit<ServerLifecycleOpts, "exit"> = {
    drainLimitMs: SHUTDOWN_DRAIN_LIMIT_MS,
    abortGraceMs: ABORT_GRACE_MS,
    refuseNewTurns,
    runningTurnCount,
    abortRunningTurns,
    whenNoRunningTurns,
    sleep: (ms) => Promise.sleep(ms),
};

/**
 * Make the stop holder of one server process. A stop refuses each new chat turn at once. A `drain` stop waits
 * for the running turns up to the drain limit. Then each mode aborts the turns that still run, waits a short
 * grace for them to unwind, and exits.
 */
export function createServerLifecycle(opts: ServerLifecycleOpts): ServerLifecycle {
    let current: ShutdownMode | null = null;
    let bySignal = false;

    async function stop(mode: ShutdownMode, exitCode: number): Promise<void> {
        if (mode === "drain") await Promise.race([opts.whenNoRunningTurns(), opts.sleep(opts.drainLimitMs)]);
        opts.abortRunningTurns();
        await Promise.race([opts.whenNoRunningTurns(), opts.sleep(opts.abortGraceMs)]);
        await opts.exit(exitCode);
    }

    function start(mode: ShutdownMode, exitCode: number): ShutdownAccepted {
        current = mode;
        opts.refuseNewTurns();
        const activeTurns = opts.runningTurnCount();
        void stop(mode, exitCode);
        return { mode, activeTurns };
    }

    return {
        requestShutdown(mode) {
            if (current !== null) return { mode: current, activeTurns: opts.runningTurnCount() };
            return start(mode, 0);
        },
        stopping: () => current,
        stopForSignal(exitCode) {
            if (current !== null) {
                void opts.exit(exitCode);
                return;
            }
            bySignal = true;
            start("now", exitCode);
        },
        stoppedBySignal: () => bySignal,
    };
}
