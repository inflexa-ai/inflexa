import { describe, expect, test } from "bun:test";

import { all, atMostWith, callsAny, decides, inputMatches, never, type Trial, type TrialCall } from "../lib/case.js";

function trial(...calls: readonly Omit<TrialCall, "refused">[]): Trial {
    return { calls: calls.map((call) => ({ ...call, refused: false })), asks: [], text: "", finishReason: "stop" };
}

describe("decides", () => {
    const grader = decides("execute_analysis", ["generate_plan"], { mode: "adhoc" });

    test("passes when the first call of the set is the tool with the input", () => {
        const grade = grader(
            trial({ step: 0, tool: "inspect_data_profile", input: {} }, { step: 1, tool: "execute_analysis", input: { mode: "adhoc", request: "x" } }),
        );
        expect(grade).toEqual({ pass: true, detail: "decided execute_analysis" });
    });

    test("fails when a different tool of the set comes first", () => {
        const grade = grader(trial({ step: 0, tool: "generate_plan", input: {} }, { step: 1, tool: "execute_analysis", input: { mode: "adhoc" } }));
        expect(grade).toEqual({ pass: false, detail: "decided generate_plan" });
    });

    test("fails on the wrong input", () => {
        const grade = grader(trial({ step: 0, tool: "execute_analysis", input: { mode: "plan", planId: "pln-1a2b3c4d" } }));
        expect(grade.pass).toBe(false);
        expect(grade.detail).toContain('"mode":"plan"');
    });

    test("fails when no tool of the set is called", () => {
        expect(grader(trial()).detail).toBe("no call of execute_analysis, generate_plan (calls: no tool call)");
    });
});

describe("callsAny", () => {
    test("passes on a call of the set at any step, after a lookup", () => {
        const grader = callsAny(["pubmed", "search_semantic_scholar"]);
        expect(grader(trial({ step: 0, tool: "search_gene", input: {} }, { step: 1, tool: "pubmed", input: {} }))).toEqual({
            pass: true,
            detail: "called pubmed",
        });
        expect(grader(trial({ step: 0, tool: "search_gene", input: {} })).detail).toBe("no call of pubmed, search_semantic_scholar (calls: search_gene)");
        expect(grader(trial()).pass).toBe(false);
    });
});

describe("never, atMostWith, all", () => {
    test("never fails on a call of a named tool", () => {
        expect(never(["execute_analysis"])(trial({ step: 0, tool: "execute_analysis", input: {} }))).toEqual({
            pass: false,
            detail: "called execute_analysis",
        });
    });

    test("atMostWith counts only the calls whose input sets the key", () => {
        const waitThenLook = trial(
            { step: 0, tool: "inspect_run", input: { runId: "r", waitForTerminalSeconds: 30 } },
            { step: 1, tool: "inspect_run", input: { runId: "r", includeDiagnostics: true } },
        );
        expect(atMostWith("inspect_run", "waitForTerminalSeconds", 1)(waitThenLook)).toEqual({
            pass: true,
            detail: "1 calls of inspect_run with waitForTerminalSeconds",
        });
        const twoWaits = trial(
            { step: 0, tool: "inspect_run", input: { runId: "r", waitForTerminalSeconds: 30 } },
            { step: 1, tool: "inspect_run", input: { runId: "r", waitForTerminalSeconds: 30 } },
        );
        expect(atMostWith("inspect_run", "waitForTerminalSeconds", 1)(twoWaits).pass).toBe(false);
    });

    test("all gives the detail of the first failure", () => {
        const grade = all(atMostWith("inspect_run", "runId", 5), never(["inspect_run"]))(trial({ step: 0, tool: "inspect_run", input: {} }));
        expect(grade).toEqual({ pass: false, detail: "called inspect_run" });
    });
});

describe("inputMatches", () => {
    test("compares the named keys deeply and ignores the others", () => {
        expect(inputMatches({ mode: "adhoc", request: "x", extra: [1] }, { mode: "adhoc" })).toBe(true);
        expect(inputMatches({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })).toBe(true);
        expect(inputMatches("adhoc", { mode: "adhoc" })).toBe(false);
    });
});
