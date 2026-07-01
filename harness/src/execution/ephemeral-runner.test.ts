import { describe, expect, it } from "bun:test";

import { runEphemeralBody, type EphemeralDeps, type EphemeralWorkflowInput } from "./ephemeral-runner.js";

describe("runEphemeralBody", () => {
    it("fails fast on a non-analysis scope before any sandbox work", async () => {
        // Only `runSession.scope` is read before the guard throws, so deps are
        // never touched — the cast is honest for this path.
        const input = {
            prompt: "compute something",
            runSession: {
                scope: {
                    kind: "target-assessment",
                    targetAssessmentId: "ta-001",
                    billingContextId: "bc-001",
                },
            },
        } as unknown as EphemeralWorkflowInput;

        await expect(runEphemeralBody(input, {} as EphemeralDeps)).rejects.toThrow(/analysis-scoped/);
    });
});
