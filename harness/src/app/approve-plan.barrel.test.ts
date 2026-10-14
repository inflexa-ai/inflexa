import { describe, expect, it } from "bun:test";

import { approvePlan, launchPlanRun } from "@inflexa-ai/harness";
import type {
    ApprovePlanInput,
    ApprovePlanRefusal,
    LaunchPlanRunDeps,
    LaunchPlanRunRefusal,
    PlanApproval,
    PlanApprovalPart,
    PlanLaunch,
} from "@inflexa-ai/harness";

import * as approval from "./approve-plan.js";
import * as execute from "../tools/execute-analysis.js";

describe("the exports of the plan approval", () => {
    it("reaches the launch and the approval from the package root, as the same functions of their modules", () => {
        expect(launchPlanRun).toBe(execute.launchPlanRun);
        expect(approvePlan).toBe(approval.approvePlan);
    });

    it("types the input, the results, the refusals, and the part from the package root", () => {
        const input: ApprovePlanInput = { analysisId: "a1", threadId: "t1", planId: "pln-0000000a", identity: { user: "u1" }, auth: {} };
        const launch: PlanLaunch = { runId: "r1", started: true };
        const result: PlanApproval = { planId: input.planId, runId: launch.runId, started: launch.started, message: null };
        const launchRefusal: LaunchPlanRunRefusal = { type: "plan_not_found", planId: input.planId };
        const refusal: ApprovePlanRefusal = { type: "superseded", supersededBy: "pln-0000000b" };
        const part: PlanApprovalPart = { type: "data-plan-approval", planId: input.planId, runId: result.runId, approvedAt: "2026-10-13T10:00:00.000Z" };
        const depsKeys: ReadonlyArray<keyof LaunchPlanRunDeps> = ["pool", "runLauncher"];

        expect([launchRefusal.type, refusal.type, part.type, depsKeys.length]).toEqual(["plan_not_found", "superseded", "data-plan-approval", 2]);
    });
});
