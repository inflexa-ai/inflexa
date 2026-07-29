/**
 * DBOS realization of the `RunLauncher` seam — the single production adapter,
 * shared by every embedder. Host-neutral: it references only DBOS, which the harness
 * already depends on, so it ships in the harness.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";

import type { LaunchOptions, RunLauncher } from "./run-launcher.js";

export function createDbosRunLauncher(): RunLauncher {
    return {
        async launch<I>(workflow: (input: I) => Promise<unknown>, opts: LaunchOptions, input: I): Promise<void> {
            await DBOS.startWorkflow(workflow, { workflowID: opts.workflowId })(input);
        },
    };
}
