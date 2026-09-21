import { describe, expect, test } from "bun:test";
import { err, ok, type Result } from "neverthrow";
import type { LlmUsageRecord } from "@inflexa-ai/harness";

import type { DbError } from "../../db/errors.ts";
import type { LlmUsageEntry } from "../../db/primary_mutation.ts";
import { createUsageRecorder } from "./usage_recorder.ts";

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

describe("createUsageRecorder — the notice contract", () => {
    test("a failing write throws nothing and gives its reason as the err of the notice", async () => {
        const { upsert, entries } = capturingUpsert({ type: "mutation_failed", op: "upsertLlmUsage", cause: new Error("disk is gone") });
        const recorder = createUsageRecorder({ upsert });

        // The agent loop delivers the notice bare — no await, no try — so an escaping error here would
        // fail a turn that otherwise succeeded. The failure must come back as a value the harness logs.
        const reason = await recorder.record(record()).match(
            () => "no failure",
            (failure) => failure.reason,
        );

        expect(entries).toHaveLength(1);
        expect(reason).toContain("rec-1");
        expect(reason).toContain("mutation_failed");
    });

    test("a synchronous throw from the write comes back as the err of the notice, not a throw", async () => {
        const recorder = createUsageRecorder({
            upsert: () => {
                throw new Error("bun:sqlite refused the bind");
            },
        });

        const reason = await recorder.record(record()).match(
            () => "no failure",
            (failure) => failure.reason,
        );

        expect(reason).toContain("bun:sqlite refused the bind");
    });

    test("a successful write gives ok", async () => {
        const { upsert } = capturingUpsert();

        expect((await createUsageRecorder({ upsert }).record(record())).isOk()).toBe(true);
    });
});

describe("createUsageRecorder — scope maps totally", () => {
    test("the analysis variant contributes its id and its thread", async () => {
        const { upsert, entries } = capturingUpsert();

        expect((await createUsageRecorder({ upsert }).record(record({ scope: { kind: "analysis", analysisId: "ana-7", threadId: "thr-9" } }))).isOk()).toBe(
            true,
        );

        expect(entries[0]).toMatchObject({ scopeKind: "analysis", scopeId: "ana-7", threadId: "thr-9" });
    });

    test("an analysis scope with no thread omits the column rather than defaulting it", async () => {
        const { upsert, entries } = capturingUpsert();

        expect((await createUsageRecorder({ upsert }).record(record({ scope: { kind: "analysis", analysisId: "ana-7" } }))).isOk()).toBe(true);

        expect(entries[0]).toMatchObject({ scopeKind: "analysis", scopeId: "ana-7" });
        expect(Object.hasOwn(entries[0] ?? {}, "threadId")).toBe(false);
    });
});

describe("createUsageRecorder — the row it builds", () => {
    test("stamps arrival time, joins the call path, and passes the reported quantities through", async () => {
        const { upsert, entries } = capturingUpsert();
        const before = Date.now();

        const written = await createUsageRecorder({ upsert }).record(
            record({ callPath: ["tui-chat", "planner", "literature-reviewer"], usage: { inputTokens: 100, cacheReadInputTokens: 0 } }),
        );

        expect(written.isOk()).toBe(true);

        const entry = entries[0];
        expect(entry?.callPath).toBe("tui-chat>planner>literature-reviewer");
        expect(entry?.recordedAt).toBeGreaterThanOrEqual(before);
        expect(entry?.recordedAt).toBeLessThanOrEqual(Date.now());
        // A reported 0 is a measurement and must survive as one; the quantities the provider never
        // mentioned must stay off the object entirely so the storage layer binds them NULL.
        expect(entry?.usage).toEqual({ inputTokens: 100, cacheReadInputTokens: 0 });
    });

    test("omits every optional the record did not carry", async () => {
        const { upsert, entries } = capturingUpsert();

        const written = await createUsageRecorder({ upsert }).record(
            record({ requestedModelId: undefined, servedModelId: undefined, scope: { kind: "analysis", analysisId: "ana-1" } }),
        );

        expect(written.isOk()).toBe(true);

        const entry = entries[0] ?? ({} as LlmUsageEntry);
        for (const key of ["threadId", "runId", "stepId", "requestedModelId", "servedModelId"]) {
            expect(Object.hasOwn(entry, key)).toBe(false);
        }
    });

    test("a run-framed record carries its run and step alongside the analysis", async () => {
        const { upsert, entries } = capturingUpsert();

        expect((await createUsageRecorder({ upsert }).record(record({ runId: "run-1", stepId: "step-a" }))).isOk()).toBe(true);

        expect(entries[0]).toMatchObject({ scopeKind: "analysis", scopeId: "ana-1", runId: "run-1", stepId: "step-a" });
    });
});
