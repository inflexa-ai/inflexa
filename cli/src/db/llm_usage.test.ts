import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { freshDb } from "../test_support/db.ts";
import { deleteAnalysis, insertAnalysis, insertAnchor, upsertLlmUsage, type LlmUsageEntry } from "./primary_mutation.ts";
import {
    getAnalysisUnattributedUsageTotals,
    getAnalysisUsageTotals,
    listAnalysisUsageByAgent,
    listAnalysisUsageByModel,
    listAnalysisUsageByRun,
    listAnalysisUsageBySession,
    listRunUsageByStep,
    type LlmUsageTotals,
} from "./primary_query.ts";
import { asStr256 } from "../lib/types.ts";

// freshDb() hands back the same singleton connection the mutation/query functions drive internally, so
// writes go through the real storage layer and the raw column reads below observe exactly what landed.
// The raw reads matter here: the ledger's whole discipline is NULL-vs-0, and a mapped read cannot prove
// which of the two is in the column.
let conn: Database;

beforeEach(() => {
    conn = freshDb();
});

/** A minimal well-formed ledger entry. Chat-shaped by default: an analysis scope with a thread, no run frame. */
function entry(overrides: Partial<LlmUsageEntry> = {}): LlmUsageEntry {
    return {
        recordKey: "rec-1",
        recordedAt: 1_000,
        agentId: "orchestrator",
        callPath: "orchestrator",
        scopeKind: "analysis",
        scopeId: "ana-1",
        threadId: "thr-1",
        usage: { inputTokens: 100, outputTokens: 20 },
        ...overrides,
    };
}

type TokenColumns = {
    input_tokens: number | null;
    output_tokens: number | null;
    cache_creation_input_tokens: number | null;
    cache_read_input_tokens: number | null;
    reasoning_tokens: number | null;
};

function tokenColumns(recordKey: string): TokenColumns | null {
    return conn
        .query<TokenColumns, [string]>(
            "SELECT input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, reasoning_tokens FROM llm_usage WHERE record_key = ?",
        )
        .get(recordKey);
}

function rowCount(): number {
    return conn.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM llm_usage").get()?.n ?? 0;
}

describe("upsertLlmUsage", () => {
    test("a re-delivered key updates in place rather than inserting a second row", () => {
        // The harness guarantees key stability, not at-most-once delivery: a replayed durable workflow
        // body re-fires record() with a byte-identical key. Two rows here would double-count the call.
        upsertLlmUsage(entry())._unsafeUnwrap();
        upsertLlmUsage(entry())._unsafeUnwrap();

        expect(rowCount()).toBe(1);
        expect(getAnalysisUsageTotals("ana-1")._unsafeUnwrap()).toEqual({ calls: 1, inputTokens: 100, outputTokens: 20 });
    });

    test("re-delivery keeps the first observation's time while refreshing the figures", () => {
        upsertLlmUsage(entry({ recordedAt: 1_000, servedModelId: "sonnet-a", usage: { inputTokens: 100, outputTokens: 20 } }))._unsafeUnwrap();
        upsertLlmUsage(entry({ recordedAt: 9_000, servedModelId: "sonnet-b", usage: { inputTokens: 140, outputTokens: 35 } }))._unsafeUnwrap();

        const row = conn
            .query<{ recorded_at: number; served_model_id: string | null }, [string]>("SELECT recorded_at, served_model_id FROM llm_usage WHERE record_key = ?")
            .get("rec-1");
        // The time axis records when the work happened, not when a recovery re-delivered it; the figures
        // and the served model are the parts a genuine step retry can legitimately change.
        expect(row?.recorded_at).toBe(1_000);
        expect(row?.served_model_id).toBe("sonnet-b");
        expect(getAnalysisUsageTotals("ana-1")._unsafeUnwrap()).toEqual({ calls: 1, inputTokens: 140, outputTokens: 35 });
    });

    test("an unreported quantity is stored as NULL, and a reported zero is stored as 0", () => {
        upsertLlmUsage(entry({ recordKey: "rec-partial", usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0 } }))._unsafeUnwrap();

        expect(tokenColumns("rec-partial")).toEqual({
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: 0,
            reasoning_tokens: null,
        });
    });

    test("a record reporting nothing at all stores an all-NULL token row, not an all-zero one", () => {
        upsertLlmUsage(entry({ recordKey: "rec-silent", usage: {} }))._unsafeUnwrap();

        expect(tokenColumns("rec-silent")).toEqual({
            input_tokens: null,
            output_tokens: null,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            reasoning_tokens: null,
        });
        // The call still happened and is still counted — "no figures reported" is not "no usage".
        expect(getAnalysisUsageTotals("ana-1")._unsafeUnwrap()).toEqual({ calls: 1 });
    });

    test("a record whose scope id matches no analysis persists without error", () => {
        // Scope ids are minted harness-side and include synthetic workloads this database never held
        // (the embedding boot probe runs an agent loop under an invented analysis id). There is no
        // foreign key precisely so this cannot fail — the recorder is forbidden to throw.
        expect(upsertLlmUsage(entry({ recordKey: "rec-probe", scopeId: "embedding-boot-probe" })).isOk()).toBe(true);
        expect(getAnalysisUsageTotals("embedding-boot-probe")._unsafeUnwrap().calls).toBe(1);
    });

    test("the other scope variant is stored without being mistaken for an analysis", () => {
        // threadId is dropped: it rides the analysis variant only, and the fixture must not imply a
        // field the target-assessment scope has no place to carry.
        upsertLlmUsage(entry({ recordKey: "rec-ta", scopeKind: "target-assessment", scopeId: "ta-1", threadId: undefined }))._unsafeUnwrap();

        expect(rowCount()).toBe(1);
        // Same id space, different variant: the discriminant is what keeps the two apart.
        expect(getAnalysisUsageTotals("ta-1")._unsafeUnwrap()).toEqual({ calls: 0 });
    });
});

