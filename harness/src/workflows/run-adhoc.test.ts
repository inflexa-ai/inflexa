import { describe, expect, it } from "bun:test";

import type { RunSession } from "../auth/types.js";
import { makeSession } from "../providers/__fixtures__/session.js";
import { composeAdhocBriefing } from "../prompts/briefing.js";
import { ADHOC_AGENT_ID, ADHOC_STEP_ID, DEFAULT_ADHOC_RESOURCES, buildAdhocStepInput } from "./run-adhoc.js";

function runSession(runId = "run-adhoc-1"): RunSession {
    return { ...makeSession(), runFrame: { runId } } as RunSession;
}

describe("runAdhoc composition", () => {
    it("builds one adhoc sandbox-step input with the default resources", () => {
        const input = buildAdhocStepInput({
            runSession: runSession(),
            prompt: "persisted briefing",
        });

        expect(input).toMatchObject({
            analysisId: "analysis-001",
            runId: "run-adhoc-1",
            stepId: ADHOC_STEP_ID,
            agentId: ADHOC_AGENT_ID,
            dependsOn: [],
            level: 0,
            prompt: "persisted briefing",
            parentWorkflowId: "run-adhoc-1",
            resources: DEFAULT_ADHOC_RESOURCES,
        });
        expect(input.runSession.runFrame).toEqual({ runId: "run-adhoc-1", stepId: ADHOC_STEP_ID });
    });

    it("uses policy.adhoc when supplied", () => {
        const input = buildAdhocStepInput({
            runSession: runSession(),
            prompt: "briefing",
            resourcePolicy: {
                perStep: { maxCpu: 8, maxMemoryGb: 16, maxGpuCount: 0 },
                budget: { cpu: 8, memoryGb: 16 },
                adhoc: { cpu: 2, memoryGb: 4 },
            },
        });
        expect(input.resources).toEqual({ cpu: 2, memoryGb: 4 });
    });

    it("composes free text with writable workspace and orientation, without upstream", () => {
        const briefing = composeAdhocBriefing({
            prompt: "compute summary stats",
            workspace: {
                analysisRoot: "/analysis-001",
                workingDir: "/analysis-001/runs/run-1/adhoc",
            },
            profile: null,
        });

        expect(briefing).toContain("## Task\ncompute summary stats");
        expect(briefing).toContain("Working directory (writable, your cwd): `/analysis-001/runs/run-1/adhoc`");
        expect(briefing).toContain("Analysis root (read-only): `/analysis-001`");
        expect(briefing).not.toContain("Upstream results");
    });
});
