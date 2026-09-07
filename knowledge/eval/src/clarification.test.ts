import { describe, expect, it } from "bun:test";

import { analystNotesFor, DEFAULT_CLARIFICATION_ANSWER, runWithClarifications, type PlannerOutputLike } from "./clarification.js";

type Output = PlannerOutputLike & { planId?: string };

/** A fake planner that answers from a script, one output per invocation, and records the notes it received. */
function scripted(outputs: readonly Output[]) {
    const notes: (string | undefined)[] = [];
    let index = 0;
    const invoke = async (analystNotes: string | undefined) => {
        notes.push(analystNotes);
        const output = outputs[index];
        if (output === undefined) throw new Error(`the script has ${outputs.length} outputs; invocation ${index + 1} has none`);
        index += 1;
        return { output, usage: { inputTokens: 100 * index, outputTokens: 10 * index } };
    };
    return { invoke, notes };
}

describe("runWithClarifications", () => {
    it("answers the first clarification with the default answer once, then takes the plan", async () => {
        const planner = scripted([{ event: "clarification_needed", question: "Which column is the group?" }, { event: "plan_complete", planId: "p1" }]);
        const result = await runWithClarifications(planner.invoke);

        expect(result.output.event).toBe("plan_complete");
        expect(result.invocations).toBe(2);
        expect(result.clarifications).toEqual([
            { question: "Which column is the group?", answer: DEFAULT_CLARIFICATION_ANSWER, usage: { inputTokens: 200, outputTokens: 20 } },
        ]);
        // The first invocation carries no notes; the second carries the question and the answer.
        expect(planner.notes[0]).toBeUndefined();
        expect(planner.notes[1]).toContain("Which column is the group?");
        expect(planner.notes[1]).toContain(DEFAULT_CLARIFICATION_ANSWER);
        expect(result.usages).toHaveLength(2);
    });

    it("is terminal on the second clarification", async () => {
        const planner = scripted([
            { event: "clarification_needed", question: "First?" },
            { event: "clarification_needed", question: "Second?" },
            { event: "plan_complete", planId: "never" },
        ]);
        const result = await runWithClarifications(planner.invoke);

        expect(result.output.event).toBe("clarification_needed");
        expect(result.output.question).toBe("Second?");
        expect(result.invocations).toBe(2);
        expect(result.clarifications).toHaveLength(1);
        expect(result.clarifications[0]?.question).toBe("First?");
        expect(result.clarifications[0]?.usage).toEqual({ inputTokens: 200, outputTokens: 20 });
    });

    it("invokes once when the planner submits a plan at once", async () => {
        const planner = scripted([{ event: "plan_complete", planId: "p1" }]);
        const result = await runWithClarifications(planner.invoke);

        expect(result.output.event).toBe("plan_complete");
        expect(result.invocations).toBe(1);
        expect(result.clarifications).toEqual([]);
    });

    it("stops on an error without an answer", async () => {
        const planner = scripted([{ event: "error" }]);
        const result = await runWithClarifications(planner.invoke);

        expect(result.output.event).toBe("error");
        expect(result.invocations).toBe(1);
        expect(result.clarifications).toEqual([]);
    });

    it("keeps every answered question in the notes when the rounds permit more than one", async () => {
        const planner = scripted([
            { event: "clarification_needed", question: "First?" },
            { event: "clarification_needed", question: "Second?" },
            { event: "plan_complete", planId: "p1" },
        ]);
        const result = await runWithClarifications(planner.invoke, { rounds: 2, answer: "Continue." });

        expect(result.output.event).toBe("plan_complete");
        expect(result.invocations).toBe(3);
        expect(result.clarifications.map((entry) => entry.question)).toEqual(["First?", "Second?"]);
        expect(planner.notes[2]).toBe(analystNotesFor(result.clarifications));
        expect(planner.notes[2]).toContain("First?");
        expect(planner.notes[2]).toContain("Second?");
    });
});
