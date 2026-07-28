/** Launch a focused, plan-less durable run and return immediately. */

import { randomUUID } from "node:crypto";
import { ok } from "neverthrow";
import { z } from "zod";

import type { RunAuthorizer } from "../execution/run-authorizer.js";
import type { RunLauncher } from "../execution/run-launcher.js";
import { buildAdhocRunCardData } from "../memory/card-builders.js";
import type { RunAdhocInput, RunAdhocResult } from "../workflows/run-adhoc.js";
import { defineTool } from "./define-tool.js";

const inputSchema = z.object({
    prompt: z.string().min(1).describe("The focused computation or analysis task to carry out and persist in the adhoc run."),
});

export interface RunAdhocToolDeps {
    readonly workflow: (input: RunAdhocInput) => Promise<RunAdhocResult>;
    readonly runAuthorizer: RunAuthorizer;
    readonly runLauncher: RunLauncher;
}

export function createRunAdhocTool(deps: RunAdhocToolDeps) {
    return defineTool({
        id: "run_adhoc",
        description:
            "Start a focused one-step analysis without authoring a plan. The writable sandbox persists scripts, outputs, figures, and summary.md as run artifacts. Returns a runId immediately; inspect the run on a later turn for results.",
        inputSchema,
        execute: async (input, ctx) => {
            const { session } = ctx;
            if (session.scope.kind !== "analysis") {
                throw new Error(`run_adhoc requires an analysis-scoped session — got ${session.scope.kind}`);
            }
            if (!session.auth) {
                throw new Error("run_adhoc: session is missing its auth capability");
            }

            const runId = randomUUID();
            const authorization = await deps.runAuthorizer.authorize({
                auth: session.auth,
                scope: session.scope,
                provenance: session.provenance,
                frame: { runId },
            });

            try {
                await deps.runLauncher.launch(
                    deps.workflow,
                    { workflowId: runId },
                    {
                        runSession: authorization.runSession,
                        prompt: input.prompt,
                        ownsMandate: authorization.ownsMandate,
                    },
                );
            } catch (err) {
                await deps.runAuthorizer.revoke(authorization, "workflow-start-failed").catch(() => {});
                throw err;
            }

            await ctx.emit({
                type: "data-run-card",
                source: session.provenance,
                data: buildAdhocRunCardData(runId),
            });
            return ok({ runId });
        },
    });
}
