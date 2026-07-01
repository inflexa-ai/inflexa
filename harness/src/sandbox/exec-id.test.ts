import { describe, expect, test } from "bun:test";

import { workflowIdFromExec } from "./exec-id.js";

describe("workflowIdFromExec", () => {
    test("recovers child workflowId from a production-shape execId (3 colons)", () => {
        // childWorkflowId = `${analysisId}:${runId}-${stepIdx}`, execId appends
        // `:${stepId}:${fnId}`. The workflowId portion contains one embedded colon.
        expect(workflowIdFromExec("an-1:run-1-0:s-a:fn-0")).toBe("an-1:run-1-0");
    });

    test("recovers parent workflowId from a 2-colon execId", () => {
        expect(workflowIdFromExec("wf-1:s-a:fn-0")).toBe("wf-1");
    });

    test("handles UUID-shaped analysisId + runId", () => {
        const execId = "0190f000-0000-7000-8000-000000000001:0190f000-0000-7000-8000-00000000aaaa-0:qc:fn-0";
        expect(workflowIdFromExec(execId)).toBe("0190f000-0000-7000-8000-000000000001:0190f000-0000-7000-8000-00000000aaaa-0");
    });

    test("returns null for missing colons", () => {
        expect(workflowIdFromExec("no-colons")).toBeNull();
    });

    test("returns null for a single-colon execId (only 2 segments)", () => {
        expect(workflowIdFromExec("a:b")).toBeNull();
    });

    test("returns null when the workflowId would be empty", () => {
        expect(workflowIdFromExec(":s:f")).toBeNull();
    });
});
