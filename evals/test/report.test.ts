import { describe, expect, test } from "bun:test";

import { compareReports, type CaseReport, type Report } from "../lib/report.js";
import { wilson } from "../lib/stats.js";

function caseReport(id: string, passes: number, trials: number, set: CaseReport["set"] = "dev"): CaseReport {
    return { id, set, source: "test", trials, passes, errors: 0, rate: passes / trials, interval: wilson(passes, trials), results: [] };
}

function report(digest: string, cases: readonly CaseReport[]): Report {
    return {
        version: 1,
        startedAt: "2026-10-27T00:00:00.000Z",
        promptDigest: digest,
        provider: { kind: "anthropic", model: "m" },
        trialsPerCase: 10,
        k: 3,
        cases: [...cases],
    };
}

describe("compareReports", () => {
    test("pairs the cases by id, and marks only a difference whose interval leaves zero", () => {
        const baseline = report("a", [caseReport("kept", 9, 10), caseReport("broken", 10, 10), caseReport("gone", 5, 10)]);
        const candidate = report("b", [caseReport("kept", 8, 10), caseReport("broken", 0, 10), caseReport("new", 5, 10)]);
        const comparison = compareReports(baseline, candidate);
        expect(comparison.cases.map((c) => [c.id, c.regressed])).toEqual([
            ["kept", false],
            ["broken", true],
        ]);
        expect([...comparison.unpaired].sort()).toEqual(["gone", "new"]);
        expect(comparison.sets.dev?.estimate).toBeCloseTo(-0.55, 10);
    });
});
