/**
 * The OTel metrics of `run_script`, exported through the global MeterProvider.
 *
 * They answer one question: does the light work of an agent fit the script VM, or does it want a sandbox?
 *
 *   - cortex.harness.script.runs — counter, one for each script, with `agent_id`, `outcome` (`ok` or `failed`), and
 *     `failure` (`none`, `script`, `memory`, `timeout`, `aborted`, or `sandbox`). A rise of `memory` and `timeout`
 *     says that scripts outgrow the VM.
 *   - cortex.harness.script.read_refusals — counter, one for each table read that a script tool refused, with
 *     `reason` (`too_large`, `unsupported_format`, or `unparsable`). A rise of `too_large` and `unsupported_format`
 *     says that the work wants the tables that only a sandbox reads.
 *   - cortex.harness.script.read_bytes — histogram of the bytes of each table or PDF that a script read, in buckets
 *     from 1 KiB up to the PDF read cap.
 *
 * A recovery replays the cached result of a script and runs no body, thus a replay never counts again. The
 * instruments are made on the first use, thus they bind to whatever provider the host registers.
 */

import { type Counter, type Histogram, metrics } from "@opentelemetry/api";

export type ScriptFailure = "none" | "script" | "memory" | "timeout" | "aborted" | "sandbox";

export type ReadRefusal = "too_large" | "unsupported_format" | "unparsable";

type Instruments = {
    readonly runs: Counter;
    readonly readRefusals: Counter;
    readonly readBytes: Histogram;
};

/**
 * Bucket bounds for the bytes of one read: 1 KiB to 64 MiB, a factor of 4 apart. The top bound is the PDF read cap,
 * thus the overflow bucket stays empty. Without them the default bounds stop at 10000, and each larger read lands in
 * the overflow bucket.
 */
export const SCRIPT_READ_BOUNDS_BYTES: readonly number[] = [1_024, 4_096, 16_384, 65_536, 262_144, 1_048_576, 4_194_304, 16_777_216, 67_108_864];

let instruments: Instruments | undefined;

function getInstruments(): Instruments {
    if (instruments === undefined) {
        const meter = metrics.getMeter("cortex.harness.script");
        instruments = {
            runs: meter.createCounter("cortex.harness.script.runs", { description: "Scripts that run_script ran" }),
            readRefusals: meter.createCounter("cortex.harness.script.read_refusals", { description: "Table reads of a script that a script tool refused" }),
            readBytes: meter.createHistogram("cortex.harness.script.read_bytes", {
                description: "Bytes of each table or PDF that a script read",
                unit: "By",
                advice: { explicitBucketBoundaries: [...SCRIPT_READ_BOUNDS_BYTES] },
            }),
        };
    }
    return instruments;
}

export function recordScriptRun(agentId: string, failure: ScriptFailure): void {
    getInstruments().runs.add(1, { agent_id: agentId, outcome: failure === "none" ? "ok" : "failed", failure });
}

export function recordReadRefusal(reason: ReadRefusal): void {
    getInstruments().readRefusals.add(1, { reason });
}

export function recordReadBytes(bytes: number): void {
    getInstruments().readBytes.record(bytes);
}

/** Drop the instruments, thus the next record binds to the provider that a test registered. */
export function __resetScriptMetricsForTest(): void {
    instruments = undefined;
}
