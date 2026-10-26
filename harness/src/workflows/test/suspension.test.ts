import { DBOS } from "@dbos-inc/dbos-sdk";
import { describe, expect, it } from "bun:test";
import { APICallError } from "@ai-sdk/provider";

import { makeSession } from "../../providers/__fixtures__/session.js";
import { runLoop } from "../../loop/run-loop.js";
import { scriptedModel } from "../../testing.js";
import { cancelSelf, suspensionOfFailure, suspensionOfRefusal, suspensionOfSpawnRefusal } from "../suspension.js";

describe("a chat turn with a suspend error", () => {
    it("fails the turn, and the host reads the reason of the host by the kind of the error", async () => {
        // A chat turn is not a workflow: nothing marks the analysis. The default map of the provider reads a 402 as a suspension.
        const { provider } = scriptedModel([
            {
                fail: new APICallError({
                    message: "Payment Required",
                    url: "https://model.test/v1/messages",
                    requestBodyValues: {},
                    statusCode: 402,
                    isRetryable: false,
                }),
            },
        ]);

        let failure: unknown;
        try {
            await runLoop(
                { id: "conversation-agent", systemPrompt: "s", model: "m", tools: [], maxIterations: 2 },
                [{ role: "user", content: "hi" }],
                makeSession(),
                {
                    provider,
                    signal: new AbortController().signal,
                    emit: () => {},
                },
            );
        } catch (e) {
            failure = e;
        }

        expect(failure).toBeDefined();
        expect(suspensionOfFailure(failure)).toEqual({ kind: "suspended", reason: "payment_required" });
    });

    it("finds no suspension in a failure whose message only names a budget", () => {
        expect(suspensionOfFailure(new Error("budget exceeded"))).toBeUndefined();
    });

    it("finds the suspension of a failed step that DBOS replays", () => {
        // DBOS records a step error with its enumerable fields only: the `value` of a
        // `ResultError` stays, and its non-enumerable `cause` does not.
        const replayed = Object.assign(new Error("Provider call failed (HTTP 402)"), {
            value: { type: "suspend", retryable: false, reason: "payment_required", status: 402, message: "Provider call failed (HTTP 402)" },
        });

        expect(suspensionOfFailure(replayed)).toEqual({ kind: "suspended", reason: "payment_required" });
    });
});

describe("the suspension of a refusal", () => {
    it("reads the suspend flag of the host, never the reason", () => {
        expect(suspensionOfRefusal({ kind: "suspended", gate: "RunCharge.open", reason: "budget_exceeded" })).toEqual({
            kind: "suspended",
            reason: "budget_exceeded",
        });
        expect(suspensionOfRefusal({ kind: "failed", gate: "RunCharge.open", reason: "budget_exceeded" })).toBeUndefined();
        expect(suspensionOfSpawnRefusal({ type: "labels_refused", op: "createSandbox", reason: "r", suspend: true })).toEqual({
            kind: "suspended",
            reason: "r",
        });
    });
});

describe("cancelSelf", () => {
    it("rejects with an error that names the cause and cancels nothing when no workflow runs", async () => {
        const cancelled: string[] = [];
        const original = DBOS.cancelWorkflow.bind(DBOS);
        // A direct assignment on the DBOS class, which `mock.restore()` does not undo, thus the `finally` puts the original back.
        Reflect.set(DBOS, "cancelWorkflow", (workflowId: string) => {
            cancelled.push(workflowId);
            return Promise.resolve();
        });

        try {
            await expect(cancelSelf("self-cancel-suspended")).rejects.toThrow("outside a workflow");
        } finally {
            Reflect.set(DBOS, "cancelWorkflow", original);
        }

        expect(cancelled).toEqual([]);
    });
});
