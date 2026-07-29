/**
 * RunLauncher — the durability-engine launch seam.
 *
 * Async-edge tools such as `execute_analysis` start durable runs but
 * must not reach the durability engine directly — that engine is quarantined
 * out of tools and the loop. This seam is the one capability they need: start a
 * registered workflow under a caller-chosen id.
 *
 * The workflow itself stays injected — it is the registered-workflow function
 * reference, typed `(input) => Promise<result>`; the launcher only owns the
 * start/await/cancel mechanics around it.
 */

export interface LaunchOptions {
    /** Caller-chosen durable workflow id (e.g. the runId). */
    readonly workflowId: string;
}

export interface RunLauncher {
    /** Fire-and-forget: resolves once the run is durably started. */
    launch<I>(workflow: (input: I) => Promise<unknown>, opts: LaunchOptions, input: I): Promise<void>;
}
