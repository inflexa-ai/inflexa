import { describe, expect, it } from "bun:test";

import type { RunSession } from "../auth/types.js";
import type { RunAuthorization, RunAuthorizer } from "../execution/run-authorizer.js";
import type { RunLauncher } from "../execution/run-launcher.js";
import { makeSession } from "../providers/__fixtures__/session.js";
import type { RunAdhocInput, RunAdhocResult } from "../workflows/run-adhoc.js";
import type { ToolContext } from "./define-tool.js";
import { createRunAdhocTool } from "./run-adhoc.js";

const workflow = async (_input: RunAdhocInput): Promise<RunAdhocResult> => ({ runId: "unused", status: "completed" });

function ctxFor(session: ToolContext["session"], emitted: unknown[] = []): ToolContext {
    return {
        session,
        signal: new AbortController().signal,
        emit: (event) => {
            emitted.push(event);
        },
        runStep: (_name, fn) => fn(),
    };
}

describe("createRunAdhocTool", () => {
    it("authorizes, launches without awaiting, emits a run card, and returns the run id", async () => {
        const launches: Array<{ workflowId: string; input: RunAdhocInput }> = [];
        let authorizeFrame: { runId: string } | undefined;
        const requestSession = makeSession();
        const authorizer: RunAuthorizer = {
            authorize: async (input): Promise<RunAuthorization> => {
                authorizeFrame = input.frame;
                return {
                    runSession: { ...requestSession, runFrame: input.frame } as RunSession,
                    ownsMandate: true,
                };
            },
            revoke: async () => {},
        };
        const launcher: RunLauncher = {
            launch: async (_workflow, opts, input) => {
                launches.push({ workflowId: opts.workflowId, input: input as RunAdhocInput });
            },
        };
        const emitted: unknown[] = [];
        const tool = createRunAdhocTool({ workflow, runAuthorizer: authorizer, runLauncher: launcher });

        const output = (await tool.execute({ prompt: "compute summary stats" }, ctxFor(requestSession, emitted)))._unsafeUnwrap();

        expect(tool.id).toBe("run_adhoc");
        expect(output.runId).toBe(authorizeFrame?.runId);
        expect(launches).toHaveLength(1);
        expect(launches[0]!.workflowId).toBe(output.runId);
        expect(launches[0]!.input.prompt).toBe("compute summary stats");
        expect(launches[0]!.input.ownsMandate).toBe(true);
        expect(emitted).toEqual([
            {
                type: "data-run-card",
                source: requestSession.provenance,
                data: {
                    id: expect.stringMatching(/^pres-/),
                    runId: output.runId,
                    planId: null,
                    title: "Adhoc run",
                    stepCount: 1,
                },
            },
        ]);
    });

    it("rejects a non-analysis scope before authorization", async () => {
        const tool = createRunAdhocTool({
            workflow,
            runAuthorizer: {
                authorize: async () => {
                    throw new Error("authorize should not be called");
                },
                revoke: async () => {},
            },
            runLauncher: {
                launch: async () => {
                    throw new Error("launch should not be called");
                },
            },
        });

        await expect(
            tool.execute(
                { prompt: "inspect target" },
                ctxFor(
                    makeSession({
                        scope: {
                            kind: "target-assessment",
                            targetAssessmentId: "ta-1",
                            billingContextId: "bc-1",
                        },
                    }),
                ),
            ),
        ).rejects.toThrow(/analysis-scoped/);
    });

    it("requires a non-empty prompt", () => {
        const tool = createRunAdhocTool({
            workflow,
            runAuthorizer: {} as RunAuthorizer,
            runLauncher: {} as RunLauncher,
        });
        expect(tool.inputSchema.safeParse({ prompt: "" }).success).toBe(false);
    });
});
