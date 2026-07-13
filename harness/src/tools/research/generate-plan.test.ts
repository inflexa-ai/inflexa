import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../../__tests__/setup/postgres.js";
import { makeMessage, scriptedProvider, textBlock, toolUseBlock, type ScriptedProvider } from "../../loop/__fixtures__/scripted-provider.js";
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

const INPUT = { researchQuestion: "Which genes are differentially expressed?" };

const ANALYSIS = "analysis-001";

/** The analysis id the tool derives from the session scope (makeSession default). */
async function seedAnalysis(pool: Pool, analysisId = ANALYSIS): Promise<void> {
    const now = new Date().toISOString();
    await pool.query({
        text: `INSERT INTO cortex_analysis_state (analysis_id, status, data_profile_status, data_profile_result, created_at, updated_at)
               VALUES ($1, 'active', 'completed', $2::jsonb, $3, $3)`,
        values: [
            analysisId,
            JSON.stringify({
                summary: "Bulk RNA-seq: a count matrix and a sample sheet.",
                files: [{ path: "data/inputs/f1/counts.csv", description: "Count matrix." }],
                inputFileIds: ["f1"],
                profiledAt: "2026-06-09T10:00:00.000Z",
            }),
            now,
        ],
    });
}

async function seedTerminalRun(pool: Pool, runId: string, analysisId = ANALYSIS): Promise<void> {
    await pool.query({
        text: `INSERT INTO cortex_runs (run_id, analysis_id, workflow_name, status, started_at, completed_at)
               VALUES ($1, $2, 'executeAnalysis', 'completed', '2026-07-05T10:00:00.000Z', '2026-07-05T11:00:00.000Z')`,
        values: [runId, analysisId],
    });
}

/** Flatten a message's content to a searchable string. */
function contentText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((b) => (typeof b === "object" && b && "text" in b ? String((b as { text: unknown }).text) : "")).join("\n");
    return "";
}

/**
 * A scripted provider that snapshots the messages of the first model call.
 * The loop mutates its working message array in place across iterations, so a
 * live reference (`provider.calls[0].messages`) would grow — capture a copy.
 */
function capturingProvider(): { provider: ScriptedProvider; firstCall: () => readonly { role: string; content: unknown }[] } {
    let captured: readonly { role: string; content: unknown }[] = [];
    const provider = scriptedProvider((i, req) => {
        if (i === 0) captured = [...(req.messages as readonly { role: string; content: unknown }[])];
        // First turn ends the planner via report_blocker; the follow-up stops the loop.
        return i === 0 ? makeMessage([toolUseBlock("t1", "report_blocker", { reason: "n/a" })], "tool_use") : makeMessage([textBlock("done")], "end_turn");
    });
    return { provider, firstCall: () => captured };
}

let pool: Pool;
let drop: () => Promise<void>;

beforeEach(async () => {
    ({ pool, drop } = await withSchema("generate-plan"));
});

afterEach(async () => {
    await drop();
});

describe("generatePlan loop-driving tool", () => {
    it("surfaces report_blocker as an error outcome", async () => {
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("t1", "report_blocker", { reason: "Data is incompatible with every available agent." })], "tool_use"),
            makeMessage([textBlock("Reported.")], "end_turn"),
        ]);
        const tool = createGeneratePlanTool({ provider, pool, model: "claude-test" });

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
            makeMessage([toolUseBlock("t1", "request_clarification", { question: "Which two conditions should be contrasted?" })], "tool_use"),
            makeMessage([textBlock("Asked.")], "end_turn"),
        ]);
        const tool = createGeneratePlanTool({ provider, pool, model: "claude-test" });

        const result = (await tool.execute(INPUT, toolContext()))._unsafeUnwrap() as PlanResult;

        expect(result.event).toBe("clarification_needed");
        expect(result.question).toBe("Which two conditions should be contrasted?");
    });

    it("errors when the planner ends without a terminal tool call", async () => {
        const provider = scriptedProvider(() => makeMessage([textBlock("Here is a plan, described in prose.")], "end_turn"));
        const tool = createGeneratePlanTool({ provider, pool, model: "claude-test" });

        const result = (await tool.execute(INPUT, toolContext()))._unsafeUnwrap() as PlanResult;

        expect(result.event).toBe("error");
        expect(result.error).toContain("without a terminal outcome");
    });
});

describe("generatePlan initial-message composition", () => {
    it("with no profile and no runs, the only initial message is the ask", async () => {
        const { provider, firstCall } = capturingProvider();
        const tool = createGeneratePlanTool({ provider, pool, model: "claude-test" });

        await tool.execute({ researchQuestion: "Q?", userConstraints: "keep it small" }, toolContext());

        const messages = firstCall();
        expect(messages).toHaveLength(1);
        expect(messages[0]!.role).toBe("user");
        const text = contentText(messages[0]!.content);
        expect(text).toContain("## Research question");
        expect(text).toContain("Q?");
        expect(text).toContain("## User constraints");
        expect(text).toContain("keep it small");
        expect(text).not.toContain("<briefing");
    });

    it("composes briefings before the ask, in order data-profile then prior-runs", async () => {
        await seedAnalysis(pool);
        await seedTerminalRun(pool, "run-1");

        const { provider, firstCall } = capturingProvider();
        const tool = createGeneratePlanTool({ provider, pool, model: "claude-test" });

        await tool.execute(INPUT, toolContext());

        const messages = firstCall();
        expect(messages).toHaveLength(3);
        expect(contentText(messages[0]!.content)).toContain('<briefing name="data-profile">');
        expect(contentText(messages[1]!.content)).toContain('<briefing name="prior-runs">');
        expect(contentText(messages[1]!.content)).toContain("**run-1**");
        // The ask is last and carries no briefing wrapper.
        expect(messages[2]!.role).toBe("user");
        expect(contentText(messages[2]!.content)).toContain("## Research question");
        expect(contentText(messages[2]!.content)).not.toContain("<briefing");
    });

    it("fails fast on an invalid parentPlanId without running the planner", async () => {
        const provider = scriptedProvider([]);
        const tool = createGeneratePlanTool({ provider, pool, model: "claude-test" });

        const result = (await tool.execute({ ...INPUT, parentPlanId: "pln-deadbeef" }, toolContext()))._unsafeUnwrap() as PlanResult;

        expect(result.event).toBe("error");
        expect(result.error).toBe("parentPlanId is not a valid plan for this analysis");
        // The planner never ran — the fail-fast short-circuits before any model call.
        expect(provider.calls).toHaveLength(0);
    });
});