describe("reading the ledger", () => {
    test("an analysis with no recorded calls reads back as zero calls with every quantity absent", () => {
        // Absent rather than zeroed: the caller distinguishes "nothing recorded" by `calls`, never by
        // reading a 0 that no provider ever reported.
        expect(getAnalysisUsageTotals("ana-nothing")._unsafeUnwrap()).toEqual({ calls: 0 });
    });

    test("a quantity no row reported sums to absent, not to zero", () => {
        upsertLlmUsage(entry({ recordKey: "rec-a", usage: { inputTokens: 100, outputTokens: 20 } }))._unsafeUnwrap();
        upsertLlmUsage(entry({ recordKey: "rec-b", usage: { inputTokens: 50, outputTokens: 5 } }))._unsafeUnwrap();

        const totals = getAnalysisUsageTotals("ana-1")._unsafeUnwrap();
        expect(totals).toEqual({ calls: 2, inputTokens: 150, outputTokens: 25 });
        expect("cacheReadInputTokens" in totals).toBe(false);
    });

    test("a cache-read count is a breakdown of the input count, never added to it", () => {
        upsertLlmUsage(
            entry({ recordKey: "rec-cached", usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 90, reasoningTokens: 8 } }),
        )._unsafeUnwrap();

        // inputTokens is the reported total billed prefix, cache reads included — 190 would be the same
        // prefix counted twice, and 128 would be reasoning counted twice on top of that.
        expect(getAnalysisUsageTotals("ana-1")._unsafeUnwrap()).toEqual({
            calls: 1,
            inputTokens: 100,
            outputTokens: 20,
            cacheReadInputTokens: 90,
            reasoningTokens: 8,
        });
    });

    test("the per-model and per-agent breakdowns each reconcile with the analysis's figures", () => {
        upsertLlmUsage(
            entry({ recordKey: "r1", agentId: "orchestrator", servedModelId: "opus", usage: { inputTokens: 100, outputTokens: 10 } }),
        )._unsafeUnwrap();
        upsertLlmUsage(
            entry({ recordKey: "r2", agentId: "orchestrator", servedModelId: "haiku", usage: { inputTokens: 30, outputTokens: 4 } }),
        )._unsafeUnwrap();
        upsertLlmUsage(
            entry({
                recordKey: "r3",
                agentId: "planner",
                callPath: "orchestrator/planner",
                servedModelId: "haiku",
                usage: { inputTokens: 70, outputTokens: 6 },
            }),
        )._unsafeUnwrap();

        expect(getAnalysisUsageTotals("ana-1")._unsafeUnwrap()).toEqual({ calls: 3, inputTokens: 200, outputTokens: 20 });
        expect(listAnalysisUsageByModel("ana-1")._unsafeUnwrap()).toEqual([
            { servedModelId: "haiku", totals: { calls: 2, inputTokens: 100, outputTokens: 10 } },
            { servedModelId: "opus", totals: { calls: 1, inputTokens: 100, outputTokens: 10 } },
        ]);
        expect(listAnalysisUsageByAgent("ana-1")._unsafeUnwrap()).toEqual([
            { agentId: "orchestrator", totals: { calls: 2, inputTokens: 130, outputTokens: 14 } },
            { agentId: "planner", totals: { calls: 1, inputTokens: 70, outputTokens: 6 } },
        ]);
    });

    test("calls whose endpoint reported no served model group under a null key", () => {
        upsertLlmUsage(entry({ recordKey: "r1", requestedModelId: "sonnet", usage: { inputTokens: 10 } }))._unsafeUnwrap();

        expect(listAnalysisUsageByModel("ana-1")._unsafeUnwrap()).toEqual([{ servedModelId: null, totals: { calls: 1, inputTokens: 10 } }]);
    });
});

