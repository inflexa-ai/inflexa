import { afterEach, describe, expect, it, setSystemTime } from "bun:test";

import type { CortexRunRow } from "../../state/schema.js";
import { renderRunActivity, renderRunActivityUnavailable, RUN_ACTIVITY_DETAIL_LIMIT } from "../run-activity.js";

function run(runId: string, status: CortexRunRow["status"], startedAt: string, planId: string | null = null): CortexRunRow {
    return {
        runId,
        analysisId: "analysis-1",
        threadId: null,
        workflowName: "executeAnalysis",
        status,
        startedAt,
        completedAt: null,
        error: null,
        synthesisStatus: null,
        synthesisReason: null,
        parts: null,
        mandateId: null,
        planId,
    };
}

describe("renderRunActivity", () => {
    afterEach(() => {
        setSystemTime();
    });

    it("lists the running rows with full identifiers and absolute start times, and no row that ended", () => {
        const rendered = renderRunActivity({
            runs: [
                run("run-running-full-id", "running", "2026-07-30T09:58:00.000Z", "pln-1234abcd"),
                run("run-failed-full-id", "failed", "2026-07-29T10:00:00.000Z"),
            ],
            total: 2,
        });

        expect(rendered).toContain("[Run Activity]");
        expect(rendered).toContain("Running:");
        expect(rendered).not.toContain("run-failed-full-id");
        expect(rendered).toContain("runId: run-running-full-id");
        expect(rendered).toContain("planId: pln-1234abcd");
        expect(rendered).toContain("startedAt: 2026-07-30T09:58:00.000Z");
        expect(rendered).not.toContain("ago");
        expect(rendered).not.toContain("started:");
    });

    it("gives byte-identical text for one activity at two times", () => {
        const activity = { runs: [run("run-1", "running", "2026-07-30T09:58:00.000Z")], total: 1 };

        setSystemTime(new Date("2026-07-30T10:00:00.000Z"));
        const first = renderRunActivity(activity);
        setSystemTime(new Date("2026-07-30T11:00:00.000Z"));
        const second = renderRunActivity(activity);

        expect(second).toBe(first);
    });

    it("renders explicit empty and unavailable states", () => {
        expect(renderRunActivity({ runs: [], total: 0 })).toContain("No runs are currently running.");
        expect(renderRunActivityUnavailable()).toContain("temporarily unavailable");
        expect(renderRunActivityUnavailable()).toContain("Do not infer");
    });

    it("reports the true total and omitted count for a bounded projection", () => {
        const rows = Array.from({ length: RUN_ACTIVITY_DETAIL_LIMIT }, (_, index) => run(`run-${index}`, "running", "2026-07-30T09:00:00.000Z"));
        const rendered = renderRunActivity({ runs: rows, total: 23 });

        expect(rendered).toContain("Showing 20 of 23 non-terminal runs; 3 omitted.");
    });
});
