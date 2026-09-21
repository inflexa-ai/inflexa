import { describe, expect, it } from "bun:test";
import { errAsync } from "neverthrow";

import { makeSession } from "../providers/__fixtures__/session.js";
import type { AgentChat } from "../providers/types.js";
import { runAgent } from "../loop/run-agent.js";
import { passthroughStep } from "../loop/run-step.js";
import { suspensionOfFailure, suspensionOfRefusal, suspensionOfSpawnRefusal } from "./suspension.js";

describe("a chat turn with a suspend error", () => {
    it("fails the turn, and the host reads the reason of the host by the kind of the error", async () => {
        // A chat turn is not a workflow: the turn fails, and nothing marks the
        // analysis. The loop holds no pool, thus it has no state to change.
        const provider: AgentChat = {
            capabilities: { toolCalling: true },
            chat: () => errAsync({ type: "suspend", retryable: false, reason: "payment_required", status: 402, message: "Provider call failed (HTTP 402)" }),
        };

        let failure: unknown;
        try {
            await runAgent(
                { id: "conversation-agent", systemPrompt: "s", model: "m", tools: [], maxIterations: 2 },
                [{ role: "user", content: "hi" }],
                makeSession(),
                {
                    provider,
                    signal: new AbortController().signal,
                    emit: () => {},
                    runStep: passthroughStep,
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
