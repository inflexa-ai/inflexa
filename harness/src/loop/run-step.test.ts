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

import { afterEach, describe, expect, it, mock } from "bun:test";
import { err, ok } from "neverthrow";

import { ResultError } from "../lib/result.js";
import { durableStep, passthroughStep, resultStep } from "./run-step.js";

afterEach(() => {
    mock.restore();
});

describe("passthroughStep", () => {
    it("invokes the function and returns its result", async () => {
        const result = await passthroughStep("llm-0", async () => 42);
        expect(result).toBe(42);
    });

    it("propagates errors", async () => {
        await expect(
            passthroughStep("tool-add-id-1", async () => {
                throw new Error("step-failure");
            }),
        ).rejects.toThrow("step-failure");
    });
});

describe("durableStep", () => {
    it("forwards to DBOS.runStep with the supplied name", async () => {
        const dbos = await import("@dbos-inc/dbos-sdk");
        const stub = mock(async (fn: () => Promise<unknown>, _config?: { name?: string }) => fn());
        (dbos.DBOS.runStep as unknown) = stub;

        const result = await durableStep("llm-3", async () => "ok");

        expect(result).toBe("ok");
        expect(stub).toHaveBeenCalledTimes(1);
        const [, config] = stub.mock.calls[0]!;
        expect(config).toEqual({ name: "llm-3" });
    });

    it("preserves the step-naming contract for tool calls", async () => {
        const dbos = await import("@dbos-inc/dbos-sdk");
        const stub = mock(async (fn: () => Promise<unknown>, _config?: { name?: string }) => fn());
        (dbos.DBOS.runStep as unknown) = stub;

        await durableStep("tool-add-toolu_abc123", async () => "1");

        const [, config] = stub.mock.calls[0]!;
        expect(config).toEqual({ name: "tool-add-toolu_abc123" });
    });
});

describe("resultStep", () => {
    const step = resultStep(passthroughStep);

    it("returns the value of an ok body", async () => {
        expect(await step("llm-0", async () => ok(7))).toBe(7);
    });

    it("throws at the boundary on an err body so durability records failure", async () => {
        await expect(step("llm-0", async () => err({ type: "db_query_failed" }))).rejects.toBeInstanceOf(ResultError);
    });

    it("rethrows an Error err value verbatim, preserving its cause chain", async () => {
        const cause = new Error("ECONNREFUSED");
        const original = new Error("provider down", { cause });
        await expect(step("llm-0", async () => err(original))).rejects.toBe(original);
    });
});
