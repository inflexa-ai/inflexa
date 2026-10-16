/**
 * Unit tests for `passthroughStep` and `durableStep`.
 *
 * `durableStep` is a thin delegation to `DBOS.runStep`. The test mocks
 * `DBOS.runStep` and asserts the call was forwarded with the expected
 * `{ name }` config and that the result round-trips.
 *
 * The deep semantics of step replay are exercised end-to-end by the
 * durable workflow tests.
 */

import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { err, ok } from "neverthrow";

import { ResultError } from "../../lib/result.js";
import { durableStep, passthroughStep, resultStep } from "../run-step.js";

/**
 * `DBOS.runStep` is stubbed by DIRECT property assignment, which
 * `mock.restore()` does NOT undo — capture the original once and put it
 * back in `afterAll` so the stub cannot leak into later test files that
 * drive a real DBOS engine.
 */
let originalRunStep: unknown;

async function stubRunStep() {
    const dbos = await import("@dbos-inc/dbos-sdk");
    originalRunStep ??= dbos.DBOS["runStep"];
    const stub = mock((fn: () => Promise<unknown>, _config?: { name?: string }) => Promise.resolve(fn()));
    // SAFETY: the value is test-controlled — a fixture, a double answer, or the unit under test answering the input this test built — so the cast names a shape the test itself determines.
    (dbos.DBOS.runStep as unknown) = stub;
    return stub;
}

afterEach(() => {
    mock.restore();
});

afterAll(async () => {
    if (originalRunStep === undefined) return;
    const dbos = await import("@dbos-inc/dbos-sdk");
    // SAFETY: the value is test-controlled — a fixture, a double answer, or the unit under test answering the input this test built — so the cast names a shape the test itself determines.
    (dbos.DBOS.runStep as unknown) = originalRunStep;
});

describe("passthroughStep", () => {
    it("invokes the function and returns its result", async () => {
        const result = await passthroughStep("llm-0", () => Promise.resolve(42));
        expect(result).toBe(42);
    });

    it("propagates errors", async () => {
        await expect(passthroughStep("tool-add-id-1", () => Promise.reject(new Error("step-failure")))).rejects.toThrow("step-failure");
    });
});

describe("durableStep", () => {
    it("forwards to DBOS.runStep with the supplied name", async () => {
        const stub = await stubRunStep();

        const result = await durableStep("llm-3", () => Promise.resolve("ok"));

        expect(result).toBe("ok");
        expect(stub).toHaveBeenCalledTimes(1);
        const [, config] = stub.mock.calls[0];
        expect(config).toEqual({ name: "llm-3" });
    });

    it("preserves the step-naming contract for tool calls", async () => {
        const stub = await stubRunStep();

        await durableStep("tool-add-toolu_abc123", () => Promise.resolve("1"));

        const [, config] = stub.mock.calls[0];
        expect(config).toEqual({ name: "tool-add-toolu_abc123" });
    });
});

describe("resultStep", () => {
    const step = resultStep(passthroughStep);

    it("returns the value of an ok body", async () => {
        expect(await step("llm-0", () => Promise.resolve(ok(7)))).toBe(7);
    });

    it("throws at the boundary on an err body so durability records failure", async () => {
        await expect(step("llm-0", () => Promise.resolve(err({ type: "db_query_failed" })))).rejects.toBeInstanceOf(ResultError);
    });

    it("rethrows an Error err value verbatim, preserving its cause chain", async () => {
        const cause = new Error("ECONNREFUSED");
        const original = new Error("provider down", { cause });
        await expect(step("llm-0", () => Promise.resolve(err(original)))).rejects.toBe(original);
    });
});
