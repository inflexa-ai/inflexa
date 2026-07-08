import { describe, expect, test } from "bun:test";
import type { StepExecutionRow } from "@inflexa-ai/harness";

import { stepStateOf } from "./runs_dialog.tsx";
import type { RunStepView } from "../run_block.tsx";

// A total map keyed by every harness step status: the `Record` type is a compile-time exhaustiveness
// guard — adding a status to the harness enum breaks this table until it is classified here, matching
// the `never` default inside `stepStateOf`.
const EXPECTED: Record<StepExecutionRow["status"], RunStepView["state"]> = {
    pending: "queued",
    skipped: "queued",
    running: "running",
    completed: "done",
    failed: "failed",
    canceled: "failed",
    blocked: "failed",
};

describe("stepStateOf — harness step status → run-step state", () => {
    for (const status of Object.keys(EXPECTED) as Array<StepExecutionRow["status"]>) {
        test(`${status} → ${EXPECTED[status]}`, () => {
            expect(stepStateOf(status)).toBe(EXPECTED[status]);
        });
    }

    test("maps into the four run-step buckets only", () => {
        const buckets = new Set(Object.values(EXPECTED));
        expect([...buckets].sort()).toEqual(["done", "failed", "queued", "running"]);
    });
});
