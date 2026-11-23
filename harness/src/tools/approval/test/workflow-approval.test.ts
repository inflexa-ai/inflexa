/**
 * The approval of a loop in a workflow that is not a chat turn, as a sandbox step runs it: the ask row names the
 * workflow, the answer reaches it by the ask id, and a denial lets the loop continue.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { ok } from "neverthrow";
import { z } from "zod";

import { setupDbosForTests, type DbosTestRig } from "../../../__tests__/setup/dbos.js";
import { runLoop } from "../../../loop/run-loop.js";
import { makeSession } from "../../../providers/__fixtures__/session.js";
import type { ChatProvider } from "../../../providers/types.js";
import { callTools, reply, scriptedModel, text, toolCall } from "../../../testing.js";
import { defineTool } from "../../define-tool.js";
import { createAskGateway } from "../gateway.js";
import { sendAskAnswer, workflowApproval } from "../workflow-approval.js";

if (DBOS.isInitialized()) {
    await DBOS.shutdown();
}

const ANALYSIS = "analysis-step-ask";

let rig: DbosTestRig;
let provider: ChatProvider = scriptedModel([]).provider;
let downloads = 0;
let waitSeconds: number | "until-answered" = 60;

const download = defineTool({
    id: "download",
    description: "Downloads a file after an approval.",
    inputSchema: z.object({}),
    view: "none",
    describeCall: "none",
    approval: () => ({ title: "Download", command: "https://ftp.example.org/a.fa", grantKey: "download-ref:ftp.example.org", grantScope: "user" }),
    execute: () => {
        downloads += 1;
        return Promise.resolve(ok({ ran: true }));
    },
});

const stepWorkflow = DBOS.registerWorkflow(
    async (): Promise<{ readonly finishReason: string; readonly results: readonly unknown[] }> => {
        const workflowId = DBOS.workflowID ?? "";
        const result = await runLoop(
            { id: "step-agent", systemPrompt: "You are a step agent.", model: "scripted-model", tools: [download], maxIterations: 5 },
            [{ role: "user", content: "get the reference" }],
            makeSession(),
            {
                provider,
                signal: new AbortController().signal,
                emit: () => undefined,
                approve: workflowApproval({
                    gateway: createAskGateway({ pool: rig.pool }),
                    workflowId,
                    scope: { analysisId: ANALYSIS, userId: "user-1" },
                    stepPrefix: "test-step",
                    emitPart: (part) => DBOS.writeStream("events", part),
                    waitSeconds,
                    untilAnsweredWaitSeconds: 1,
                }),
                continuesAfterDenial: true,
            },
        );
        const results = result.messages.flatMap((message) =>
            message.role === "tool" && Array.isArray(message.content) ? message.content.map((part) => ("output" in part ? part.output : undefined)) : [],
        );
        return { finishReason: result.finish.reason, results };
    },
    { name: "test-step-approval" },
);

beforeAll(async () => {
    rig = await setupDbosForTests("workflow_approval");
    if (!DBOS.isInitialized()) await DBOS.launch();
});

afterAll(async () => {
    await rig.drop();
});

/** The pending ask of the workflow, once the workflow raised it. */
async function pendingAskOf(workflowId: string): Promise<string> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const { rows } = await rig.pool.query<{ id: string }>("SELECT id FROM cortex_asks WHERE workflow_id = $1 AND status = 'pending'", [workflowId]);
        const id = rows[0]?.id;
        if (id !== undefined) return id;
        await Bun.sleep(50);
    }
    throw new Error("the workflow raised no ask");
}

async function eventsOf(workflowId: string): Promise<unknown[]> {
    const events: unknown[] = [];
    for await (const event of DBOS.readStream(workflowId, "events")) events.push(event);
    return events;
}

