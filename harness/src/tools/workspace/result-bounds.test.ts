import { describe, expect, it } from "bun:test";

import type { ExecResult } from "../../sandbox/types.js";
import { EXEC_STREAM_BYTE_CAP, boundExecResult, capExecStreams } from "./result-bounds.js";

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

describe("boundExecResult with producer-side truncation", () => {
    it("reports the sandbox's total rather than the length of what survived", () => {
        // The sandbox kept 100 bytes of a 9 MB stream, so the retained slice is
        // well under the cap — its length is not the number to report.
        const r = boundExecResult(
            baseResult({
                stdout: "y".repeat(100),
                stdoutTruncated: true,
                stdoutTotalBytes: 9_000_000,
            }),
        );
        expect(r.stdoutTruncated).toBe(true);
        expect(r.stdoutTotalLength).toBe(9_000_000);
    });

    it("stays truncated when both the producer and the host cut", () => {
        const big = "z".repeat(EXEC_STREAM_BYTE_CAP + 1);
        const r = boundExecResult(baseResult({ stderr: big, stderrTruncated: true, stderrTotalBytes: 5_000_000 }));
        expect(r.stderrTruncated).toBe(true);
        expect(r.stderrTotalLength).toBe(5_000_000);
        expect(Buffer.byteLength(r.stderr, "utf8")).toBeLessThanOrEqual(EXEC_STREAM_BYTE_CAP);
    });

    it("falls back to the local measurement when the sandbox reports no total", () => {
        const big = "q".repeat(EXEC_STREAM_BYTE_CAP + 10);
        const r = boundExecResult(baseResult({ stdout: big }));
        expect(r.stdoutTruncated).toBe(true);
        expect(r.stdoutTotalLength).toBe(EXEC_STREAM_BYTE_CAP + 10);
    });
});

describe("capExecStreams", () => {
    it("returns the input unchanged when nothing needs cutting", () => {
        const input = baseResult({ stdout: "small", stderr: "" });
        expect(capExecStreams(input)).toBe(input);
    });

    it("cuts oversize streams while keeping the ExecResult shape", () => {
        const big = "x".repeat(EXEC_STREAM_BYTE_CAP + 500);
        const r = capExecStreams(baseResult({ stdout: big, execId: "wf1:step1:7", exitCode: 2 }));
        expect(Buffer.byteLength(r.stdout, "utf8")).toBeLessThanOrEqual(EXEC_STREAM_BYTE_CAP);
        expect(r.stdoutTruncated).toBe(true);
        expect(r.stdoutTotalBytes).toBe(EXEC_STREAM_BYTE_CAP + 500);
        // Shape and discriminants survive — this value is forwarded onward.
        expect(r.execId).toBe("wf1:step1:7");
        expect(r.exitCode).toBe(2);
    });

    it("keeps the sandbox's own total when it already truncated", () => {
        const r = capExecStreams(baseResult({ stdout: "kept", stdoutTruncated: true, stdoutTotalBytes: 400_000_000 }));
        expect(r.stdoutTotalBytes).toBe(400_000_000);
    });

    it("never ends a cut stream in a replacement character", () => {
        // A cap landing mid-sequence would otherwise decode to U+FFFD.
        const snowmen = "☃".repeat(EXEC_STREAM_BYTE_CAP);
        const r = capExecStreams(baseResult({ stdout: snowmen }));
        expect(r.stdout.endsWith("�")).toBe(false);
        expect(Buffer.byteLength(r.stdout, "utf8")).toBeLessThanOrEqual(EXEC_STREAM_BYTE_CAP);
    });
});