describe("the where-it-ran grains", () => {
    // Chat-shaped rows carry a thread; run-shaped rows carry a run (and a step inside one); a row with
    // neither is the background/boot-time work the unattributed bucket exists for. `entry`'s default
    // threadId is dropped wherever it would contradict the frame under test.
    function chat(recordKey: string, threadId: string, usage: LlmUsageEntry["usage"]): void {
        upsertLlmUsage(entry({ recordKey, threadId, usage }))._unsafeUnwrap();
    }
    function runCall(recordKey: string, runId: string, stepId: string | undefined, usage: LlmUsageEntry["usage"]): void {
        upsertLlmUsage(entry({ recordKey, threadId: undefined, runId, stepId, usage }))._unsafeUnwrap();
    }
    function loose(recordKey: string, usage: LlmUsageEntry["usage"]): void {
        upsertLlmUsage(entry({ recordKey, threadId: undefined, usage }))._unsafeUnwrap();
    }

    test("an analysis's threads are reported as separate session groups", () => {
        chat("c1", "thr-a", { inputTokens: 100, outputTokens: 10 });
        chat("c2", "thr-a", { inputTokens: 50, outputTokens: 5 });
        chat("c3", "thr-b", { inputTokens: 20, outputTokens: 2 });

        expect(listAnalysisUsageBySession("ana-1")._unsafeUnwrap()).toEqual([
            { threadId: "thr-a", totals: { calls: 2, inputTokens: 150, outputTokens: 15 } },
            { threadId: "thr-b", totals: { calls: 1, inputTokens: 20, outputTokens: 2 } },
        ]);
    });

    test("a chat-only analysis yields sessions and no runs", () => {
        chat("c1", "thr-a", { inputTokens: 100 });

        expect(listAnalysisUsageBySession("ana-1")._unsafeUnwrap()).toHaveLength(1);
        expect(listAnalysisUsageByRun("ana-1")._unsafeUnwrap()).toEqual([]);
    });

    test("a run launched from a chat is counted under the run, never also under its session", () => {
        chat("c1", "thr-a", { inputTokens: 100, outputTokens: 10 });
        // The recorder writes a run frame without a thread; the session read excludes run rows anyway,
        // so a row carrying BOTH still reports once — under the frame it actually ran in.
        upsertLlmUsage(entry({ recordKey: "r1", threadId: "thr-a", runId: "run-1", usage: { inputTokens: 900, outputTokens: 90 } }))._unsafeUnwrap();

        expect(listAnalysisUsageBySession("ana-1")._unsafeUnwrap()).toEqual([{ threadId: "thr-a", totals: { calls: 1, inputTokens: 100, outputTokens: 10 } }]);
        expect(listAnalysisUsageByRun("ana-1")._unsafeUnwrap()).toEqual([{ runId: "run-1", totals: { calls: 1, inputTokens: 900, outputTokens: 90 } }]);
    });

    test("rows are ordered by input then output then calls — never by a constructed total", () => {
        // `small` reports the larger OUTPUT and more calls, and its input+cacheRead would beat `big`'s
        // input; only the input-led lexicographic order the design pins puts `big` first.
        runCall("r1", "run-big", undefined, { inputTokens: 500, outputTokens: 1 });
        runCall("r2", "run-small", undefined, { inputTokens: 400, outputTokens: 900, cacheReadInputTokens: 300 });
        runCall("r3", "run-small", undefined, { inputTokens: 0, outputTokens: 0 });

        expect(
            listAnalysisUsageByRun("ana-1")
                ._unsafeUnwrap()
                .map((g) => g.runId),
        ).toEqual(["run-big", "run-small"]);
    });

    test("a group whose provider reported nothing keeps its call count and reads back absent, sorted last", () => {
        runCall("r1", "run-silent", undefined, {});
        runCall("r2", "run-silent", undefined, {});
        runCall("r3", "run-loud", undefined, { inputTokens: 5, outputTokens: 1 });

        const groups = listAnalysisUsageByRun("ana-1")._unsafeUnwrap();
        expect(groups).toEqual([
            { runId: "run-loud", totals: { calls: 1, inputTokens: 5, outputTokens: 1 } },
            // Two calls happened and are counted; every figure is an unknown, not a zero.
            { runId: "run-silent", totals: { calls: 2 } },
        ]);
        expect("inputTokens" in groups[1]!.totals).toBe(false);
    });

    test("a run's step grain excludes another run's steps", () => {
        runCall("r1", "run-1", "s1_load", { inputTokens: 100, outputTokens: 10 });
        runCall("r2", "run-1", "s2_align", { inputTokens: 60, outputTokens: 6 });
        runCall("r3", "run-1", "s2_align", { inputTokens: 40, outputTokens: 4 });
        // Same step SLUG under a different run — plan step ids are unique only within their plan, so
        // this is exactly the leak the run predicate exists to stop.
        runCall("r4", "run-2", "s2_align", { inputTokens: 7_000, outputTokens: 700 });

        // The two steps tie on both figures, so the call count breaks it — the third and last key.
        expect(listRunUsageByStep("ana-1", "run-1")._unsafeUnwrap()).toEqual([
            { stepId: "s2_align", totals: { calls: 2, inputTokens: 100, outputTokens: 10 } },
            { stepId: "s1_load", totals: { calls: 1, inputTokens: 100, outputTokens: 10 } },
        ]);
    });

    test("a run's calls outside any step group under an absent step id", () => {
        runCall("r1", "run-1", undefined, { inputTokens: 30 });
        runCall("r2", "run-1", "s1_load", { inputTokens: 10 });

        expect(listRunUsageByStep("ana-1", "run-1")._unsafeUnwrap()).toEqual([
            { stepId: null, totals: { calls: 1, inputTokens: 30 } },
            { stepId: "s1_load", totals: { calls: 1, inputTokens: 10 } },
        ]);
    });

    test("calls carrying neither a thread nor a run are reported, not dropped", () => {
        loose("b1", { inputTokens: 400, outputTokens: 40 });

        expect(listAnalysisUsageBySession("ana-1")._unsafeUnwrap()).toEqual([]);
        expect(listAnalysisUsageByRun("ana-1")._unsafeUnwrap()).toEqual([]);
        expect(getAnalysisUnattributedUsageTotals("ana-1")._unsafeUnwrap()).toEqual({ calls: 1, inputTokens: 400, outputTokens: 40 });
    });

    test("an analysis with nothing unattributed reads back as zero calls with every quantity absent", () => {
        chat("c1", "thr-a", { inputTokens: 100 });

        expect(getAnalysisUnattributedUsageTotals("ana-1")._unsafeUnwrap()).toEqual({ calls: 0 });
    });

    test("every grain is scoped to its analysis and cannot see another's rows", () => {
        chat("c1", "thr-a", { inputTokens: 100 });
        runCall("r1", "run-1", "s1", { inputTokens: 200 });
        upsertLlmUsage(entry({ recordKey: "x1", scopeId: "ana-2", threadId: "thr-z", usage: { inputTokens: 999 } }))._unsafeUnwrap();
        upsertLlmUsage(entry({ recordKey: "x2", scopeId: "ana-2", threadId: undefined, runId: "run-1", usage: { inputTokens: 999 } }))._unsafeUnwrap();

        expect(listAnalysisUsageBySession("ana-1")._unsafeUnwrap()).toEqual([{ threadId: "thr-a", totals: { calls: 1, inputTokens: 100 } }]);
        expect(listAnalysisUsageByRun("ana-1")._unsafeUnwrap()).toEqual([{ runId: "run-1", totals: { calls: 1, inputTokens: 200 } }]);
        // Same run id under a sibling analysis: the scope predicate, not the run id, is what isolates it.
        expect(listRunUsageByStep("ana-1", "run-1")._unsafeUnwrap()).toEqual([{ stepId: "s1", totals: { calls: 1, inputTokens: 200 } }]);
    });

    test("the session, run, and unattributed figures sum per quantity to the analysis headline", () => {
        // A fixture carrying all three shapes at once — chat turns, a run with steps, and a call with
        // neither frame — because the partition only means anything when every bucket is populated.
        chat("c1", "thr-a", { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 60 });
        chat("c2", "thr-b", { inputTokens: 50, outputTokens: 5, reasoningTokens: 2 });
        runCall("r1", "run-1", "s1_load", { inputTokens: 300, outputTokens: 30, cacheCreationInputTokens: 12 });
        runCall("r2", "run-1", "s2_align", { inputTokens: 200, outputTokens: 20 });
        runCall("r3", "run-2", undefined, { inputTokens: 7, outputTokens: 1 });
        loose("b1", { inputTokens: 400, outputTokens: 40, reasoningTokens: 3 });

        const headline = getAnalysisUsageTotals("ana-1")._unsafeUnwrap();
        const parts: LlmUsageTotals[] = [
            ...listAnalysisUsageBySession("ana-1")
                ._unsafeUnwrap()
                .map((g) => g.totals),
            ...listAnalysisUsageByRun("ana-1")
                ._unsafeUnwrap()
                .map((g) => g.totals),
            getAnalysisUnattributedUsageTotals("ana-1")._unsafeUnwrap(),
        ];

        // Per quantity, never as one number: summing across quantities is the arithmetic every surface
        // here is forbidden to do, and a test that did it would be asserting the wrong property.
        const quantities = ["inputTokens", "outputTokens", "cacheCreationInputTokens", "cacheReadInputTokens", "reasoningTokens"] as const;
        for (const q of quantities) {
            const summed = parts.reduce((acc, p) => acc + (p[q] ?? 0), 0);
            expect({ [q]: summed }).toEqual({ [q]: headline[q] ?? 0 });
        }
        expect(parts.reduce((acc, p) => acc + p.calls, 0)).toBe(headline.calls);

        // And the run grain's steps reconcile with their own run, one level down.
        const runOne = listAnalysisUsageByRun("ana-1")
            ._unsafeUnwrap()
            .find((g) => g.runId === "run-1");
        const steps = listRunUsageByStep("ana-1", "run-1")._unsafeUnwrap();
        expect(steps.reduce((acc, s) => acc + (s.totals.inputTokens ?? 0), 0)).toBe(runOne?.totals.inputTokens ?? 0);
        expect(steps.reduce((acc, s) => acc + s.totals.calls, 0)).toBe(runOne?.totals.calls ?? 0);
    });
});

