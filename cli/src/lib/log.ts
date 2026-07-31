import { mkdirSync, openSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
// Type-only: erased at compile, so this low-level module gains no runtime edge on the
// harness package. The realization below is a pure adapter over our own pino instance.
import type { LogFields, Logger } from "@inflexa-ai/harness";

import { env } from "./env.ts";

const MAX_LOG_AGE_DAYS = 7;
const MAX_LOG_BYTES = 20 * 1024 * 1024;
const LOG_FILE_PATTERN = /^inflexa-(\d{4}-\d{2}-\d{2})(?:\.\d+)?\.log$/;

/**
 * Rotation runs once, at startup — the CLI is short-lived, so every
 * invocation sweeps retention. A session crossing midnight or 20MB
 * keeps its file until the next run.
 */
function rotatedLogFile(): string {
    try {
        const cutoff = Date.now() - MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000;
        for (const name of readdirSync(env.logDir)) {
            const match = LOG_FILE_PATTERN.exec(name);
            if (match && Date.parse(match[1]!) < cutoff) {
                rmSync(join(env.logDir, name), { force: true });
            }
        }
    } catch {
        // Missing directory (first run) or scan failure — rotation is
        // best-effort and must not prevent logging.
    }

    const today = new Date().toISOString().slice(0, 10);
    let file = join(env.logDir, `inflexa-${today}.log`);
    for (let n = 2; ; n++) {
        try {
            if (statSync(file).size < MAX_LOG_BYTES) return file;
        } catch {
            return file;
        }
        file = join(env.logDir, `inflexa-${today}.${n}.log`);
    }
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
 */
function openFileDestination(): ReturnType<typeof pino.destination> {
    const file = rotatedLogFile();
    try {
        mkdirSync(env.logDir, { recursive: true });
        return pino.destination({ dest: openSync(file, "a"), sync: false });
    } catch {
        // Unwritable log location (a broken environment): fall back to the path-based asynchronous
        // open, which reports failures on the stream instead of throwing here — logging is
        // best-effort and must never take the command down with it. The exit-flush window remains
        // open in this corner, but only where logging is already failing anyway.
        return pino.destination({ dest: file, mkdir: true, sync: false });
    }
}

const fileDestination = openFileDestination();

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
