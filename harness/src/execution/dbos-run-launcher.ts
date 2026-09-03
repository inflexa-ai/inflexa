/**
 * DBOS realization of the `RunLauncher` seam — the single production adapter,
 * shared by every embedder. Host-neutral: it references only DBOS and the OTel
 * API, which the harness already depends on, so it ships in the harness.
 *
 * A launch detaches the run from the caller's trace. The DBOS workflow span
 * takes the active context as its parent, and the caller is a chat request
 * (or another short-lived operation) whose span ends in milliseconds while the
 * run lasts hours. So the launch opens a root span of its own, runs
 * `startWorkflow` under it, and joins the two traces by a span link back to
 * the originating span plus `inflexa.run_id` on both sides. With no
 * TracerProvider registered every call here is a no-op on the API's
 * non-recording span.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import { context, isSpanContextValid, ROOT_CONTEXT, trace, type Link } from "@opentelemetry/api";

import type { LaunchOptions, RunLauncher } from "./run-launcher.js";

/** Attribute carrying the run id on the originating span and on the run's root span. */
export const ATTR_INFLEXA_RUN_ID = "inflexa.run_id";

const TRACER_NAME = "inflexa.harness.run-launcher";

export function createDbosRunLauncher(): RunLauncher {
    return {
        async launch<I>(workflow: (input: I) => Promise<unknown>, opts: LaunchOptions, input: I): Promise<void> {
            const originating = trace.getSpan(context.active());
            const links: Link[] = [];
            if (originating !== undefined && isSpanContextValid(originating.spanContext())) {
                originating.setAttribute(ATTR_INFLEXA_RUN_ID, opts.workflowId);
                links.push({ context: originating.spanContext() });
            }
            const root = trace.getTracer(TRACER_NAME).startSpan("launch run", { links, attributes: { [ATTR_INFLEXA_RUN_ID]: opts.workflowId } }, ROOT_CONTEXT);
            try {
                await context.with(trace.setSpan(ROOT_CONTEXT, root), () => DBOS.startWorkflow(workflow, { workflowID: opts.workflowId })(input));
            } finally {
                root.end();
            }
        },
    };
}
