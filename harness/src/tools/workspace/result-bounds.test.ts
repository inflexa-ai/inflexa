import { describe, expect, it } from "bun:test";

import type { ExecResult } from "../../sandbox/types.js";
import { EXEC_STREAM_BYTE_CAP, boundExecResult } from "./result-bounds.js";

function baseResult(over: Partial<ExecResult> = {}): ExecResult {
    return {
        execId: "wf1:step1:1",
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 12,
        timedOut: false,
        ...over,
    };
}

describe("boundExecResult", () => {
    it("returns streams untouched when both fit under the cap", () => {
        const r = boundExecResult(baseResult({ stdout: "hello", stderr: "warn" }));
        expect(r.stdout).toBe("hello");
        expect(r.stderr).toBe("warn");
        expect(r.stdoutTruncated).toBe(false);
        expect(r.stderrTruncated).toBe(false);
        expect(r.stdoutTotalLength).toBe(5);
        expect(r.stderrTotalLength).toBe(4);
    });

    it("truncates oversize stdout independently of stderr", () => {
        const big = "x".repeat(EXEC_STREAM_BYTE_CAP + 100);
        const r = boundExecResult(baseResult({ stdout: big, stderr: "ok" }));
        expect(r.stdoutTruncated).toBe(true);
        expect(r.stdout.length).toBe(EXEC_STREAM_BYTE_CAP);
        expect(r.stdoutTotalLength).toBe(big.length);
        expect(r.stderrTruncated).toBe(false);
        expect(r.stderr).toBe("ok");
    });

    it("truncates oversize stderr independently of stdout", () => {
        const big = "y".repeat(EXEC_STREAM_BYTE_CAP + 100);
        const r = boundExecResult(baseResult({ stdout: "fine", stderr: big }));
        expect(r.stderrTruncated).toBe(true);
        expect(r.stderr.length).toBe(EXEC_STREAM_BYTE_CAP);
        expect(r.stderrTotalLength).toBe(big.length);
        expect(r.stdoutTruncated).toBe(false);
        expect(r.stdout).toBe("fine");
    });

    it("truncates both streams when both are oversize", () => {
        const big = "z".repeat(EXEC_STREAM_BYTE_CAP * 2);
        const r = boundExecResult(baseResult({ stdout: big, stderr: big }));
        expect(r.stdoutTruncated).toBe(true);
        expect(r.stderrTruncated).toBe(true);
        expect(r.stdoutTotalLength).toBe(big.length);
        expect(r.stderrTotalLength).toBe(big.length);
    });

    it("preserves exitCode/durationMs/timedOut through truncation", () => {
        const big = "x".repeat(EXEC_STREAM_BYTE_CAP + 1);
        const r = boundExecResult(baseResult({ stdout: big, exitCode: 137, durationMs: 4321, timedOut: true }));
        expect(r.exitCode).toBe(137);
        expect(r.durationMs).toBe(4321);
        expect(r.timedOut).toBe(true);
    });

    it("preserves the syntheticFailure discriminant when stderr is truncated", () => {
        const big = "z".repeat(EXEC_STREAM_BYTE_CAP + 1);
        const r = boundExecResult(
            baseResult({
                stderr: big,
                syntheticFailure: { reason: "sandbox dead" },
            }),
        );
        expect(r.syntheticFailure).toEqual({ reason: "sandbox dead" });
        expect(r.stderrTruncated).toBe(true);
    });

    it("omits syntheticFailure when not present", () => {
        const r = boundExecResult(baseResult());
        expect("syntheticFailure" in r).toBe(false);
    });
});
