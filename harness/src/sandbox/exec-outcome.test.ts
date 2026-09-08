/**
 * The exec outcome vocabulary and the text-free summary the step-failure
 * record carries.
 */

import { describe, expect, test } from "bun:test";

import { lastExecOutcome, noteExecOutcome, sandboxExecOutcomeOf, summarizeExec } from "./exec-outcome.js";
import type { ExecResult } from "./types.js";

function execResult(over: Partial<ExecResult>): ExecResult {
    return { execId: "wf:step:1", exitCode: 0, stdout: "", stderr: "", durationMs: 10, timedOut: false, ...over };
}

describe("sandboxExecOutcomeOf", () => {
    test("a dead machine outranks the exit code and the timeout the kill left behind", () => {
        const outcomes = [
            sandboxExecOutcomeOf(execResult({})),
            sandboxExecOutcomeOf(execResult({ exitCode: 2 })),
            sandboxExecOutcomeOf(execResult({ exitCode: null })),
            sandboxExecOutcomeOf(execResult({ exitCode: 124, timedOut: true })),
            sandboxExecOutcomeOf(execResult({ exitCode: null, timedOut: true, syntheticFailure: { reason: "sandbox-dead" } })),
            sandboxExecOutcomeOf(execResult({ exitCode: 137, timedOut: true, syntheticFailure: { reason: "sandbox-oom-killed" } })),
        ];
        expect(outcomes).toEqual(["ok", "nonzero", "nonzero", "timeout", "synthetic-dead", "synthetic-oom"]);
    });
});

describe("summarizeExec", () => {
    test("gives the size of stderr and none of its text", () => {
        const summary = summarizeExec(execResult({ exitCode: 1, stderr: "Traceback: /srv/secrets/key.pem is unreadable" }));

        expect(summary).toEqual({ exitCode: 1, timedOut: false, stderrTotalBytes: 45 });
        expect(JSON.stringify(summary)).not.toContain("Traceback");
    });

    test("keeps the total the sandbox reported when it dropped output at the producer", () => {
        const summary = summarizeExec(execResult({ exitCode: 1, stderr: "kept slice", stderrTotalBytes: 9_000_000 }));

        expect(summary.stderrTotalBytes).toBe(9_000_000);
    });
});

describe("the last exec of a sandbox", () => {
    test("is the one the step body reads back, per sandbox", () => {
        noteExecOutcome("sbx-a", summarizeExec(execResult({ exitCode: 0 })));
        noteExecOutcome("sbx-a", summarizeExec(execResult({ exitCode: 3, stderr: "x" })));
        noteExecOutcome("sbx-b", summarizeExec(execResult({ exitCode: null, syntheticFailure: { reason: "sandbox-oom-killed" } })));

        expect(lastExecOutcome("sbx-a")).toEqual({ exitCode: 3, timedOut: false, stderrTotalBytes: 1 });
        expect(lastExecOutcome("sbx-b")).toEqual({ exitCode: null, timedOut: false, stderrTotalBytes: 0, syntheticFailureReason: "sandbox-oom-killed" });
        expect(lastExecOutcome("sbx-never-ran")).toBeUndefined();
    });
});
