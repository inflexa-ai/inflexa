import type { UsageRecorder } from "./usage-recorder.js";

/**
 * Local/OSS usage recorder: drops every record. No ledger, no I/O — the
 * default an embedder that wires nothing gets. Runs behave exactly as they did
 * before the seam existed.
 */
export function createNoopUsageRecorder(): UsageRecorder {
    return {
        record: () => {},
    };
}
