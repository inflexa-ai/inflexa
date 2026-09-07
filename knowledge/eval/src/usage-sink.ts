/**
 * The usage sink of the headless evaluation: the eval realization of the
 * harness `UsageRecorder` seam, and the fold that turns its file back into
 * the cost record of one attempt.
 *
 * The recorder appends one JSON line per completed LLM call to `usage.jsonl`
 * in the attempt directory. The seam contract binds the shape: `record` is
 * called bare from the agent loop, thus it never throws and never blocks. A
 * synchronous append to a local file is the whole realization, and a write
 * fault reaches stderr once and is then dropped.
 *
 * The harness guarantees a replay-stable `recordKey`, not at-most-once
 * delivery: a DBOS replay of a workflow body re-fires `record` with the same
 * key. Thus the file can hold one call several times, and the fold dedups by
 * key (last write wins) before it sums. The sum keeps the cache categories
 * apart from `inputTokens`: `inputTokens` is already the total billed prefix,
 * cached and uncached alike, so a fold that added the cache reads into it would
 * count them twice.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { LlmUsageRecord, TokenUsageRollup, UsageRecorder } from "@inflexa-ai/harness";

/** The token fields of one record, in the order the harness reports them. Absent stays absent, never zero. */
const TOKEN_FIELDS = ["inputTokens", "outputTokens", "cacheCreationInputTokens", "cacheReadInputTokens", "reasoningTokens"] as const;

/**
 * One append-only JSON-lines file whose target the runner can move between
 * attempts without a reboot: the harness runtime boots once per process, and
 * every attempt owns its own `usage.jsonl` and `calls.jsonl`.
 */
export interface JsonlSink {
    /** The current target file. */
    readonly path: string;
    /** Point the sink at another file; the parent directory is made on the first append. */
    retarget(path: string): void;
    /** Append one line. Never throws: a fault is reported to stderr once per target and then dropped. */
    append(line: unknown): void;
}

export function createJsonlSink(initialPath: string): JsonlSink {
    let path = initialPath;
    let prepared = false;
    let faulted = false;
    return {
        get path() {
            return path;
        },
        retarget(next: string): void {
            path = next;
            prepared = false;
            faulted = false;
        },
        append(line: unknown): void {
            try {
                if (!prepared) {
                    mkdirSync(dirname(path), { recursive: true });
                    prepared = true;
                }
                appendFileSync(path, `${JSON.stringify(line)}\n`);
            } catch (cause) {
                if (!faulted) {
                    faulted = true;
                    console.error(`usage sink: append to ${path} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
                }
            }
        },
    };
}

/** The eval `UsageRecorder`, with its sink exposed so the runner can retarget it per attempt. */
export interface EvalUsageRecorder extends UsageRecorder {
    readonly sink: JsonlSink;
}

/** One line of `usage.jsonl`: the harness record plus the arrival time, which the harness does not stamp. */
export interface UsageLine extends LlmUsageRecord {
    readonly recordedAt: string;
}

/**
 * The eval realization of the `UsageRecorder` seam: every `LlmUsageRecord`
 * lands in `usage.jsonl` at `path` as one line. `record` never throws.
 */
export function createEvalUsageRecorder(path: string): EvalUsageRecorder {
    const sink = createJsonlSink(path);
    return {
        sink,
        record(record: LlmUsageRecord): void {
            try {
                const line: UsageLine = { ...record, recordedAt: new Date().toISOString() };
                sink.append(line);
            } catch {
                // The seam forbids a throw. `sink.append` already swallows; this guards the spread.
            }
        },
    };
}

/** The fold of one attempt's usage: per model role (agent id), per run step, and in total. */
export interface UsageFold {
    /** Keyed by `agentId`: `planner`, `data-profiler`, `bulk-transcriptomics-agent`, `run-synthesizer`, ... */
    readonly byRole: Record<string, TokenUsageRollup>;
    /** Keyed by `stepId`; only the records made inside a run step (the profile, the planner, and the synthesis carry none). */
    readonly byStep: Record<string, TokenUsageRollup>;
    readonly total: TokenUsageRollup;
    /** Distinct record keys after the dedup. */
    readonly records: number;
    /** Lines dropped by the dedup: the replays of an already-seen key. */
    readonly replayed: number;
}

function isUsageRecord(value: unknown): value is LlmUsageRecord {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Partial<LlmUsageRecord>;
    return typeof record.recordKey === "string" && typeof record.agentId === "string" && typeof record.usage === "object" && record.usage !== null;
}

/** Parse the lines of a `usage.jsonl` text; a line that does not parse or is not a record is skipped. */
export function parseUsageLines(text: string): LlmUsageRecord[] {
    const records: LlmUsageRecord[] = [];
    for (const line of text.split(/\r?\n/)) {
        if (line.trim().length === 0) continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            continue;
        }
        if (isUsageRecord(parsed)) records.push(parsed);
    }
    return records;
}

/** Read and parse one `usage.jsonl`; an absent file gives no records. */
export function readUsageFile(path: string): LlmUsageRecord[] {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch {
        return [];
    }
    return parseUsageLines(text);
}

/** Add one call's reported usage into a rollup: a reported field sums, an unreported field stays absent. */
function addUsage(total: Record<string, number>, usage: LlmUsageRecord["usage"]): void {
    for (const key of TOKEN_FIELDS) {
        const value = usage[key];
        if (typeof value === "number") total[key] = (total[key] ?? 0) + value;
    }
}

/**
 * Fold the records of one attempt. `lines` holds the records, or the raw
 * JSON lines, or a mix. Dedup by `recordKey` keeps the last write of a key,
 * then the sums run by `agentId`, by `stepId`, and in total. Each token field
 * sums on its own: the cache categories never enter `inputTokens`.
 */
export function foldUsage(lines: Iterable<LlmUsageRecord | string>): UsageFold {
    const byKey = new Map<string, LlmUsageRecord>();
    let replayed = 0;
    for (const line of lines) {
        const record = typeof line === "string" ? parseUsageLines(line)[0] : line;
        if (record === undefined) continue;
        if (byKey.has(record.recordKey)) replayed += 1;
        byKey.set(record.recordKey, record);
    }
    const byRole: Record<string, Record<string, number>> = {};
    const byStep: Record<string, Record<string, number>> = {};
    const total: Record<string, number> = {};
    for (const record of byKey.values()) {
        addUsage((byRole[record.agentId] ??= {}), record.usage);
        if (record.stepId !== undefined) addUsage((byStep[record.stepId] ??= {}), record.usage);
        addUsage(total, record.usage);
    }
    return { byRole, byStep, total, records: byKey.size, replayed };
}