describe("usage rows outlive the analysis they attribute to", () => {
    // The ledger records tokens that were actually spent; deleting the local record of an analysis does
    // not un-spend them. There is no FK to cascade from, and adding one purely to enable a cascade would
    // reintroduce the failure mode the FK-less design exists to avoid.
    function seedAnalysis(id: string, slug: string): void {
        insertAnchor({ id: `anc-${id}`, createdAt: 1, updatedAt: 1, cachedPath: `/tmp/${id}`, markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis({
            id,
            createdAt: 1,
            updatedAt: 1,
            name: asStr256(id),
            slug,
            anchorId: `anc-${id}`,
            projectId: null,
        })._unsafeUnwrap();
    }

    test("deleting an analysis leaves its usage rows intact and readable", () => {
        seedAnalysis("ana-doomed", "doomed");
        upsertLlmUsage(entry({ recordKey: "rec-doomed", scopeId: "ana-doomed" }))._unsafeUnwrap();

        expect(deleteAnalysis("ana-doomed")._unsafeUnwrap()).toBe(1);

        expect(rowCount()).toBe(1);
        expect(getAnalysisUsageTotals("ana-doomed")._unsafeUnwrap()).toEqual({ calls: 1, inputTokens: 100, outputTokens: 20 });
    });

    test("an orphaned row contributes nothing to another analysis's report", () => {
        seedAnalysis("ana-live", "live");
        upsertLlmUsage(entry({ recordKey: "rec-orphan", scopeId: "ana-gone", agentId: "planner", servedModelId: "opus" }))._unsafeUnwrap();
        upsertLlmUsage(entry({ recordKey: "rec-live", scopeId: "ana-live", usage: { inputTokens: 7, outputTokens: 3 } }))._unsafeUnwrap();

        expect(getAnalysisUsageTotals("ana-live")._unsafeUnwrap()).toEqual({ calls: 1, inputTokens: 7, outputTokens: 3 });
        expect(listAnalysisUsageByModel("ana-live")._unsafeUnwrap()).toEqual([{ servedModelId: null, totals: { calls: 1, inputTokens: 7, outputTokens: 3 } }]);
        expect(listAnalysisUsageByAgent("ana-live")._unsafeUnwrap()).toEqual([
            { agentId: "orchestrator", totals: { calls: 1, inputTokens: 7, outputTokens: 3 } },
        ]);
        // The orphan is not lost — it is simply attributed to the scope id it names.
        expect(getAnalysisUsageTotals("ana-gone")._unsafeUnwrap().calls).toBe(1);
    });
});
