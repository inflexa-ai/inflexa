import { mkdirSync, openSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
// Type-only: erased at compile, so this low-level module gains no runtime edge on the
// harness package. The realization below is a pure adapter over our own pino instance.
import type { LogFields, Logger } from "@inflexa-ai/harness";

import { env } from "./env.ts";

const MAX_LOG_AGE_DAYS = 7;
const MAX_LOG_BYTES = 20 * 1024 * 1024;
const LOG_FILE_PATTERN = /^inflexa-(\d{4})-(\d{2})-(\d{2})(?:\.\d+)?\.log$/;

/**
 * The local calendar date of `date`, as `YYYY-MM-DD`.
 *
 * The file name is read by a person on this machine, in `ls`, so it carries the date that
 * person's clock shows. An ISO slice would carry the UTC date instead, which at a positive
 * offset names the day before for every record until the offset elapses.
 */
export function localDay(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${String(date.getFullYear()).padStart(4, "0")}-${month}-${day}`;
}

/**
 * Milliseconds from `now` until the next local midnight.
 *
 * `setHours(24, 0, 0, 0)` walks the local calendar rather than adding a fixed 24 hours, so
 * a day that a daylight-saving change makes 23 or 25 hours long still lands on its own
 * boundary.
 */
export function msUntilNextLocalMidnight(now: Date): number {
    const next = new Date(now.getTime());
    next.setHours(24, 0, 0, 0);
    return next.getTime() - now.getTime();
}

/**
 * The file that records go into for the local day of `now`, after a retention sweep of `dir`.
 *
 * It runs at startup and again at each midnight roll, so a long-lived TUI session gets the
 * same treatment as a fresh command. A file that grows past {@link MAX_LOG_BYTES} inside one
 * day keeps its file until one of those two moments comes around.
 */
export function rotatedLogFile(dir: string, now: Date): string {
    try {
        const cutoff = now.getTime() - MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000;
        for (const name of readdirSync(dir)) {
            const match = LOG_FILE_PATTERN.exec(name);
            // The stamp is read as local midnight of that day, the same calendar the name was
            // written on. `Date.parse("YYYY-MM-DD")` would read UTC midnight and shift the age of
            // every file by the offset of the machine. A group that somehow did not match yields
            // NaN, and a NaN comparison is false, so an unreadable name keeps its file.
            if (match && new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime() < cutoff) {
                rmSync(join(dir, name), { force: true });
            }
        }
    } catch {
        // Missing directory (first run) or scan failure — rotation is
        // best-effort and must not prevent logging.
    }

    const today = localDay(now);
    let file = join(dir, `inflexa-${today}.log`);
    for (let n = 2; ; n++) {
        try {
            if (statSync(file).size < MAX_LOG_BYTES) return file;
        } catch {
            return file;
        }
        file = join(dir, `inflexa-${today}.${n}.log`);
    }
}

/** The part of a sonic-boom destination that a midnight roll drives. */
export type RollableDestination = {
    /** Writes the buffered records out, then calls back — with an error when they did not land. */
    flush(cb: (err?: Error) => void): void;
    /** Swaps the underlying fd onto `file`, in place, keeping the stream identity. */
    reopen(file: string): void;
};

/** Everything {@link scheduleMidnightRoll} reads from the world, so a test can hand it a clock and a directory. */
type MidnightRollDeps = {
    /** The log directory that the file of the new day is named in. */
    dir: string;
    /** The file the destination is open on right now. The roll compares the new name against it. */
    currentFile: string;
    /** The clock, read once per fire. */
    now: () => Date;
    /** Arms a one-shot timer. The caller decides whether that timer holds the process open. */
    setTimer: (fn: () => void, ms: number) => void;
};

/**
 * Move `destination` onto the file of the new day at each local midnight.
 *
 * One timer to the boundary, a flush, a reopen, then the timer armed again — the mechanism of
 * `pino-roll`, run in-process on the destination the cli already holds. Nothing is added to the
 * write path, and no worker thread is started.
 *
 * The flush is what keeps the two days apart. `reopen` does not flush by itself, so records that
 * were buffered before the swap would otherwise land in the file of the new day.
 *
 * No failure escapes the timer callback: an error thrown there ends the process, which is an
 * absurd price for a log file. A roll that fails leaves the records on the fd that is already
 * open — the file of the previous day, which is stale but is still a real file — and the timer
 * arms again for the next boundary.
 */
export function scheduleMidnightRoll(destination: RollableDestination, deps: MidnightRollDeps): void {
    let current = deps.currentFile;

    function arm(from: Date): void {
        deps.setTimer(fire, msUntilNextLocalMidnight(from));
    }

    function fire(): void {
        // The next boundary is measured from the moment this actually ran, not from the moment it
        // was planned for: a machine that slept through midnight fires the overdue timer on wake,
        // and the boundary after that one is a whole day from now, not from the missed midnight.
        const at = deps.now();
        try {
            const next = rotatedLogFile(deps.dir, at);
            // An early fire, or a clock that jumped backward, names the file that is already open.
            // There is nothing to swap then, and reopening would only lose the buffered records.
            if (next !== current) {
                destination.flush((err) => {
                    // The buffer did not reach the old file. Holding the fd where it is keeps those
                    // records aimed at the day they belong to, and the next boundary tries again.
                    if (err) return;
                    try {
                        destination.reopen(next);
                        current = next;
                    } catch {
                        // An unopenable path (a directory that went away, a permission change).
                        // `current` stays behind, so the fire of the next boundary retries the swap.
                    }
                });
            }
        } catch {
            // The sweep and the name scan both touch the filesystem. Logging is best-effort, and
            // this frame is the last one before the timer, so the failure stops here.
        }
        arm(at);
    }

    arm(deps.now());
}

function resolveLevel(): pino.Level {
    const requested = env.logLevel;
    if (requested && Object.hasOwn(pino.levels.values, requested)) {
        return requested as pino.Level;
    }
    return "info";
}

const level = resolveLevel();

/**
 * The file destination's fd must be valid from construction: pino registers an exit hook that
 * flush-syncs this stream, and a fast-failing command (a `fail()` at the CLI boundary) can reach
 * `process.exit` before an asynchronous open completes — sonic-boom's `flushSync` then throws
 * "sonic boom is not ready yet" on the still-unopened stream, spraying a stack trace after the
 * command's real message. A numeric `dest` is adopted as the stream's fd synchronously in its
 * constructor, so the one-time synchronous open here closes that window; `sync: false` still keeps
 * every WRITE asynchronous (the terminal-safety and throughput intent of the destination).
 *
 * The opened path comes back beside the stream because the midnight roll starts from it.
 */
function openFileDestination(): { destination: ReturnType<typeof pino.destination>; file: string } {
    const file = rotatedLogFile(env.logDir, new Date());
    try {
        mkdirSync(env.logDir, { recursive: true });
        const destination = pino.destination({ dest: openSync(file, "a"), sync: false });
        // A stream built from a numeric fd carries no path: sonic-boom records `file` only when it
        // opens one itself, and `reopen` reads that single field as its gate — with the field unset
        // it throws "Unable to reopen a file descriptor". Naming the path we opened is therefore what
        // makes the midnight roll legal on the synchronously opened fd above. The write is the same
        // one sonic-boom's own `fileOpened` makes after every open; only the published type omits the
        // field, which is the whole reason for the cast.
        (destination as ReturnType<typeof pino.destination> & { file: string }).file = file;
        return { destination, file };
    } catch {
        // Unwritable log location (a broken environment): fall back to the path-based asynchronous
        // open, which reports failures on the stream instead of throwing here — logging is
        // best-effort and must never take the command down with it. The exit-flush window remains
        // open in this corner, but only where logging is already failing anyway. No `file` write is
        // needed on this branch: sonic-boom sets the field itself when it opens from a path.
        return { destination: pino.destination({ dest: file, mkdir: true, sync: false }), file };
    }
}

const { destination: fileDestination, file: openedLogFile } = openFileDestination();

// sonic-boom reports a failed open and a failed write by emitting `error`, and pino's own handler
// re-emits everything that is not EPIPE. An `error` that nothing listens for is an uncaught
// exception, so without this listener a log directory that is deleted under a live session ends the
// command at the next midnight reopen — the try-catch around the reopen cannot see it, because the
// open is asynchronous. The stream keeps whichever fd is already open when a reopen fails, so the
// records keep landing. There is nowhere to report the failure either: the TUI owns the terminal,
// and the log file is the thing that just broke. Silence is the accepted price for a live command.
fileDestination.on("error", () => {});

// A session that outlives the day must land its records in the file of that day, and `unref` keeps
// the timer from being the reason a short command stays alive. pino builds this destination with
// `minLength: 0`, which makes sonic-boom hand each record to `fs.write` as it arrives and makes its
// `flush` return without writing, so the roll's flush moves nothing: the records that can still
// cross into the new day are the ones queued behind a write that was already in flight.
scheduleMidnightRoll(fileDestination, {
    dir: env.logDir,
    currentFile: openedLogFile,
    now: () => new Date(),
    setTimer: (fn, ms) => {
        setTimeout(fn, ms).unref();
    },
});

const streams = pino.multistream([{ level, stream: fileDestination }]);

/**
 * The TUI owns stdout/stderr (alternate-screen mode) — the file is the only
 * terminal-safe destination. Redaction lives here, on the root, so every
 * stream (file and any telemetry export added later) sees identical records.
 */
const root = pino(
    {
        level,
        base: { pid: process.pid },
        redact: {
            paths: ["text", "prompt", "delta", "*.text", "*.prompt", "*.delta"],
            censor: "[REDACTED]",
        },
    },
    streams,
);

export function getLogger(module: string): pino.Logger {
    return root.child({ module });
}

/**
 * Realize the harness's `Logger` seam over a pino child.
 *
 * The harness names no logging library — pino is the cli's choice, so the mapping
 * belongs here rather than in the published package. Two shape differences to
 * bridge: the seam is message-first (`slog`/winston/console order) where pino is
 * object-first, and `named()` renders a `[a.b]` prefix onto the message where
 * pino's `child` binds fields.
 *
 * `named` deliberately prefixes the message rather than binding a `module` field:
 * `getLogger("harness")` already owns that field, and the harness's records have
 * always read `[dbos] launched` in the log file. Binding it instead would silently
 * restyle every existing line.
 *
 * `errorFields` defers to pino's own `err` serializer by handing the raw value
 * through under `err` — pino renders type/message/stack from it, which is strictly
 * richer than the harness's string mapping and is exactly why the seam puts this
 * on the interface.
 *
 * It lives beside `getLogger` rather than at a composition root because it has two
 * callers that reach the harness independently: the embedder root wiring
 * `bootHarness`, and the chat turn engine wiring `runAgent`. A private copy in
 * either is how one of them ends up silent.
 */
function pinoAsHarnessLogger(pino: pino.Logger, names: readonly string[] = []): Logger {
    function prefixed(msg: string): string {
        return names.length > 0 ? `[${names.join(".")}] ${msg}` : msg;
    }
    function emit(level: "debug" | "info" | "warn" | "error"): (msg: string, fields?: LogFields) => void {
        return (msg, fields) => pino[level](fields ?? {}, prefixed(msg));
    }
    return {
        debug: emit("debug"),
        info: emit("info"),
        warn: emit("warn"),
        error: emit("error"),
        with: (fields) => pinoAsHarnessLogger(pino.child(fields), names),
        named: (name) => pinoAsHarnessLogger(pino, [...names, name]),
        errorFields: (err) => ({ err }),
    };
}

/**
 * The harness `Logger` for one module namespace — the seam realization every
 * harness entry point in the cli passes down.
 *
 * Every path that hands the harness a logger MUST come through here. A harness
 * deps bag that omits it resolves to `createNoopLogger()` and the component goes
 * silent, which reads exactly like a component that never ran.
 */
export function harnessLogger(module: string): Logger {
    return pinoAsHarnessLogger(getLogger(module));
}

export function addLogStream(stream: pino.DestinationStream): void {
    streams.add({ level, stream });
}

export function flushLogs(): Promise<void> {
    return new Promise((resolve) => {
        root.flush(() => resolve());
    });
}

/** For process.on("exit"), where only synchronous work runs. */
export function flushLogsSync(): void {
    try {
        fileDestination.flushSync();
    } catch {
        // A failed final flush must not turn a clean exit into a crash.
    }
}
