import { describe, expect, test } from "bun:test";

import { all, atMost, decides, firstCallOneOf, inputMatches, never, type Trial, type TrialCall } from "../lib/case.js";

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

describe("firstCallOneOf", () => {
    test("reads every call of the first step that calls a tool", () => {
        const grader = firstCallOneOf(["pubmed", "search_semantic_scholar"]);
        expect(grader(trial({ step: 0, tool: "search_gene", input: {} }, { step: 0, tool: "pubmed", input: {} })).pass).toBe(true);
        expect(grader(trial({ step: 0, tool: "search_gene", input: {} }, { step: 1, tool: "pubmed", input: {} })).pass).toBe(false);
        expect(grader(trial()).detail).toBe("answered with no tool call");
    });
});

describe("never, atMost, all", () => {
    test("never fails on a call of a named tool", () => {
        expect(never(["execute_analysis"])(trial({ step: 0, tool: "execute_analysis", input: {} }))).toEqual({
            pass: false,
            detail: "called execute_analysis",
        });
    });

    test("atMost counts the calls of one tool", () => {
        const twice = trial({ step: 0, tool: "inspect_run", input: {} }, { step: 1, tool: "inspect_run", input: {} });
        expect(atMost("inspect_run", 1)(twice)).toEqual({ pass: false, detail: "2 calls of inspect_run" });
        expect(atMost("inspect_run", 2)(twice).pass).toBe(true);
    });

    test("all gives the detail of the first failure", () => {
        const grade = all(atMost("inspect_run", 5), never(["inspect_run"]))(trial({ step: 0, tool: "inspect_run", input: {} }));
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
