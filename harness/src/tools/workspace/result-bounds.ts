/**
 * Per-stream byte caps for sandbox `ExecResult`s. The mutate-surface tools
 * (`execute_command`, `write_file`, `edit_file`) all return a tool result
 * derived from one `ExecResult`; they share one cap so the truncation
 * shape is uniform across the surface and the cap can be tuned in one
 * place.
 *
 * The cap is well below the loop's overall result budget so a chatty
 * command cannot blow the context window even when stdout AND stderr both
 * cap out at the limit.
 */

import type { ExecResult } from "../../sandbox/types.js";

/** Per-stream cap. 8 KiB — multi-KB but well under the loop result budget. */
export const EXEC_STREAM_BYTE_CAP = 8 * 1024;

export interface BoundedStream {
    readonly content: string;
    readonly truncated: boolean;
    readonly totalLength: number;
    readonly returnedBytes: number;
}

export interface BoundedExecResult {
    readonly execId: string;
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly stdoutTruncated: boolean;
    readonly stderrTruncated: boolean;
    readonly stdoutTotalLength: number;
    readonly stderrTotalLength: number;
    readonly durationMs: number | null;
    readonly timedOut: boolean;
    readonly syntheticFailure?: { readonly reason: string };
}

function boundStream(stream: string, cap: number = EXEC_STREAM_BYTE_CAP): BoundedStream {
    const totalLength = Buffer.byteLength(stream, "utf8");
    if (totalLength <= cap) {
        return { content: stream, truncated: false, totalLength, returnedBytes: totalLength };
    }
    const buf = Buffer.from(stream, "utf8").subarray(0, cap);
    const content = buf.toString("utf8");
    return {
        content,
        truncated: true,
        totalLength,
        returnedBytes: Buffer.byteLength(content, "utf8"),
    };
}

/**
 * Apply per-stream truncation to an `ExecResult`. `exitCode`, `durationMs`,
 * `timedOut`, and `syntheticFailure` pass through unchanged regardless of
 * stream truncation — the discriminants the loop and the model rely on are
 * preserved.
 */
export function boundExecResult(result: ExecResult, cap: number = EXEC_STREAM_BYTE_CAP): BoundedExecResult {
    const outStream = boundStream(result.stdout, cap);
    const errStream = boundStream(result.stderr, cap);
    return {
        execId: result.execId,
        exitCode: result.exitCode,
        stdout: outStream.content,
        stderr: errStream.content,
        stdoutTruncated: outStream.truncated,
        stderrTruncated: errStream.truncated,
        stdoutTotalLength: outStream.totalLength,
        stderrTotalLength: errStream.totalLength,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        ...(result.syntheticFailure ? { syntheticFailure: result.syntheticFailure } : {}),
    };
}
