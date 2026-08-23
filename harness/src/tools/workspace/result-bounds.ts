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
 *
 * The same value is sent to the sandbox as a retention budget, so the bytes are
 * dropped at the producer and never cross the wire. Capping here as well is not
 * redundant: a sandbox image that pre-dates the budget returns the whole stream,
 * and this is the boundary that keeps it out of the process either way.
 */

import type { ExecResult } from "../../sandbox/types.js";

/** Per-stream cap. 32 KiB — roomy for real output, well under the loop result budget. */
export const EXEC_STREAM_BYTE_CAP = 32 * 1024;

export interface BoundedStream {
    readonly content: string;
    readonly truncated: boolean;
    readonly totalLength: number;
    readonly returnedBytes: number;
}

/**
 * Decode `buf` as UTF-8, dropping a trailing partial sequence rather than
 * letting it decode to U+FFFD. Only the last few bytes can be partial, so the
 * scan is bounded by the maximum UTF-8 sequence length.
 */
function trimPartialSequence(buf: Buffer): string {
    const MAX_UTF8_SEQUENCE = 4;
    for (let drop = 0; drop < MAX_UTF8_SEQUENCE && drop < buf.length; drop++) {
        const candidate = buf.subarray(0, buf.length - drop);
        const decoded = candidate.toString("utf8");
        if (!decoded.endsWith("�")) {
            return decoded;
        }
    }
    // A stream that genuinely ends in U+FFFD is returned as-is; dropping more
    // would start eating real characters.
    return buf.toString("utf8");
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
    // Slice the string before encoding. Encoding first allocates a Buffer the
    // size of the whole stream in order to keep `cap` bytes of it, which makes
    // the function that exists to bound a stream the largest allocation on the
    // path. One UTF-16 code unit encodes to at most 3 UTF-8 bytes, so `cap`
    // units always cover `cap` bytes and the encode stays bounded.
    const buf = Buffer.from(stream.slice(0, cap), "utf8").subarray(0, cap);
    // The byte cut can land mid-sequence, and decoding that directly ends the
    // content in U+FFFD. Trim back to the last whole character instead.
    const content = trimPartialSequence(buf);
    return {
        content,
        truncated: true,
        totalLength,
        returnedBytes: Buffer.byteLength(content, "utf8"),
    };
}

/**
 * Bound an `ExecResult`'s streams while keeping its shape.
 *
 * `boundExecResult` produces the tool-facing form; this is for the boundaries
 * that have to forward an `ExecResult` onward — notably a workflow return value,
 * which DBOS serializes into its durable step output. Returns the input
 * unchanged when nothing needed cutting, so the common path allocates nothing.
 */
export function capExecStreams(result: ExecResult, cap: number = EXEC_STREAM_BYTE_CAP): ExecResult {
    const out = boundStream(result.stdout, cap);
    const err = boundStream(result.stderr, cap);
    if (!out.truncated && !err.truncated) {
        return result;
    }
    return {
        ...result,
        stdout: out.content,
        stderr: err.content,
        stdoutTruncated: out.truncated || (result.stdoutTruncated ?? false),
        stderrTruncated: err.truncated || (result.stderrTruncated ?? false),
        stdoutTotalBytes: result.stdoutTotalBytes ?? out.totalLength,
        stderrTotalBytes: result.stderrTotalBytes ?? err.totalLength,
    };
}

/**
 * Apply per-stream truncation to an `ExecResult`. `exitCode`, `durationMs`,
 * `timedOut`, and `syntheticFailure` pass through unchanged regardless of
 * stream truncation — the discriminants the loop and the model rely on are
 * preserved.
 *
 * When the sandbox already truncated at the producer, what arrives here is the
 * retained slice, not the stream — so its length is the wrong number to report.
 * The sandbox's own totals win where present, and truncation is the union of the
 * two cuts: either side having dropped bytes makes the result truncated.
 */
export function boundExecResult(result: ExecResult, cap: number = EXEC_STREAM_BYTE_CAP): BoundedExecResult {
    const outStream = boundStream(result.stdout, cap);
    const errStream = boundStream(result.stderr, cap);
    return {
        execId: result.execId,
        exitCode: result.exitCode,
        stdout: outStream.content,
        stderr: errStream.content,
        stdoutTruncated: outStream.truncated || (result.stdoutTruncated ?? false),
        stderrTruncated: errStream.truncated || (result.stderrTruncated ?? false),
        stdoutTotalLength: result.stdoutTotalBytes ?? outStream.totalLength,
        stderrTotalLength: result.stderrTotalBytes ?? errStream.totalLength,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        ...(result.syntheticFailure ? { syntheticFailure: result.syntheticFailure } : {}),
    };
}
