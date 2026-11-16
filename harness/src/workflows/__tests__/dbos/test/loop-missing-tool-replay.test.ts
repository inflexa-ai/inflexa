/**
 * A recovery uses the tools that are available at the time of the recovery.
 *
 * The first run calls the tool `echo`, then it parks on its second model request until the test cancels the
 * workflow from outside, which is a crash in the middle of the run. Before the resume, the tool leaves the agent, as
 * when a user removes an MCP server or turns off a connector during a run. The resume must replay the recorded call
 * from its checkpoint and finish the run. A new call of the tool after the resume gets an error result, and the tool
 * does not run.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { ok } from "neverthrow";
import { z } from "zod";

import { setupDbosForTests, type DbosTestRig } from "../../../../__tests__/setup/dbos.js";
import { recoverAtCrashPoint } from "../../../../__tests__/setup/dbos-crash.js";
import { callTools, reply, scriptedModel, text, toolCall, type ScriptEntry } from "../../../../testing.js";
import { runLoop } from "../../../../loop/run-loop.js";
import { makeSession } from "../../../../providers/__fixtures__/session.js";
import { defineTool } from "../../../../tools/define-tool.js";

if (DBOS.isInitialized()) {
    await DBOS.shutdown();
}

let toolRuns = 0;
let parked = false;
let echoAttached = true;

const echo = defineTool({
    id: "echo",
    description: "Echo the text.",
    inputSchema: z.object({ text: z.string() }),
    view: "none",
    describeCall: "none",
    execute: (input) => {
        toolRuns += 1;
        return Promise.resolve(ok({ echoed: input.text }));
    },
});

const other = defineTool({
    id: "other",
    description: "Another tool.",
    inputSchema: z.object({}),
    view: "none",
    describeCall: "none",
    execute: () => Promise.resolve(ok({ ran: true })),
});

/** The second request of the first run parks until the cancel aborts it. */
async function secondReply(abortSignal: AbortSignal | undefined): Promise<ScriptEntry> {
    parked = true;
    await new Promise<void>((resolve) => abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
    return { fail: abortSignal?.reason };
}

const scripted = scriptedModel([
    callTools(toolCall("c1", "echo", { text: "hi" })),
    (call) => secondReply(call.abortSignal),
    callTools(toolCall("c2", "echo", { text: "again" })),
    reply([text("done")], "stop"),
]);

const loopWorkflow = DBOS.registerWorkflow(
    async (): Promise<{ reason: string; errors: string[] }> => {
        const result = await runLoop(
            { id: "replay-agent", systemPrompt: "Test.", model: "scripted-model", tools: echoAttached ? [echo, other] : [other], maxIterations: 6 },
            [{ role: "user", content: "go" }],
            { ...makeSession({ agentId: "replay-agent", callPath: ["replay-agent"] }), runFrame: { runId: "run-1", stepId: "step-1" } },
            { provider: scripted.provider, emit: () => undefined, signal: new AbortController().signal },
        );
        const errors = result.messages.flatMap((message) =>
            message.role === "tool"
                ? message.content.flatMap((part) => (part.type === "tool-result" && part.output.type === "error-text" ? [part.toolCallId] : []))
                : [],
        );
        return { reason: result.finish.reason, errors };
    },
    { name: "loop-missing-tool-replay" },
);

let rig: DbosTestRig;

beforeAll(async () => {
    rig = await setupDbosForTests("loop_missing_tool_replay");
    if (!DBOS.isInitialized()) await DBOS.launch();
});

afterAll(async () => {
    await rig.drop();
});

describe("a recovery after a tool left the agent", () => {
    it("replays the recorded call, and a new call of the tool gets an error", async () => {
        const wfId = rig.nextWorkflowId("loop-missing-tool-");
        const first = await DBOS.startWorkflow(loopWorkflow, { workflowID: wfId })();
        const ended = first.getResult().catch(() => undefined);

        const handle = await recoverAtCrashPoint<{ reason: string; errors: string[] }>(
            wfId,
            () => {
                if (!parked) return false;
                echoAttached = false;
                return true;
            },
            { ended },
        );
        const result = await handle.getResult();

        expect(result.reason).toBe("stop");
        expect(result.errors).toEqual(["c2"]);
        expect(toolRuns).toBe(1);
    });
});
