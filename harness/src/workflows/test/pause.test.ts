/**
 * The cause of a pause, and the pause outside a workflow (work-pause spec). The wait itself runs in a workflow body,
 * and `src/workflows/__tests__/dbos/test/pause.test.ts` covers it.
 */

import { describe, expect, it } from "bun:test";

import { ResultError } from "../../lib/result.js";
import { runLoop } from "../../loop/run-loop.js";
import { TurnCredentialMissingError } from "../../loop/turn-credentials.js";
import { toProviderError } from "../../providers/errors.js";
import { makeSession } from "../../providers/__fixtures__/session.js";
import type { Querier } from "../../state/db.js";
import { reply, scriptedModel, text } from "../../testing.js";
import { pauseCauseOf, pauseTopic, workPause } from "../pause.js";

/** A model call that failed after its retries, as the retry envelope throws it. */
function failedCall(statusCode: number, message = `HTTP ${statusCode}`): ResultError {
    return new ResultError(toProviderError(Object.assign(new Error(message), { statusCode }), "a test call"));
}

/** A pool that fails each query, because no test here reaches a write. */
const unusedPool: Querier = { query: () => Promise.reject(new Error("the pause wrote a row outside a workflow")) };

describe("the cause of a pause", () => {
    it("names the cause of each failure that a person or time can repair", () => {
        expect(pauseCauseOf(failedCall(402))).toEqual({ kind: "host", reason: "payment_required" });
        expect(pauseCauseOf(failedCall(401))).toEqual({ kind: "credential" });
        expect(pauseCauseOf(failedCall(503))).toEqual({ kind: "outage" });
        expect(pauseCauseOf(new TurnCredentialMissingError())).toEqual({ kind: "credential" });
        expect(pauseCauseOf(new Error("wrapped", { cause: new TurnCredentialMissingError() }))).toEqual({ kind: "credential" });
    });

    it("gives no cause for a refused request, and none from the text of a message", () => {
        expect(pauseCauseOf(failedCall(400, "budget exceeded"))).toBeUndefined();
        expect(pauseCauseOf(new Error("budget_exceeded: payment required"))).toBeUndefined();
    });

    it("gives each pause its own topic", () => {
        expect(pauseTopic("p-1")).not.toBe(pauseTopic("p-2"));
    });
});

describe("the pause outside a workflow", () => {
    it("does not wait, thus the loop throws the failure", async () => {
        const pause = workPause({ pool: unusedPool, workId: "w-1", workKind: "run", analysisId: "a-1", emit: () => Promise.resolve() });
        expect(await pause.forCause({ kind: "host", reason: "payment_required" }, 0)).toBeUndefined();

        const model = scriptedModel([{ fail: Object.assign(new Error("HTTP 402"), { statusCode: 402 }) }, reply([text("unused")])]);
        const run = runLoop(
            { id: "outside", systemPrompt: "Test.", model: "scripted-model", tools: [], maxIterations: 2 },
            [{ role: "user", content: "go" }],
            makeSession({ agentId: "outside", callPath: ["outside"] }),
            { provider: model.provider, emit: () => undefined, signal: new AbortController().signal, pause: pause.afterFailure },
        );
        await expect(run).rejects.toMatchObject({ value: { type: "suspend", reason: "payment_required" } });
        expect(model.calls).toHaveLength(1);
    });
});
