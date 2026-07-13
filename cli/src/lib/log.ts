import { mkdirSync, openSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";

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
