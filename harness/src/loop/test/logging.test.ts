/**
 * The loop's diagnostic records.
 *
 * These assert on what an operator reading the log would actually see, because
 * for a sub-agent that is the *only* thing they see: every host filters
 * sub-agent events off its chat surface by `callPath` depth, so the record is
 * the sole surviving account of a run that is not the top-level one.
 *
 * The volume assertions matter as much as the content ones. A terminal record
 * per iteration instead of per run would make the default level unaffordable
 * for exactly the long runs it exists to explain.
 */

import { describe, expect, it } from "bun:test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { ok } from "neverthrow";
import { z } from "zod";

import { createCapturingLogger, type CapturedLog } from "../../__tests__/setup/logger.js";
import { presentFind, presentFirst } from "../../lib/present.js";
import { makeSession } from "../../providers/__fixtures__/session.js";
import { defineTool, type Tool } from "../../tools/define-tool.js";
import { callTools, reply, scriptedModel, text, toolCall, type ScriptStep } from "../../testing.js";
import { runLoop, runWithSalvage, type LoopOptions, type LoopStep } from "../run-loop.js";
import type { AgentDefinition } from "../types.js";

const GO = [{ role: "user" as const, content: "go" }];
const NUDGE = "Call submit now.";

function agentDef(tools: Tool[], maxIterations = 8): AgentDefinition {
    return { id: "test-agent", systemPrompt: "test", model: "claude-test", tools, maxIterations };
}

function echoTool(): Tool {
    return defineTool({
        id: "echo",
        description: "Echo the label back.",
        inputSchema: z.object({ label: z.string() }),
        describeCall: "none",
        execute: ({ label }) => Promise.resolve(ok({ label })),
    });
}

function submitTool(): Tool {
    return defineTool({
        id: "submit",
        description: "Record the final answer.",
        inputSchema: z.object({ answer: z.string() }),
        describeCall: "none",
        execute: () => Promise.resolve(ok({ accepted: true })),
    });
}

/** The inputs of the submit calls that ran, in order. */
function submittedInputs(steps: readonly LoopStep[]): unknown[] {
    return steps.flatMap((step) => step.calls.filter((call) => call.toolName === "submit" && call.output?.outcome === "ok").map((call) => call.input));
}

function baseOpts(script: readonly ScriptStep[], overrides: Partial<LoopOptions> = {}): LoopOptions {
    return { provider: scriptedModel(script).provider, signal: new AbortController().signal, emit: () => {}, ...overrides };
}

