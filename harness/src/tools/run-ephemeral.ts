/**
 * run_ephemeral — ad-hoc data exploration in a read-only sandbox.
 *
 * Authorizes the run at the async edge via the RunAuthorizer seam, then starts
 * the ephemeral workflow through the RunLauncher seam and awaits its result
 * inline within the chat turn. Chat disconnect cancels the run; the
 * authorization is revoked on every terminal path. The workflow is never
 * recovered — a turn-scoped exploration outliving its turn has no value.
 *
 * Available to: conversation-agent.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import type { RunAuthorizer } from "../execution/run-authorizer.js";
import type { RunLauncher } from "../execution/run-launcher.js";
import { EPHEMERAL_WORKFLOW_PREFIX, type EphemeralResult, type EphemeralWorkflowInput } from "../execution/ephemeral-runner.js";
import { generateExecutionId } from "../sandbox/execution-id.js";
import { defineTool } from "./define-tool.js";

const inputSchema = z.object({
    prompt: z
        .string()
        .min(1)
        .describe(
            "What to compute. Be specific: which files to read, what analysis to " + "run, what output format to return (table, statistics, base64 plot).",
        ),
});

export interface RunEphemeralToolDeps {
    /** Registered ephemeral workflow callable. */
    readonly workflow: (input: EphemeralWorkflowInput) => Promise<EphemeralResult>;
    /** Authorizes the run at the async edge and revokes on the terminal path. */
    readonly runAuthorizer: RunAuthorizer;
    /** Starts the durable run — the durability engine stays behind this seam. */
    readonly runLauncher: RunLauncher;
}

export interface RunEphemeralToolOutput {
    readonly text: string;
    readonly durationMs: number;
}

/** Build the `run_ephemeral` tool bound to the registered workflow + mint deps. */
export function createRunEphemeralTool(deps: RunEphemeralToolDeps) {
    return defineTool({
        id: "run_ephemeral",
        description:
            "Run a quick computation on the analysis data in a read-only sandbox. " +
            "Use for ad-hoc data exploration: inspect a CSV, compute statistics, " +
            "generate plot data, preview transformations. The sandbox cannot " +
            "create or save files — results are returned inline. For persistent " +
            "analyses that produce artifacts, use generate_plan + executePlan instead.",
        inputSchema,
        execute: async (input, ctx) => {
            const { session } = ctx;
            if (session.scope.kind !== "analysis") {
                throw new Error("run_ephemeral requires an analysis-scoped session — got " + session.scope.kind);
            }
            if (!session.auth) {
                throw new Error("run_ephemeral: session is missing its auth capability");
            }

            const authorization = await deps.runAuthorizer.authorize({
                auth: session.auth,
                scope: session.scope,
                provenance: session.provenance,
                frame: { runId: "ephemeral", stepId: "ephemeral" },
            });
            const { runSession } = authorization;

            const execId = generateExecutionId("ephemeral-executor");
            const workflowId = `${EPHEMERAL_WORKFLOW_PREFIX}${execId}`;

            try {
                const outcome = await deps.runLauncher.launchAndAwait(
                    deps.workflow,
                    { workflowId },
                    { runSession, prompt: input.prompt },
                    { signal: ctx.signal },
                );
                if (outcome.status === "cancelled") {
                    return ok({ text: "(ephemeral exploration cancelled)", durationMs: 0 });
                }
                return ok({
                    text: outcome.result.text,
                    durationMs: outcome.result.durationMs,
                });
            } finally {
                await deps.runAuthorizer.revoke(authorization, "ephemeral-completed").catch(() => {});
            }
        },
    });
}
