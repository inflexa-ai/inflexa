/**
 * DBOS realization of the `RunLauncher` seam — the single production adapter,
 * shared by every embedder. Host-neutral: it references only DBOS and the OTel
 * API, which the harness already depends on, so it ships in the harness.
 *
 * Outside a workflow the launch starts the run with `DBOS.startWorkflow`. A
 * tool call of a chat turn runs inside a step, and DBOS refuses a start or an
 * enqueue from a step. Thus inside a workflow the launch enqueues the run
 * through a `DBOSClient` on the run queue, which no step check covers, and
 * which keeps the run out of the children of the caller. Both paths take the
 * run id as the workflow id, and DBOS gives back the existing workflow for an
 * id that it holds. Thus a second launch of one run id starts nothing.
 *
 * A launch detaches the run from the caller's trace. The DBOS workflow span
 * takes the active context as its parent, and the caller is a chat request
 * (or another short-lived operation) whose span ends in milliseconds while the
 * run lasts hours. So the launch opens a root span of its own, runs
 * `startWorkflow` under it, and joins the two traces by a span link back to
 * the originating span plus `inflexa.run_id` on both sides. An enqueued run
 * starts on the dispatch loop of the queue, in no trace of the launch, and
 * `inflexa.run_id` joins it. With no TracerProvider registered every call here
 * is a no-op on the API's non-recording span.
 */

import { DBOS, type DBOSClient } from "@dbos-inc/dbos-sdk";
import { context, isSpanContextValid, ROOT_CONTEXT, trace, type Link } from "@opentelemetry/api";
import type { Pool } from "pg";

import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { dbosClientFor } from "./dbos-workflow-purger.js";
import type { LaunchOptions, RunLauncher } from "./run-launcher.js";

/** Attribute carrying the run id on the originating span and on the run's root span. */
export const ATTR_INFLEXA_RUN_ID = "inflexa.run_id";

/** The queue of a run that a launch inside a workflow enqueues. It has no limit, thus a run waits only for the poll of the queue. */
export const RUN_QUEUE = "analysis-runs";

const TRACER_NAME = "inflexa.harness.run-launcher";

export type DbosRunLauncherDeps = {
    /** A pool onto the system database of the engine: the same database that the application pool holds. */
    readonly pool: Pool;
    readonly logger?: Logger;
};

export function createDbosRunLauncher(deps: DbosRunLauncherDeps): RunLauncher {
    const logger = (deps.logger ?? createNoopLogger()).named("run-launcher");
    let queueRegistered: Promise<unknown> | undefined;

    const registerRunQueue = (client: DBOSClient): Promise<unknown> => {
        queueRegistered ??= client.registerQueue(RUN_QUEUE, { onConflict: "never_update" }).catch((cause: unknown) => {
            queueRegistered = undefined;
            throw cause;
        });
        return queueRegistered;
    };

    const enqueue = async <I>(workflow: (input: I) => Promise<unknown>, opts: LaunchOptions, input: I): Promise<void> => {
        const client = await dbosClientFor(deps.pool, logger);
        await registerRunQueue(client);
        // The run runs the code of this version, the same as a start in this process.
        await client.enqueue({ workflowName: workflow.name, queueName: RUN_QUEUE, workflowID: opts.workflowId, appVersion: DBOS.applicationVersion }, input);
    };

    return {
        async launch<I>(workflow: (input: I) => Promise<unknown>, opts: LaunchOptions, input: I): Promise<void> {
            const inWorkflow = DBOS.isWithinWorkflow();
            const originating = trace.getSpan(context.active());
            const links: Link[] = [];
            if (originating !== undefined && isSpanContextValid(originating.spanContext())) {
                originating.setAttribute(ATTR_INFLEXA_RUN_ID, opts.workflowId);
                links.push({ context: originating.spanContext() });
            }
            const root = trace.getTracer(TRACER_NAME).startSpan("launch run", { links, attributes: { [ATTR_INFLEXA_RUN_ID]: opts.workflowId } }, ROOT_CONTEXT);
            try {
                if (inWorkflow) {
                    await enqueue(workflow, opts, input);
                    return;
                }
                await context.with(trace.setSpan(ROOT_CONTEXT, root), () => DBOS.startWorkflow(workflow, { workflowID: opts.workflowId })(input));
            } finally {
                root.end();
            }
        },
    };
}