/** The text of the last message of a request, when that message is a user message. */
function lastUserText(call: LanguageModelV4CallOptions): string | undefined {
    const last = call.prompt.at(-1);
    if (last?.role !== "user") return undefined;
    return last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** Nine tool-calling iterations, then a reply that ends the run. */
function nineRoundsThenDone(): ScriptStep[] {
    return [...Array.from({ length: 9 }, (_, i) => callTools(toolCall(`t${i}`, "echo", { label: `${i}` }))), reply([text("done")])];
}

/** The terminal records only — the per-iteration `debug` ones are a separate concern. */
function finishRecords(records: readonly CapturedLog[]): CapturedLog[] {
    return records.filter((r) => r.msg.endsWith("run finished"));
}

describe("runLoop — the terminal record", () => {
    it("writes exactly one, carrying the iteration count, reason, cap flag, and usage", async () => {
        const logger = createCapturingLogger();
        const script = [
            reply([toolCall("t1", "echo", { label: "a" })], "tool-calls", { inputTokens: 100, outputTokens: 10 }),
            reply([text("done")], "stop", { inputTokens: 120, outputTokens: 5 }),
        ];

        await runLoop(agentDef([echoTool()]), GO, makeSession(), baseOpts(script, { logger }));

        const finished = finishRecords(logger.records);
        expect(finished).toHaveLength(1);
        const finishedRecord = presentFirst(finished);
        expect(finishedRecord.level).toBe("info");
        expect(finishedRecord.fields).toMatchObject({
            iterations: 2,
            reason: "stop",
            cappedOut: false,
            // Summed across both calls — the run's total, not the last call's.
            usage: { inputTokens: 220, outputTokens: 15 },
        });
    });

    it("stays at one record however long the run gets", async () => {
        const logger = createCapturingLogger();

        await runLoop(agentDef([echoTool()], 20), GO, makeSession(), baseOpts(nineRoundsThenDone(), { logger }));

        expect(finishRecords(logger.records)).toHaveLength(1);
    });

    it("writes the per-iteration detail below the default level, one record for each iteration", async () => {
        const logger = createCapturingLogger();

        await runLoop(agentDef([echoTool()], 20), GO, makeSession(), baseOpts(nineRoundsThenDone(), { logger }));

        const iterationRecords = logger.records.filter((r) => r.level === "debug");
        expect(iterationRecords).toHaveLength(9);
    });

    it("names the tools dispatched in each iteration record", async () => {
        const logger = createCapturingLogger();
        const script = [callTools(toolCall("t1", "echo", { label: "a" }), toolCall("t2", "echo", { label: "b" })), reply([text("done")])];

        await runLoop(agentDef([echoTool()]), GO, makeSession(), baseOpts(script, { logger }));

        const iteration = presentFind(logger.records, (r) => r.level === "debug");
        expect(iteration.fields).toMatchObject({ iteration: 0, tools: ["echo", "echo"] });
    });
});

describe("runLoop — provenance on every record", () => {
    it("carries agentId and callPath as fields, extended for a sub-agent", async () => {
        const logger = createCapturingLogger();
        const script = [callTools(toolCall("t1", "echo", { label: "a" })), reply([text("done")])];
        const session = makeSession({ agentId: "planner", callPath: ["conversation-agent", "planner"] });

        await runLoop(agentDef([echoTool()]), GO, session, baseOpts(script, { logger }));

        expect(logger.records.length).toBeGreaterThan(0);
        for (const record of logger.records) {
            expect(record.fields).toMatchObject({ agentId: "planner", callPath: ["conversation-agent", "planner"] });
            // Queryable as fields — never concatenated into the message text.
            expect(record.msg).not.toContain("planner");
        }
    });
});

describe("runLoop — level follows the outcome class", () => {
    it("records a clean return at info", async () => {
        const logger = createCapturingLogger();

        await runLoop(agentDef([]), GO, makeSession(), baseOpts([reply([text("done")])], { logger }));

        expect(presentFirst(finishRecords(logger.records)).level).toBe("info");
    });

    it("records a capped-out run at warn", async () => {
        const logger = createCapturingLogger();
        // Every reply asks for a tool, so the loop exhausts its budget.
        const script = [callTools(toolCall("t0", "echo", { label: "x" })), callTools(toolCall("t1", "echo", { label: "x" }))];

        const { finish } = await runLoop(agentDef([echoTool()], 2), GO, makeSession(), baseOpts(script, { logger }));

        expect(finish.cappedOut).toBe(true);
        const record = presentFirst(finishRecords(logger.records));
        expect(record.level).toBe("warn");
        expect(record.fields).toMatchObject({ reason: "max_iterations", cappedOut: true });
    });

    it("records a denied approval at warn, carrying the denial as the reason", async () => {
        const logger = createCapturingLogger();
        const denyingTool = defineTool({
            id: "risky",
            description: "Needs approval.",
            inputSchema: z.object({}),
            describeCall: "none",
            approval: () => ({ title: "Risky", command: "risky" }),
            execute: () => Promise.resolve(ok({ ran: true })),
        });

        const { finish } = await runLoop(
            agentDef([denyingTool]),
            GO,
            makeSession(),
            baseOpts([callTools(toolCall("t1", "risky", {}))], { logger, approve: () => Promise.resolve({ kind: "denied", feedback: "nope" }) }),
        );

        expect(finish.reason).toBe("denied");
        const record = presentFirst(finishRecords(logger.records));
        expect(record.level).toBe("warn");
        expect(record.fields).toMatchObject({ reason: "denied", cappedOut: false });
    });

    it("records a run that throws at error, with the iteration count and the error, and no finish record", async () => {
        const logger = createCapturingLogger();
        const script: ScriptStep[] = [callTools(toolCall("t1", "echo", { label: "a" })), { fail: new Error("upstream exploded") }];

        await expect(runLoop(agentDef([echoTool()]), GO, makeSession(), baseOpts(script, { logger }))).rejects.toThrow("upstream exploded");

        const failed = logger.records.filter((r) => r.msg.endsWith("run failed"));
        expect(failed).toHaveLength(1);
        const record = presentFirst(failed);
        expect(record.level).toBe("error");
        expect(record.fields).toMatchObject({ agentId: "conversation-agent", iterations: 1 });
        const errText = record.fields["err"];
        expect(typeof errText === "string" ? errText : "").toContain("upstream exploded");
        expect(finishRecords(logger.records)).toHaveLength(0);
    });
});

describe("runLoop — an unwired logger changes nothing", () => {
    it("writes no record and returns an identical result", async () => {
        const script = [callTools(toolCall("t1", "echo", { label: "a" })), reply([text("done")])];
        const logger = createCapturingLogger();

        const silent = await runLoop(agentDef([echoTool()]), GO, makeSession(), baseOpts(script));
        const logged = await runLoop(agentDef([echoTool()]), GO, makeSession(), baseOpts(script, { logger }));

        expect(silent.finish).toEqual(logged.finish);
        expect(silent.messages).toEqual(logged.messages);
        // The logged run proves the capturing logger works, so the silent run's emptiness
        // is the absence of records rather than a broken assertion.
        expect(logger.records.length).toBeGreaterThan(0);
    });
});

describe("runWithSalvage — the salvage record", () => {
    const salvage = { tools: ["submit"], nudge: NUDGE, hasOutcome: (steps: readonly LoopStep[]) => submittedInputs(steps).length > 0 };

    it("warns when a run ends without recording its terminal outcome", async () => {
        const logger = createCapturingLogger();
        const step: ScriptStep = (call) => (lastUserText(call) === NUDGE ? callTools(toolCall("t1", "submit", { answer: "rescued" })) : reply([text("prose")]));

        const result = await runWithSalvage(agentDef([submitTool()]), GO, makeSession(), baseOpts([step, step, step], { logger }), salvage);

        expect(submittedInputs(result.steps)).toEqual([{ answer: "rescued" }]);
        const salvageRecords = logger.records.filter((r) => r.msg.includes("salvaging"));
        expect(salvageRecords).toHaveLength(1);
        const salvageRecord = presentFirst(salvageRecords);
        expect(salvageRecord.level).toBe("warn");
        expect(salvageRecord.fields).toMatchObject({ agentId: "test-agent" });
    });

    it("writes no salvage record when the first run resolves", async () => {
        const logger = createCapturingLogger();
        const script = [callTools(toolCall("t1", "submit", { answer: "done" })), reply([text("ok")])];

        const result = await runWithSalvage(agentDef([submitTool()]), GO, makeSession(), baseOpts(script, { logger }), salvage);

        expect(submittedInputs(result.steps)).toEqual([{ answer: "done" }]);
        expect(logger.records.filter((r) => r.msg.includes("salvaging"))).toHaveLength(0);
    });
});
