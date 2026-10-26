/**
 * The agent loop inside a DBOS workflow replays its completed calls.
 *
 * The workflow runs the loop over a scripted model. The second model request
 * parks until the test cancels the workflow from outside, which is a crash in
 * the middle of the run. The resume replays the first model call and the tool
 * call from their checkpoints, thus the model gets no second copy of the first
 * request and the tool runs one time. The usage of a replayed call is not
 * recorded again, and the call record of the replayed tool call folds again.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { ok, okAsync } from "neverthrow";
import { z } from "zod";

import { setupDbosForTests, type DbosTestRig } from "../../../../__tests__/setup/dbos.js";
import type { LlmUsageRecord, UsageRecorder } from "../../../../billing/usage-recorder.js";
import { recoverAtCrashPoint } from "../../../../__tests__/setup/dbos-crash.js";
import { callTools, reply, scriptedModel, text, toolCall, type ScriptEntry } from "../../../../testing.js";
import { runLoop } from "../../../../loop/run-loop.js";
import { makeSession } from "../../../../providers/__fixtures__/session.js";
import { defineTool, withToolCallRecord } from "../../../../tools/define-tool.js";

if (DBOS.isInitialized()) {
    await DBOS.shutdown();
}

let toolRuns = 0;
let parked = false;
const folded: unknown[] = [];
const usageRecords: LlmUsageRecord[] = [];
const usageRecorder: UsageRecorder = {
    record: (record) => {
        usageRecords.push(record);
        return okAsync(undefined);
    },
};

const echo = defineTool({
    id: "echo",
    description: "Echo the text.",
    inputSchema: z.object({ text: z.string() }),
    describeCall: "none",
    execute: (input) => {
        toolRuns += 1;
        return Promise.resolve(ok(withToolCallRecord({ echoed: input.text }, { lineage: input.text })));
    },
    foldCallRecord: (record) => {
        folded.push(record);
    },
});

/** The second request of the first run parks until the cancel aborts it. */
async function secondReply(abortSignal: AbortSignal | undefined): Promise<ScriptEntry> {
    parked = true;
    await new Promise<void>((resolve) => abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
    return { fail: abortSignal?.reason };
}

const usage = { inputTokens: 10, outputTokens: 5 };

const scripted = scriptedModel([
    { ...callTools(toolCall("c1", "echo", { text: "hi" })), usage },
    (call) => secondReply(call.abortSignal),
    reply([text("done")], "stop", usage),
]);

const loopWorkflow = DBOS.registerWorkflow(
    async (): Promise<{ reason: string; text: string }> => {
        const result = await runLoop(
            { id: "replay-agent", systemPrompt: "Test.", model: "scripted-model", tools: [echo], maxIterations: 5 },
            [{ role: "user", content: "go" }],
            { ...makeSession({ agentId: "replay-agent", callPath: ["replay-agent"] }), runFrame: { runId: "run-1", stepId: "step-1" } },
            { provider: scripted.provider, emit: () => undefined, signal: new AbortController().signal, usageRecorder },
        );
        const last = result.messages.at(-1);
        return {
            reason: result.finish.reason,
            text: last?.role === "assistant" && typeof last.content !== "string" ? last.content.map((p) => (p.type === "text" ? p.text : "")).join("") : "",
        };
    },
    { name: "loop-replay" },
);

let rig: DbosTestRig;

beforeAll(async () => {
    rig = await setupDbosForTests("loop_replay");
    if (!DBOS.isInitialized()) await DBOS.launch();
});

afterAll(async () => {
    await rig.drop();
});

describe("the loop inside a workflow", () => {
    it("replays the completed model call and tool call after a crash", async () => {
        const wfId = rig.nextWorkflowId("loop-replay-");
        const first = await DBOS.startWorkflow(loopWorkflow, { workflowID: wfId })();
        const ended = first.getResult().catch(() => undefined);

        const handle = await recoverAtCrashPoint<{ reason: string; text: string }>(wfId, () => parked, { ended });
        const result = await handle.getResult();

        expect(result).toEqual({ reason: "stop", text: "done" });
        expect(toolRuns).toBe(1);
        // The first request, the parked second request, and the second request of the resume.
        expect(scripted.calls).toHaveLength(3);
        const steps = await DBOS.listWorkflowSteps(wfId);
        expect(steps?.map((step) => step.name)).toEqual(["replay-agent.model", "echo.c1", "replay-agent.model"]);
        // The first run and the replay each fold the record of the one tool call.
        expect(folded).toEqual([{ lineage: "hi" }, { lineage: "hi" }]);
        // The replay gives the first call from its checkpoint, thus its usage counts one time.
        expect(usageRecords.map((record) => record.recordKey)).toEqual(["run-1:step-1:replay-agent:response-0", "run-1:step-1:replay-agent:response-2"]);
    });
});
