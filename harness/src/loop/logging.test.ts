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
import { ok } from "neverthrow";
import { z } from "zod";

import { createCapturingLogger, type CapturedLog } from "../__tests__/setup/logger.js";
import { makeSession } from "../providers/__fixtures__/session.js";
import { AskRejectedError } from "../tools/approval/contract.js";
import { defineTool, type Tool } from "../tools/define-tool.js";
import { makeMessage, scriptedProvider, textBlock, toolUseBlock } from "./__fixtures__/scripted-provider.js";
import { runAgent, type RunAgentOptions } from "./run-agent.js";
import { passthroughStep } from "./run-step.js";
import { runToTerminal } from "./run-to-terminal.js";
import type { AgentDefinition } from "./types.js";

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
        execute: async ({ label }) => ok({ label }),
    });
}

function submitTool(cell: { value: string | null }): Tool {
    return defineTool({
        id: "submit",
        description: "Record the final answer.",
        inputSchema: z.object({ answer: z.string() }),
        execute: async ({ answer }) => {
            cell.value = answer;
            return ok({ accepted: true });
        },
    });
}

function baseOpts(provider: RunAgentOptions["provider"], overrides: Partial<RunAgentOptions> = {}): RunAgentOptions {
    return { provider, signal: new AbortController().signal, emit: () => {}, runStep: passthroughStep, ...overrides };
}

/** The terminal records only — the per-iteration `debug` ones are a separate concern. */
function finishRecords(records: readonly CapturedLog[]): CapturedLog[] {
    return records.filter((r) => r.msg.endsWith("run finished"));
}

describe("runAgent — the terminal record", () => {
    it("writes exactly one, carrying the iteration count, reason, cap flag, and usage", async () => {
        const logger = createCapturingLogger();
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("t1", "echo", { label: "a" })], "tool_use", { inputTokens: 100, outputTokens: 10 }),
            makeMessage([textBlock("done")], "end_turn", { inputTokens: 120, outputTokens: 5 }),
        ]);

        await runAgent(agentDef([echoTool()]), GO, makeSession(), baseOpts(provider, { logger }));

        const finished = finishRecords(logger.records);
        expect(finished).toHaveLength(1);
        expect(finished[0]!.level).toBe("info");
        expect(finished[0]!.fields).toMatchObject({
            iterations: 2,
            reason: "stop",
            cappedOut: false,
            // Summed across both calls — the run's total, not the last call's.
            usage: { inputTokens: 220, outputTokens: 15 },
        });
    });

    it("stays at one record however long the run gets", async () => {
        const logger = createCapturingLogger();
        // Nine tool-calling iterations, then a reply that ends the run.
        const provider = scriptedProvider((i) =>
            i < 9 ? makeMessage([toolUseBlock(`t${i}`, "echo", { label: `${i}` })], "tool_use") : makeMessage([textBlock("done")], "end_turn"),
        );

        await runAgent(agentDef([echoTool()], 20), GO, makeSession(), baseOpts(provider, { logger }));

        expect(finishRecords(logger.records)).toHaveLength(1);
        // The per-iteration detail exists, but only below the default level.
        const iterationRecords = logger.records.filter((r) => r.level === "debug");
        expect(iterationRecords).toHaveLength(9);
        expect(iterationRecords.every((r) => r.level === "debug")).toBe(true);
    });

    it("names the tools dispatched in each iteration record", async () => {
        const logger = createCapturingLogger();
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("t1", "echo", { label: "a" }), toolUseBlock("t2", "echo", { label: "b" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        await runAgent(agentDef([echoTool()]), GO, makeSession(), baseOpts(provider, { logger }));

        const iteration = logger.records.find((r) => r.level === "debug")!;
        expect(iteration.fields).toMatchObject({ iteration: 0, tools: ["echo", "echo"] });
    });
});

