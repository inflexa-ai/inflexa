import { describe, expect, test } from "bun:test";

import { compareReports, regressions, type CaseReport, type Report } from "../lib/report.js";
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

    test("the gate names a regressed case, and a set whose small drops add up below zero", () => {
        const ids = ["a", "b", "c", "d", "e", "f"];
        const baseline = report(
            "a",
            ids.map((id) => caseReport(id, 10, 10)),
        );
        const smallDrops = compareReports(
            baseline,
            report(
                "b",
                ids.map((id) => caseReport(id, 8, 10)),
            ),
        );
        expect(smallDrops.cases.some((c) => c.regressed)).toBe(false);
        expect(regressions(smallDrops)).toEqual(["set dev regressed"]);

        const oneBroken = compareReports(
            baseline,
            report(
                "b",
                ids.map((id) => caseReport(id, id === "a" ? 0 : 10, 10)),
            ),
        );
        expect(regressions(oneBroken)).toEqual(["case a regressed"]);

        expect(regressions(compareReports(baseline, baseline))).toEqual([]);
    });

    test("the gate fails a candidate whose trials failed with an error, and a case that only one report grades", () => {
        const baseline = report("a", [caseReport("kept", 5, 5), caseReport("lost", 5, 5)]);
        const errored: CaseReport = { ...caseReport("kept", 1, 1), errors: 4 };
        const candidate = report("b", [errored, { ...caseReport("lost", 0, 1), trials: 0, passes: 0, rate: 0, errors: 5 }]);

        expect(regressions(compareReports(baseline, candidate))).toEqual([
            "case lost is not graded in both reports",
            "case kept has 4 trials that failed with an error",
            "case lost has 5 trials that failed with an error",
        ]);
    });
});
