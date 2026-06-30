/**
 * RunLauncher — the durability-engine launch seam.
 *
 * The async-edge tools (`execute_plan`, `run_ephemeral`) start durable runs but
 * must not reach the durability engine directly — that engine is quarantined
 * out of tools and the loop. This seam is the one capability they need: start a
 * registered workflow under a caller-chosen id, either fire-and-forget or
 * awaiting its result inline. `launchAndAwait` hides the engine's cancellation
 * behind a discriminated outcome, so no engine error type leaks to callers.
 *
 * The workflow itself stays injected — it is the registered-workflow function
 * reference, typed `(input) => Promise<result>`; the launcher only owns the
 * start/await/cancel mechanics around it.
 */

export interface LaunchOptions {
    /** Caller-chosen durable workflow id (e.g. the runId). */
    readonly workflowId: string;
}

export interface LaunchRunOptions {
    /** Aborting cancels the in-flight run; wired internally by the launcher. */
    readonly signal: AbortSignal;
}

/** Result of an awaited launch: the value on completion, or a cancelled
 * sentinel that replaces the engine's cancellation error. */
export type LaunchOutcome<R> = { readonly status: "completed"; readonly result: R } | { readonly status: "cancelled" };

export interface RunLauncher {
    /** Fire-and-forget: resolves once the run is durably started. */
    launch<I>(workflow: (input: I) => Promise<unknown>, opts: LaunchOptions, input: I): Promise<void>;

    /** Start the run and await its result inline, wiring cancel-on-abort. */
    launchAndAwait<I, R>(workflow: (input: I) => Promise<R>, opts: LaunchOptions, input: I, runOpts: LaunchRunOptions): Promise<LaunchOutcome<R>>;
}
