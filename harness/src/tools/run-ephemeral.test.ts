import { describe, expect, it } from "bun:test";

import { makeSession } from "../providers/__fixtures__/session.js";
import type { RunSession } from "../auth/types.js";
import type { RunAuthorization, RunAuthorizer } from "../execution/run-authorizer.js";
import type { LaunchOutcome, RunLauncher } from "../execution/run-launcher.js";
import type { EphemeralResult, EphemeralWorkflowInput } from "../execution/ephemeral-runner.js";
import type { ToolContext } from "./define-tool.js";
import { createRunEphemeralTool } from "./run-ephemeral.js";

/** Workflow stub — the guard tests must throw before this is ever reached. */
const unreachableWorkflow = (_input: EphemeralWorkflowInput): Promise<EphemeralResult> => {
    throw new Error("workflow should not start in a guard-rejected call");
};

/** Authorizer stub — the guard tests must throw before authorize is reached. */
const unreachableRunAuthorizer: RunAuthorizer = {
    authorize: () => {
        throw new Error("authorize should not be called in a guard-rejected call");
    },
    revoke: async () => {},
};

/** Launcher stub — the guard tests must throw before launch is reached. */
const unreachableRunLauncher: RunLauncher = {
    launch: async () => {
        throw new Error("launch should not be called in a guard-rejected call");
    },
    launchAndAwait: async () => {
        throw new Error("launchAndAwait should not be called in a guard-rejected call");
    },
};

/** Authorizer that succeeds and records revoke reasons. */
function recordingAuthorizer(): {
    authorizer: RunAuthorizer;
    revokes: string[];
} {
    const revokes: string[] = [];
    const authorizer: RunAuthorizer = {
        authorize: async (): Promise<RunAuthorization> => ({
            runSession: {} as RunSession,
            ownsMandate: true,
        }),
        revoke: async (_authorization, reason) => {
            revokes.push(reason);
        },
    };
    return { authorizer, revokes };
}

/** Launcher returning a fixed outcome; never reaches the durability engine. */
function launcherReturning(outcome: LaunchOutcome<EphemeralResult>): RunLauncher {
    return {
        launch: async () => {
            throw new Error("launch not used by run_ephemeral");
        },
        launchAndAwait: async () => outcome as LaunchOutcome<never>,
    };
}

function makeTool() {
    return createRunEphemeralTool({
        workflow: unreachableWorkflow,
        runAuthorizer: unreachableRunAuthorizer,
        runLauncher: unreachableRunLauncher,
    });
}

const ctxFor = (session: ToolContext["session"]): ToolContext => ({
    session,
    signal: new AbortController().signal,
    emit: () => {},
    runStep: (_name, fn) => fn(),
});

describe("createRunEphemeralTool", () => {
    it("exposes the canonical id, description, and input schema", () => {
        const tool = makeTool();

        expect(tool.id).toBe("run_ephemeral");
        expect(typeof tool.description).toBe("string");
        expect(tool.description.length).toBeGreaterThan(0);

        expect(tool.inputSchema.safeParse({ prompt: "" }).success).toBe(false);
        expect(tool.inputSchema.safeParse({ prompt: "Inspect /data" }).success).toBe(true);
    });

    it("rejects a non-analysis scope before starting the workflow", async () => {
        const tool = makeTool();
        const session = makeSession({
            scope: {
                kind: "target-assessment",
                targetAssessmentId: "ta-001",
                billingContextId: "bc-001",
            },
        });

        await expect(tool.execute({ prompt: "TA-scoped run." }, ctxFor(session))).rejects.toThrow(/analysis-scoped/);
    });

    it("returns the awaited ephemeral result and revokes the authorization", async () => {
        const { authorizer, revokes } = recordingAuthorizer();
        const tool = createRunEphemeralTool({
            workflow: unreachableWorkflow,
            runAuthorizer: authorizer,
            runLauncher: launcherReturning({
                status: "completed",
                result: { text: "42 rows", durationMs: 1200, stepsUsed: 3 },
            }),
        });

        const result = (await tool.execute({ prompt: "count rows" }, ctxFor(makeSession())))._unsafeUnwrap();

        expect(result).toEqual({ text: "42 rows", durationMs: 1200 });
        expect(revokes).toContain("ephemeral-completed");
    });

    it("maps a cancelled launch to the friendly text and still revokes", async () => {
        const { authorizer, revokes } = recordingAuthorizer();
        const tool = createRunEphemeralTool({
            workflow: unreachableWorkflow,
            runAuthorizer: authorizer,
            runLauncher: launcherReturning({ status: "cancelled" }),
        });

        const result = (await tool.execute({ prompt: "inspect /data" }, ctxFor(makeSession())))._unsafeUnwrap();

        expect(result).toEqual({
            text: "(ephemeral exploration cancelled)",
            durationMs: 0,
        });
        expect(revokes).toContain("ephemeral-completed");
    });
});
