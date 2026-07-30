import { describe, expect, test } from "bun:test";
import { err, ok, type Result } from "neverthrow";
import type { LlmUsageRecord, LogFields, Logger, Scope } from "@inflexa-ai/harness";

import type { DbError } from "../../db/errors.ts";
import type { LlmUsageEntry } from "../../db/primary_mutation.ts";
import { createUsageRecorder } from "./usage_recorder.ts";

/** One captured log record — level, message, and the structured fields, which is where the identifiers ride. */
type LogRecord = { level: "debug" | "info" | "warn" | "error"; msg: string; fields: LogFields };

/**
 * A capturing realization of the harness `Logger` seam. `named`/`with` return the same collector so a
 * namespaced child (which the recorder builds) still reports into the one list the test asserts on.
 */
function capturingLogger(): { logger: Logger; records: LogRecord[] } {
    const records: LogRecord[] = [];
    const emit =
        (level: LogRecord["level"]) =>
        (msg: string, fields?: LogFields): void => {
            records.push({ level, msg, fields: fields ?? {} });
        };
    const logger: Logger = {
        debug: emit("debug"),
        info: emit("info"),
        warn: emit("warn"),
        error: emit("error"),
        with: () => logger,
        named: () => logger,
        errorFields: (e) => ({ err: e }),
    };
    return { logger, records };
}

/**
 * A capturing ledger write. Passing a `DbError` makes every write fail, so the same rig drives the
 * happy and the failing path. The error is taken as a bare value rather than a ready-made `Err` so no
 * `Result` is ever constructed at a call site and left unconsumed there.
 */
function capturingUpsert(failure?: DbError): {
    upsert: (entry: LlmUsageEntry) => Result<void, DbError>;
    entries: LlmUsageEntry[];
} {
    const entries: LlmUsageEntry[] = [];
    return {
        upsert: (entry) => {
            entries.push(entry);
            return failure === undefined ? ok(undefined) : err(failure);
        },
        entries,
    };
}

/** A well-formed harness record. Chat-shaped by default: analysis scope with a thread, no run frame, both model ids reported. */
function record(overrides: Partial<LlmUsageRecord> = {}): LlmUsageRecord {
    return {
        recordKey: "rec-1",
        agentId: "planner",
        callPath: ["tui-chat", "planner"],
        scope: { kind: "analysis", analysisId: "ana-1", threadId: "thr-1" },
        requestedModelId: "asked-for",
        servedModelId: "answered-with",
        usage: { inputTokens: 100, outputTokens: 20 },
        ...overrides,
    };
}

describe("createUsageRecorder — the harness seam's two contract terms", () => {
    test("a failing write throws nothing, returns nothing, and reports at warn", () => {
        const { logger, records } = capturingLogger();
        const { upsert, entries } = capturingUpsert({ type: "mutation_failed", op: "upsertLlmUsage", cause: new Error("disk is gone") });
        const recorder = createUsageRecorder({ logger, upsert });

        // The agent loop delivers bare — no await, no try — so an escaping error here would fail a turn
        // that otherwise succeeded. The assertion is that the call is inert, not merely that it survives.
        const returned = recorder.record(record());

        expect(returned).toBeUndefined();
        expect(entries).toHaveLength(1);
        expect(records).toHaveLength(1);
        expect(records[0]?.level).toBe("warn");
        expect(records[0]?.fields).toMatchObject({ recordKey: "rec-1", error: "mutation_failed" });
    });

    test("a synchronous throw from the write is swallowed and reported, not propagated", () => {
        const { logger, records } = capturingLogger();
        const recorder = createUsageRecorder({
            logger,
            upsert: () => {
                throw new Error("bun:sqlite refused the bind");
            },
        });

        expect(() => recorder.record(record())).not.toThrow();
        expect(records).toHaveLength(1);
        expect(records[0]?.level).toBe("warn");
    });

    test("a successful write logs nothing — the ledger is silent on the hot path", () => {
        const { logger, records } = capturingLogger();
        const { upsert } = capturingUpsert();

        createUsageRecorder({ logger, upsert }).record(record());

        expect(records).toEqual([]);
    });
});