describe("the approval of a step workflow", () => {
    it("sends the answer to the workflow of the ask row, and the call runs", async () => {
        downloads = 0;
        provider = scriptedModel([callTools(toolCall("d1", "download", {})), reply([text("Downloaded.")])]).provider;
        const workflowId = `step-${rig.nextWorkflowId()}`;

        const handle = await DBOS.startWorkflow(stepWorkflow, { workflowID: workflowId })();
        const askId = await pendingAskOf(workflowId);
        expect(await sendAskAnswer(createAskGateway({ pool: rig.pool }), askId, { kind: "once" })).toBe("applied");
        const ended = await handle.getResult();

        expect(downloads).toBe(1);
        expect(ended.finishReason).toBe("stop");
        const parts = (await eventsOf(workflowId)).filter((event) => z.object({ type: z.literal("data-ask") }).safeParse(event).success);
        expect(parts).toMatchObject([
            { id: askId, status: "pending" },
            { id: askId, status: "resolved", reply: "once" },
        ]);
    });

    it("waits past the end of each wait until an answer comes, when the ask waits until answered", async () => {
        downloads = 0;
        waitSeconds = "until-answered";
        provider = scriptedModel([callTools(toolCall("d1", "download", {})), reply([text("Downloaded.")])]).provider;
        const workflowId = `step-${rig.nextWorkflowId()}`;

        try {
            const handle = await DBOS.startWorkflow(stepWorkflow, { workflowID: workflowId })();
            const askId = await pendingAskOf(workflowId);
            // Two ends of a wait of one second pass with no answer, and the ask stays pending.
            await Bun.sleep(2_500);
            const { rows } = await rig.pool.query<{ status: string }>("SELECT status FROM cortex_asks WHERE id = $1", [askId]);
            expect(rows).toEqual([{ status: "pending" }]);
            expect(await sendAskAnswer(createAskGateway({ pool: rig.pool }), askId, { kind: "once" })).toBe("applied");
            const ended = await handle.getResult();

            expect(downloads).toBe(1);
            expect(ended.finishReason).toBe("stop");
        } finally {
            waitSeconds = 60;
        }
    });

    it("gives a rejected call a denied result, and the step agent makes its next request", async () => {
        downloads = 0;
        const scripted = scriptedModel([callTools(toolCall("d1", "download", {})), reply([text("I report a blocker.")])]);
        provider = scripted.provider;
        const workflowId = `step-${rig.nextWorkflowId()}`;

        const handle = await DBOS.startWorkflow(stepWorkflow, { workflowID: workflowId })();
        const askId = await pendingAskOf(workflowId);
        await sendAskAnswer(createAskGateway({ pool: rig.pool }), askId, { kind: "reject", feedback: "not this host" });
        const ended = await handle.getResult();

        expect(downloads).toBe(0);
        expect(scripted.calls).toHaveLength(2);
        expect(ended.finishReason).toBe("stop");
        expect(ended.results).toMatchObject([{ type: "execution-denied" }]);
    });

    it("settles a later ask of the same host in a different workflow with no wait after an always answer", async () => {
        downloads = 0;
        provider = scriptedModel([callTools(toolCall("d1", "download", {})), reply([text("Downloaded.")])]).provider;
        const first = `step-${rig.nextWorkflowId()}`;
        const handle = await DBOS.startWorkflow(stepWorkflow, { workflowID: first })();
        await sendAskAnswer(createAskGateway({ pool: rig.pool }), await pendingAskOf(first), { kind: "always" });
        await handle.getResult();

        try {
            provider = scriptedModel([callTools(toolCall("d1", "download", {})), reply([text("Downloaded.")])]).provider;
            const second = `step-${rig.nextWorkflowId()}`;
            await DBOS.startWorkflow(stepWorkflow, { workflowID: second })().then((started) => started.getResult());

            expect(downloads).toBe(2);
            const { rows } = await rig.pool.query<{ status: string }>("SELECT status FROM cortex_asks WHERE workflow_id = $1", [second]);
            expect(rows).toEqual([{ status: "resolved" }]);
        } finally {
            await rig.pool.query("DELETE FROM cortex_user_grants WHERE user_id = 'user-1'");
        }
    });
});
