/**
 * The harness's operational logging seam.
 *
 * The harness ships as a published package embedded by hosts it does not
 * control, so it declares the shape it logs through and lets the embedder bind
 * a realization at its composition root — the same inversion the capability
 * seams use. Naming a concrete logger here would push that library onto every
 * consumer.
 *
 * The alternative that reads as obvious — take the embedder's logger type
 * directly — was rejected for exactly that reason. `@opentelemetry/api-logs`
 * was the other candidate, being the nearest thing to a neutral standard, but
 * it is still pre-1.0 and would force consumers into an OTel SDK to read a log
 * line. JS has no `log/slog` equivalent to conform to, so the harness defines
 * its own minimum and adapts at the edges.
 *
 * Diagnostics MUST go through here, never `console`: an embedder whose UI owns
 * stdout discards console output entirely, which is silent data loss precisely
 * when something has gone wrong. `createConsoleLogger` (`./console-logger.ts`)
 * is the one sanctioned console site.
 */

/** Severity of a log record, ascending. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Structured key/value context attached to a record. Identifiers ride here
 * rather than interpolated into the message so records stay queryable and any
 * field-name redaction the host configures can actually match them.
 */
export type LogFields = Record<string, unknown>;

/**
 * Operational logger. Message-first (`error(msg, fields?)`) — the convention
 * `slog`, winston, and `console` share. Object-first loggers exist (pino,
 * bunyan) and an embedder using one adapts at its composition root; shaping
 * this contract to match one of them would model the published surface on a
 * single consumer's choice.
 */
export interface Logger {
    debug(msg: string, fields?: LogFields): void;
    info(msg: string, fields?: LogFields): void;
    warn(msg: string, fields?: LogFields): void;
    error(msg: string, fields?: LogFields): void;
    /**
     * Bind `fields` onto every record the returned logger emits — `slog`'s
     * `With`. Lets a workflow body fix `{ runId, stepId }` once instead of
     * repeating it at each call site.
     */
    with(fields: LogFields): Logger;
    /**
     * Bind a namespace onto every record the returned logger emits, rendered as
     * a bracketed prefix on the message: `named("boot")` turns
     * `info("harness booted")` into `[boot] harness booted`.
     *
     * The namespace is a first-class part of a record, so it is declared once at
     * the seam rather than hand-typed into every message string — hand-typing is
     * what lets one module drift to `[Boot]` or drop the tag entirely. Nesting
     * composes with a dot (`named("post-step").named("reconcile")` →
     * `[post-step.reconcile]`), matching the tag convention already in use.
     */
    named(name: string): Logger;
}
