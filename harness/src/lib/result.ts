/**
 * neverthrow conventions for cortex.
 *
 * The agent loop and execution boundary model failure as values, not throws.
 * The house rules:
 *
 *  1. `try/catch` lives ONLY inside the thin wrappers at calls to code
 *     external to ours — a third-party SDK, the `pg` driver, `fs`, the DBOS
 *     runtime. Those wrappers turn a throw into an `err(DomainError)`.
 *     Everything above them flows `Result` / `ResultAsync`.
 *  2. Absence is NOT an error. A "not found" stays in the ok channel as a
 *     data variant (`ok({ found: false })`), never an `err`. `err` is
 *     reserved for what used to be `throw`n — an unexpected upstream failure.
 *  3. A `Result` is unwrapped at exactly three edges, each speaking its own
 *     dialect of failure:
 *       - HTTP routes `.match(...)` a `Result` into a response.
 *       - The DBOS step boundary throws on `err` (`unwrapOrThrow` /
 *         `resultStep` in `loop/run-step.ts`): durability records a step as
 *         failed — and retries / fails fast — ONLY on a thrown exception, so
 *         an `err` crossing `DBOS.runStep` MUST become a throw.
 *       - Tool dispatch maps `err` into an `is_error` `tool_result`
 *         (`loop/run-agent.ts`).
 *
 * Control-flow exceptions (DBOS cancellation, `AbortError`) are NOT failures
 * and live OUTSIDE the `Result` error channel — they are thrown verbatim and
 * must never be captured as an `err`.
 *
 * Sites import `ok`/`err`/`Result`/`ResultAsync`/`fromPromise`/`fromThrowable`
 * directly from `neverthrow`; this module owns only the cortex-specific glue.
 */

import { Err, Ok, type Result } from "neverthrow";

/**
 * The shape every per-subsystem error union shares: a string `type`
 * discriminant plus an optional underlying `cause`. Concrete modules narrow
 * `type` to their own literals and add typed fields (e.g. `DbError`,
 * `SandboxError`), and ship a `describe*Error` formatter that turns one into
 * a user-facing line. A step body's error channel is some `DomainError`.
 */
export interface DomainError {
    readonly type: string;
    readonly cause?: unknown;
}

/**
 * A thrown wrapper for a structured error value that is not already an
 * `Error`. The original value rides on `.cause`, so the cause-walking
 * classifiers (`classifyProviderError`, `isBudgetExceeded`) still reach the
 * `status` / `code` signals they look for after a `Result` is rethrown at a
 * boundary.
 */
export class ResultError extends Error {
    constructor(readonly value: unknown) {
        super(describe(value), { cause: value });
        this.name = "ResultError";
    }
}

function describe(value: unknown): string {
    if (value instanceof Error) return value.message;
    if (value && typeof value === "object" && "type" in value) {
        // Prefer a human `message` field when the structured error carries one
        // (e.g. a `ProviderError`) so the wrapped `Error.message` stays
        // pattern-matchable (`isBudgetExceeded`'s message backstop); fall back
        // to the `type` discriminant otherwise.
        const message = (value as { message?: unknown }).message;
        if (typeof message === "string" && message.length > 0) return message;
        return String((value as DomainError).type);
    }
    return String(value);
}

/**
 * Bridge a `Result` error value into a thrown `Error` at a boundary that
 * speaks exceptions. An error that is already an `Error` is thrown verbatim
 * (its class, `.cause`, and any `status` survive); anything else is wrapped
 * in `ResultError` with the structured value on `.cause`.
 */
export function toThrowable(value: unknown): Error {
    return value instanceof Error ? value : new ResultError(value);
}

/**
 * Unwrap a `Result`, throwing on `err`. The canonical Result→throw bridge for
 * the DBOS step edge and any other boundary whose failure protocol is an
 * exception (a driver's throw-to-rollback). The throw is isolated here so the
 * rest of the code stays Result-shaped.
 *
 * Use it ONLY where a throw is the boundary's failure contract:
 *
 *  - **DBOS workflow/step bodies** (directly, or composed via `resultStep` in
 *    `loop/run-step.ts`). DBOS records a step as failed — and retries / fails
 *    fast — only on a thrown exception; a *returned* `err` would be durably
 *    cached as a successful step output and replayed as success forever.
 *  - **Tool `execute` bodies**, where the loop's dispatch catch maps the
 *    throw into a model-visible error tool result (`loop/run-agent.ts`).
 *  - **Driver edges whose protocol is a throw** (e.g. throw-to-rollback).
 *
 * Anywhere else, keep the `Result` flowing: return it, chain
 * `.andThen`/`.map`/`.mapErr`, or `.match` both branches. Never reach for
 * this to dodge error handling in composable domain logic.
 *
 * The `must-use-result` lint rule recognizes `unwrapOrThrow(...)` as
 * consuming its Result (see the plugin patch in `eslint.config.js`) — do not
 * rewrite call sites into inline `.match`+throw forms to appease lint.
 */
export function unwrapOrThrow<T, E>(result: Result<T, E>): T {
    if (result.isErr()) throw toThrowable(result.error);
    return result.value;
}

/** Runtime brand check — is this value a neverthrow `Result`? */
export function isResult(value: unknown): value is Result<unknown, unknown> {
    return value instanceof Ok || value instanceof Err;
}
