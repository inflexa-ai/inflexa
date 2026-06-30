/**
 * DBOS realization of the `RunLauncher` seam — the single production adapter,
 * shared by every embedder. Host-neutral: it references only DBOS, which the harness
 * already depends on, so it ships in the harness.
 */

import { DBOS, Error as DBOSErrors } from "@dbos-inc/dbos-sdk";

import type { LaunchOptions, LaunchOutcome, LaunchRunOptions, RunLauncher } from "./run-launcher.js";

export function createDbosRunLauncher(): RunLauncher {
    return {
        async launch<I>(workflow: (input: I) => Promise<unknown>, opts: LaunchOptions, input: I): Promise<void> {
            await DBOS.startWorkflow(workflow, { workflowID: opts.workflowId })(input);
        },

        async launchAndAwait<I, R>(workflow: (input: I) => Promise<R>, opts: LaunchOptions, input: I, runOpts: LaunchRunOptions): Promise<LaunchOutcome<R>> {
            const handle = await DBOS.startWorkflow(workflow, {
                workflowID: opts.workflowId,
            })(input);

            // Registered only after the workflow row is persisted — an abort racing a
            // not-yet-started workflow would `cancelWorkflow` a missing row (no-op)
            // and, being `{ once: true }`, never fire again, blocking `getResult`.
            const cancel = () => {
                void DBOS.cancelWorkflow(opts.workflowId);
            };
            if (runOpts.signal.aborted) cancel();
            else runOpts.signal.addEventListener("abort", cancel, { once: true });

            try {
                const result = await handle.getResult();
                return { status: "completed", result };
            } catch (e) {
                if (e instanceof DBOSErrors.DBOSWorkflowCancelledError) {
                    return { status: "cancelled" };
                }
                throw e;
            }
        },
    };
}