describe("createUsageRecorder — scope maps totally", () => {
    test("the analysis variant contributes its id and its thread", () => {
        const { logger } = capturingLogger();
        const { upsert, entries } = capturingUpsert();

        createUsageRecorder({ logger, upsert }).record(record({ scope: { kind: "analysis", analysisId: "ana-7", threadId: "thr-9" } }));

        expect(entries[0]).toMatchObject({ scopeKind: "analysis", scopeId: "ana-7", threadId: "thr-9" });
    });

    test("an analysis scope with no thread omits the column rather than defaulting it", () => {
        const { logger } = capturingLogger();
        const { upsert, entries } = capturingUpsert();

        createUsageRecorder({ logger, upsert }).record(record({ scope: { kind: "analysis", analysisId: "ana-7" } }));

        expect(entries[0]).toMatchObject({ scopeKind: "analysis", scopeId: "ana-7" });
        expect(Object.hasOwn(entries[0] ?? {}, "threadId")).toBe(false);
    });

    test("the target-assessment variant maps to its own id and carries no thread", () => {
        const { logger, records } = capturingLogger();
        const { upsert, entries } = capturingUpsert();
        // The cli launches no target assessment today. That is exactly why this case is pinned: a
        // variant the host does not currently produce is the one a mapping quietly drops.
        const scope: Scope = { kind: "target-assessment", targetAssessmentId: "ta-3", billingContextId: "bc-4" };

        createUsageRecorder({ logger, upsert }).record(record({ scope }));

        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ scopeKind: "target-assessment", scopeId: "ta-3" });
        expect(Object.hasOwn(entries[0] ?? {}, "threadId")).toBe(false);
        expect(records).toEqual([]);
    });
});

describe("createUsageRecorder — the row it builds", () => {
    test("stamps arrival time, joins the call path, and passes the reported quantities through", () => {
        const { logger } = capturingLogger();
        const { upsert, entries } = capturingUpsert();
        const before = Date.now();

        createUsageRecorder({ logger, upsert }).record(
            record({ callPath: ["tui-chat", "planner", "literature-reviewer"], usage: { inputTokens: 100, cacheReadInputTokens: 0 } }),
        );

        const entry = entries[0];
        expect(entry?.callPath).toBe("tui-chat>planner>literature-reviewer");
        expect(entry?.recordedAt).toBeGreaterThanOrEqual(before);
        expect(entry?.recordedAt).toBeLessThanOrEqual(Date.now());
        // A reported 0 is a measurement and must survive as one; the quantities the provider never
        // mentioned must stay off the object entirely so the storage layer binds them NULL.
        expect(entry?.usage).toEqual({ inputTokens: 100, cacheReadInputTokens: 0 });
    });

    test("omits every optional the record did not carry", () => {
        const { logger } = capturingLogger();
        const { upsert, entries } = capturingUpsert();

        createUsageRecorder({ logger, upsert }).record(
            record({ requestedModelId: undefined, servedModelId: undefined, scope: { kind: "analysis", analysisId: "ana-1" } }),
        );

        const entry = entries[0] ?? ({} as LlmUsageEntry);
        for (const key of ["threadId", "runId", "stepId", "requestedModelId", "servedModelId"]) {
            expect(Object.hasOwn(entry, key)).toBe(false);
        }
    });

    test("a run-framed record carries its run and step alongside the analysis", () => {
        const { logger } = capturingLogger();
        const { upsert, entries } = capturingUpsert();

        createUsageRecorder({ logger, upsert }).record(record({ runId: "run-1", stepId: "step-a" }));

        expect(entries[0]).toMatchObject({ scopeKind: "analysis", scopeId: "ana-1", runId: "run-1", stepId: "step-a" });
    });
});
