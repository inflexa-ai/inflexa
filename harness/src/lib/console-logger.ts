/**
 * The trivial `Logger` realizations: one that writes to `console`, and the
 * silent fallback the harness substitutes when an embedder wires nothing.
 *
 * `createConsoleLogger` is offered, never defaulted. A host whose UI owns
 * stdout (an alternate-screen TUI, for instance) discards console output, so
 * defaulting to it would quietly reintroduce the invisible-diagnostics failure
 * the seam exists to prevent — the default is `createNoopLogger`, which is at
 * least honest about saying nothing.
 */

import { defaultErrorFields, type LogFields, type LogLevel, type Logger } from "./logger.js";

/** Renders accumulated namespace segments as the message's `[a.b]` prefix. */
function prefixed(names: readonly string[], msg: string): string {
    return names.length > 0 ? `[${names.join(".")}] ${msg}` : msg;
}

/**
 * `with()` accumulates into `bindings` and `named()` into `names`; each record
 * merges call-site fields over the bindings, so a narrower call-site key
 * deliberately wins over inherited context.
 */
function makeConsoleLogger(names: readonly string[], bindings: LogFields): Logger {
    const emit =
        (level: LogLevel) =>
        (msg: string, fields?: LogFields): void => {
            // The one sanctioned console site in the harness — writing to console is
            // this function's entire contract. `no-console` exempts this file by path
            // in eslint.config.js rather than by an inline disable here.
            console[level](prefixed(names, msg), { ...bindings, ...fields });
        };

    return {
        debug: emit("debug"),
        info: emit("info"),
        warn: emit("warn"),
        error: emit("error"),
        with: (extra) => makeConsoleLogger(names, { ...bindings, ...extra }),
        named: (name) => makeConsoleLogger([...names, name], bindings),
        // console renders whatever it is handed; there is no native error
        // serializer here to defer to, so the shipped default is the right shape.
        errorFields: defaultErrorFields,
    };
}

/** Build a `Logger` that writes each record to the matching `console` method. */
export function createConsoleLogger(): Logger {
    return makeConsoleLogger([], {});
}

/**
 * Build a `Logger` that discards every record. This is what the harness falls
 * back to when an embedder injects no logger, so internal call sites can log
 * unconditionally instead of threading `?.` through every diagnostic.
 */
export function createNoopLogger(): Logger {
    const noop: Logger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        with: () => noop,
        named: () => noop,
        // Still the real mapping, not `{}`: callers spread the result into fields
        // they may pass elsewhere, so it must stay honest even when nothing is emitted.
        errorFields: defaultErrorFields,
    };
    return noop;
}
