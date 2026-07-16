/**
 * Test `Logger` realizations.
 *
 * The harness names no logging library, so a test that drives a component
 * needing a logger supplies one of these rather than standing up a real logger
 * configured to say nothing. Silence is `createNoopLogger` from the production
 * seam — there is no second silent implementation to keep in step.
 */

import { createNoopLogger } from "../../lib/console-logger.js";
import type { LogFields, LogLevel, Logger } from "../../lib/logger.js";

/** Discards every record — for components whose logging is incidental to the assertion. */
export const silentLogger: Logger = createNoopLogger();

/** One record as a capturing logger saw it, with `with()`/`named()` already applied. */
export interface CapturedLog {
    level: LogLevel;
    /** The message including any `named()` prefix, exactly as a sink would receive it. */
    msg: string;
    fields: LogFields;
}

export interface CapturingLogger extends Logger {
    /** Records captured so far, in emission order. Shared across derived loggers. */
    readonly records: CapturedLog[];
}

/**
 * Collects records so a test can assert on what an operator would actually see —
 * for a diagnostic path like a step failure, the log line IS the deliverable.
 * Loggers derived via `with()`/`named()` append to the same array, so a caller
 * holds one handle regardless of how the component binds context internally.
 */
export function createCapturingLogger(): CapturingLogger {
    const records: CapturedLog[] = [];

    const at = (names: readonly string[], bindings: LogFields): CapturingLogger => {
        const emit =
            (level: LogLevel) =>
            (msg: string, fields?: LogFields): void => {
                records.push({
                    level,
                    msg: names.length > 0 ? `[${names.join(".")}] ${msg}` : msg,
                    fields: { ...bindings, ...fields },
                });
            };
        return {
            records,
            debug: emit("debug"),
            info: emit("info"),
            warn: emit("warn"),
            error: emit("error"),
            with: (extra) => at(names, { ...bindings, ...extra }),
            named: (name) => at([...names, name], bindings),
        };
    };

    return at([], {});
}