describe("runAgent — provenance on every record", () => {
    it("carries agentId and callPath as fields, extended for a sub-agent", async () => {
        const logger = createCapturingLogger();
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("t1", "echo", { label: "a" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);
        const session = makeSession({ agentId: "planner", callPath: ["conversation-agent", "planner"] });

        await runAgent(agentDef([echoTool()]), GO, session, baseOpts(provider, { logger }));

        expect(logger.records.length).toBeGreaterThan(0);
        for (const record of logger.records) {
            expect(record.fields).toMatchObject({ agentId: "planner", callPath: ["conversation-agent", "planner"] });
            // Queryable as fields — never concatenated into the message text.
            expect(record.msg).not.toContain("planner");
        }
    });
});

describe("runAgent — level follows the outcome class", () => {
    it("records a clean return at info", async () => {
        const logger = createCapturingLogger();
        const provider = scriptedProvider([makeMessage([textBlock("done")], "end_turn")]);

        await runAgent(agentDef([]), GO, makeSession(), baseOpts(provider, { logger }));

        expect(finishRecords(logger.records)[0]!.level).toBe("info");
    });

    it("records a capped-out run at warn", async () => {
        const logger = createCapturingLogger();
        // Every reply asks for a tool, so the loop exhausts its budget and takes the wrap-up.
        const provider = scriptedProvider((i) =>
            i < 2 ? makeMessage([toolUseBlock(`t${i}`, "echo", { label: "x" })], "tool_use") : makeMessage([textBlock("wrapped up")], "end_turn"),
        );

        const { finish } = await runAgent(agentDef([echoTool()], 2), GO, makeSession(), baseOpts(provider, { logger }));

        expect(finish.cappedOut).toBe(true);
        const record = finishRecords(logger.records)[0]!;
        expect(record.level).toBe("warn");
        expect(record.fields).toMatchObject({ reason: "max_iterations", cappedOut: true });
    });

    it("records a denied approval at warn, carrying the denial as the reason", async () => {
        const logger = createCapturingLogger();
        const denyingTool = defineTool({
            id: "risky",
            description: "Needs approval.",
            inputSchema: z.object({}),
            execute: async () => {
                throw new AskRejectedError("nope");
            },
        });
        const provider = scriptedProvider([makeMessage([toolUseBlock("t1", "risky", {})], "tool_use")]);

        const { finish } = await runAgent(agentDef([denyingTool]), GO, makeSession(), baseOpts(provider, { logger }));

        expect(finish.reason).toBe("denied");
        const record = finishRecords(logger.records)[0]!;
        expect(record.level).toBe("warn");
        expect(record.fields).toMatchObject({ reason: "denied", cappedOut: false });
    });
});

describe("runAgent — an unwired logger changes nothing", () => {
    it("writes no record and returns an identical result", async () => {
        const script = [makeMessage([toolUseBlock("t1", "echo", { label: "a" })], "tool_use"), makeMessage([textBlock("done")], "end_turn")];
        const logger = createCapturingLogger();

        const silent = await runAgent(agentDef([echoTool()]), GO, makeSession(), baseOpts(scriptedProvider([...script])));
        const logged = await runAgent(agentDef([echoTool()]), GO, makeSession(), baseOpts(scriptedProvider([...script]), { logger }));

        expect(silent.finish).toEqual(logged.finish);
        expect(silent.messages).toEqual(logged.messages);
        // The logged run proves the capturing logger works, so the silent run's emptiness
        // is the absence of records rather than a broken assertion.
        expect(logger.records.length).toBeGreaterThan(0);
    });
});

describe("runToTerminal — the salvage record", () => {
    it("warns when a run ends without recording its terminal outcome", async () => {
        const logger = createCapturingLogger();
        const cell = { value: null as string | null };
        const tool = submitTool(cell);
        const provider = scriptedProvider((_i, request) => {
            const last = request.messages.at(-1);
            const isSalvage = last?.role === "user" && last.content === NUDGE;
            return isSalvage ? makeMessage([toolUseBlock("t1", "submit", { answer: "rescued" })], "tool_use") : makeMessage([textBlock("prose")], "end_turn");
        });

        await runToTerminal(agentDef([tool]), GO, makeSession(), baseOpts(provider, { logger, resolved: () => cell.value !== null }), {
            tools: [tool],
            nudge: NUDGE,
        });

        const salvage = logger.records.filter((r) => r.msg.includes("salvaging"));
        expect(salvage).toHaveLength(1);
        expect(salvage[0]!.level).toBe("warn");
        expect(salvage[0]!.fields).toMatchObject({ agentId: "test-agent" });
    });

    it("writes no salvage record when the first run resolves", async () => {
        const logger = createCapturingLogger();
        const cell = { value: null as string | null };
        const tool = submitTool(cell);
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("t1", "submit", { answer: "done" })], "tool_use"),
            makeMessage([textBlock("ok")], "end_turn"),
        ]);

        await runToTerminal(agentDef([tool]), GO, makeSession(), baseOpts(provider, { logger, resolved: () => cell.value !== null }), {
            tools: [tool],
            nudge: NUDGE,
        });

        expect(cell.value).toBe("done");
        expect(logger.records.filter((r) => r.msg.includes("salvaging"))).toHaveLength(0);
    });
});
