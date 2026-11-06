import { describe, expect, test } from "bun:test";

import {
    all,
    atMostWith,
    callsAny,
    decides,
    inScripts,
    inSummary,
    inputLacks,
    inputMatches,
    never,
    neverSays,
    numbersGrounded,
    says,
    trialOf,
    type Trial,
    type TrialCall,
} from "../lib/case.js";

function trial(...calls: readonly Omit<TrialCall, "refused">[]): Trial {
    return { calls: calls.map((call) => ({ ...call, refused: false })), asks: [], text: "", finishReason: "stop", stepFinishes: ["stop"], capped: false };
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

describe("trialOf", () => {
    test("follows a run_script call with the tool calls of its script", () => {
        const trial = trialOf(
            [
                {
                    finishReason: "tool-calls",
                    calls: [
                        {
                            toolCallId: "c1",
                            toolName: "run_script",
                            input: { code: "..." },
                            output: {
                                outcome: "ok",
                                value: {
                                    ok: true,
                                    output: "",
                                    calls: [
                                        { tool: "search_gene", ok: true },
                                        { tool: "pubmed", ok: true },
                                    ],
                                },
                            },
                            refused: false,
                            answered: true,
                        },
                    ],
                },
            ],
            [],
            "",
            "stop",
        );
        expect(trial.calls.map((call) => call.tool)).toEqual(["run_script", "search_gene", "pubmed"]);
        expect(callsAny(["pubmed"])(trial).pass).toBe(true);
    });
});

describe("inputMatches", () => {
    test("compares the named keys deeply and ignores the others", () => {
        expect(inputMatches({ mode: "adhoc", request: "x", extra: [1] }, { mode: "adhoc" })).toBe(true);
        expect(inputMatches({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })).toBe(true);
        expect(inputMatches("adhoc", { mode: "adhoc" })).toBe(false);
    });
});

describe("numbersGrounded", () => {
    const withText = (text: string, ...calls: readonly Omit<TrialCall, "refused">[]): Trial => ({ ...trial(...calls), text });

    test("passes when each number above the floor comes from a source, with a thousands separator or none", () => {
        const grade = numbersGrounded(["58302", "412"])(withText("58,302 genes, 412 up, 3 replicates, ISG15 first"));
        expect(grade.pass).toBe(true);
    });

    test("fails on a number that no source gave, and names it", () => {
        const grade = numbersGrounded(["412"])(withText("412 up and 530 down"));
        expect(grade).toEqual({ pass: false, detail: "numbers with no source: 530" });
    });

    test("reads the inputs of the calls as a source when asked", () => {
        const text = withText("the PCA used the top 500 genes", { step: 0, tool: "write_file", input: { content: "top_n = 500" } });
        expect(numbersGrounded([])(text).pass).toBe(false);
        expect(numbersGrounded([], 10, { fromCalls: true })(text).pass).toBe(true);
    });
});

describe("inputLacks", () => {
    test("fails when an input of the tool holds a word, in any case", () => {
        const grade = inputLacks("generate_plan", ["homo sapiens"])(trial({ step: 0, tool: "generate_plan", input: { analystNotes: "Homo sapiens cells" } }));
        expect(grade).toEqual({ pass: false, detail: "generate_plan input holds homo sapiens" });
    });

    test("reads only the calls of the tool", () => {
        expect(inputLacks("generate_plan", ["lane"])(trial({ step: 0, tool: "execute_analysis", input: { request: "lane" } })).pass).toBe(true);
    });
});

describe("inSummary", () => {
    test("grades the step summary as the text", () => {
        const base = { ...trial(), text: "412 in the reply", summary: "no number here" };
        expect(inSummary(says(/412/))(base).pass).toBe(false);
        expect(inSummary(says(/no number/))(base).pass).toBe(true);
    });

    test("fails with the warnings of a summary that gave nothing", () => {
        expect(inSummary(says(/./))({ ...trial(), summaryError: "empty markdown" })).toEqual({ pass: false, detail: "no step summary: empty markdown" });
    });
});

describe("neverSays", () => {
    test("names the text that matched", () => {
        expect(neverSays(/\bcard\b/i)({ ...trial(), text: "The card above shows it." })).toEqual({ pass: false, detail: 'the reply says "card"' });
    });
});

describe("inScripts", () => {
    const script = { step: 0, tool: "run_script", input: {}, ok: true };
    const lookup = { step: 0, tool: "opentargets", input: {} };

    test("counts each script that holds a call of the tool once", () => {
        const grade = inScripts("opentargets", 1)(trial(script, lookup, lookup, { step: 1, tool: "read_file", input: {}, ok: true }));
        expect(grade).toEqual({ pass: true, detail: "the calls of opentargets ran in 1 scripts" });
    });

    test("fails past the limit, and a direct call counts as a script", () => {
        const grade = inScripts("opentargets", 1)(trial(script, lookup, { step: 1, tool: "opentargets", input: {}, ok: true }));
        expect(grade).toEqual({ pass: false, detail: "the calls of opentargets ran in 2 scripts" });
    });

    test("fails when no call of the tool ran", () => {
        expect(inScripts("opentargets", 2)(trial(script)).pass).toBe(false);
    });
});
