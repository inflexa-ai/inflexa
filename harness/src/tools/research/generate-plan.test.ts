import { describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { makeMessage, scriptedProvider, textBlock, toolUseBlock } from "../../loop/__fixtures__/scripted-provider.js";
import { makeSession } from "../../providers/__fixtures__/session.js";
import type { ToolContext } from "../define-tool.js";
import { createGeneratePlanTool } from "./generate-plan.js";

/** A ToolContext with a parent conversation Session. */
function toolContext(): ToolContext {
    return {
        session: makeSession({
            agentId: "conversation-agent",
            callPath: ["conversation-agent"],
        }),
        signal: new AbortController().signal,
        emit: () => {},
        runStep: (_name, fn) => fn(),
    };
}

interface PlanResult {
    event: string;
    error?: string;
    question?: string;
}

const INPUT = {
    dataContext: "Bulk RNA-seq, 12 samples, two conditions.",
    researchQuestion: "Which genes are differentially expressed?",
};

// The pool is never touched on the non-persisting terminal paths.
const NO_POOL = {} as Pool;

describe("generatePlan loop-driving tool", () => {
    it("surfaces report_blocker as an error outcome", async () => {
        const provider = scriptedProvider([
            makeMessage(
                [
                    toolUseBlock("t1", "report_blocker", {
                        reason: "Data is incompatible with every available agent.",
                    }),
                ],
                "tool_use",
            ),
            makeMessage([textBlock("Reported.")], "end_turn"),
        ]);
        const tool = createGeneratePlanTool({
            provider,
            pool: NO_POOL,
            model: "claude-test",
        });

        const result = (await tool.execute(INPUT, toolContext()))._unsafeUnwrap() as PlanResult;

        expect(result.event).toBe("error");
        expect(result.error).toBe("Data is incompatible with every available agent.");

        // The planner ran on a derived child Session with its 4 terminal tools.
        expect(provider.sessions[0]!.provenance.agentId).toBe("planner");
        expect(provider.sessions[0]!.provenance.callPath).toEqual(["conversation-agent", "planner"]);
        expect(Object.keys(provider.calls[0]!.tools)).toEqual(["validate_plan", "submit_plan", "request_clarification", "report_blocker"]);
    });

    it("surfaces request_clarification as a clarification outcome", async () => {
        const provider = scriptedProvider([
            makeMessage(
                [
                    toolUseBlock("t1", "request_clarification", {
                        question: "Which two conditions should be contrasted?",
                    }),
                ],
                "tool_use",
            ),
            makeMessage([textBlock("Asked.")], "end_turn"),
        ]);
        const tool = createGeneratePlanTool({
            provider,
            pool: NO_POOL,
            model: "claude-test",
        });

        const result = (await tool.execute(INPUT, toolContext()))._unsafeUnwrap() as PlanResult;

        expect(result.event).toBe("clarification_needed");
        expect(result.question).toBe("Which two conditions should be contrasted?");
    });

    it("errors when the planner ends without a terminal tool call", async () => {
        // Prose every turn — including the terminal-salvage continuation — so no
        // terminal outcome is ever recorded.
        const provider = scriptedProvider(() => makeMessage([textBlock("Here is a plan, described in prose.")], "end_turn"));
        const tool = createGeneratePlanTool({
            provider,
            pool: NO_POOL,
            model: "claude-test",
        });

        const result = (await tool.execute(INPUT, toolContext()))._unsafeUnwrap() as PlanResult;

        expect(result.event).toBe("error");
        expect(result.error).toContain("without a terminal outcome");
    });
});
