import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

// The harness's own value for the profile's synthetic run id. Imported here for the same reason the
// query layer imports it: a copy of the string would keep this suite green through a rename there,
// which is exactly the silent coupling the export exists to remove.
import { DATA_PROFILE_RUN_LITERAL } from "@inflexa-ai/harness/contracts/data-profile.js";

import { freshDb } from "../test_support/db.ts";
import { deleteAnalysis, insertAnalysis, insertAnchor, upsertLlmUsage, type LlmUsageEntry } from "./primary_mutation.ts";
import {
    getAnalysisDataProfileUsageTotals,
    getAnalysisUnattributedUsageTotals,
    getAnalysisUsageTotals,
    getRunUsageTotals,
    getSessionUsageTotalsIncludingRuns,
    listAnalysisUsageByAgent,
    listAnalysisUsageByModel,
    listAnalysisUsageByRun,
    listAnalysisUsageBySession,
    listRunUsageByStep,
    listSessionUsageByAgent,
    listSessionUsageByModel,
    listUsageTotalsByAnalysis,
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

    test("the session, run, data-profile, and unattributed figures sum per quantity to the analysis headline", () => {
        // A fixture carrying all four shapes at once — chat turns, a run with steps, the data profile,
        // and a call with neither frame — because the partition only means anything when every bucket
        // is populated. The profile is what makes this test load-bearing after its rows stopped
        // appearing among the runs: excluded there and reported nowhere, it would vanish from the
        // parts while still counting toward the headline, and this assertion is what catches that.
        chat("c1", "thr-a", { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 60 });
        chat("c2", "thr-b", { inputTokens: 50, outputTokens: 5, reasoningTokens: 2 });
        runCall("r1", "run-1", "s1_load", { inputTokens: 300, outputTokens: 30, cacheCreationInputTokens: 12 });
        runCall("r2", "run-1", "s2_align", { inputTokens: 200, outputTokens: 20 });
        runCall("r3", "run-2", undefined, { inputTokens: 7, outputTokens: 1 });
        runCall("p1", DATA_PROFILE_RUN_LITERAL, "profile", { inputTokens: 900, outputTokens: 90, cacheReadInputTokens: 500 });
        loose("b1", { inputTokens: 400, outputTokens: 40, reasoningTokens: 3 });

        const headline = getAnalysisUsageTotals("ana-1")._unsafeUnwrap();
        const parts: LlmUsageTotals[] = [
            ...listAnalysisUsageBySession("ana-1")
                ._unsafeUnwrap()
                .map((g) => g.totals),
            ...listAnalysisUsageByRun("ana-1")
                ._unsafeUnwrap()
                .map((g) => g.totals),
            getAnalysisDataProfileUsageTotals("ana-1")._unsafeUnwrap(),
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

// The shape a single real analysis actually produced, reproduced row for row. Every read added for
// the per-entity surfaces is asserted against it rather than against a fixture invented to suit them,
// because the two facts that make those reads necessary are properties of THIS shape: a run's calls
// carry the thread that launched them, and the data profile carries no thread at all.
describe("the real ledger's shape", () => {
    const THREAD = "019f1111-2222-7333-8444-5555555c2974";
    const RUN = "01821111-2222-7333-8444-55555555d70ae";

    // Figures spread across the calls that produced them rather than parked on one row: the reads
    // under test are aggregates, and a group of one proves nothing about summing.
    function spread(prefix: string, calls: number, input: number, output: number, frame: Partial<LlmUsageEntry>): void {
        for (let i = 0; i < calls; i++) {
            // The remainder rides the first row so the per-row shares sum EXACTLY to the group total.
            const share = (total: number): number => Math.floor(total / calls) + (i === 0 ? total % calls : 0);
            upsertLlmUsage(
                entry({ recordKey: `${prefix}-${i}`, threadId: undefined, ...frame, usage: { inputTokens: share(input), outputTokens: share(output) } }),
            )._unsafeUnwrap();
        }
    }

    beforeEach(() => {
        // The run: 47 calls, and stamped with the thread that launched it — the fact that makes "this
        // session" ambiguous by a factor of 74.
        spread("run", 47, 809_233, 40_431, { runId: RUN, threadId: THREAD, agentId: "planner", servedModelId: "opus-4" });
        // The data profile: no thread at all, so it belongs to no session and has one possible home.
        spread("prof", 4, 55_534, 3_195, { runId: DATA_PROFILE_RUN_LITERAL, agentId: "data-profiler", servedModelId: "haiku-4" });
        // The conversation's own turn.
        spread("chat", 1, 11_083, 2_863, { threadId: THREAD, agentId: "conversation", servedModelId: "opus-4" });
    });

    test("the data profile reports as its own grain and never among the runs", () => {
        expect(getAnalysisDataProfileUsageTotals("ana-1")._unsafeUnwrap()).toEqual({ calls: 4, inputTokens: 55_534, outputTokens: 3_195 });
        // The whole point of the exclusion: a row a reader cannot cross-reference against any run
        // listing no longer sits in the run table.
        expect(listAnalysisUsageByRun("ana-1")._unsafeUnwrap()).toEqual([{ runId: RUN, totals: { calls: 47, inputTokens: 809_233, outputTokens: 40_431 } }]);
    });

    test("one run's totals read back without pulling the whole run grouping", () => {
        expect(getRunUsageTotals("ana-1", RUN)._unsafeUnwrap()).toEqual({ calls: 47, inputTokens: 809_233, outputTokens: 40_431 });
        // A run this analysis never had is zero calls with every quantity absent — a legitimate answer,
        // not a miss, matching every other totals read here.
        expect(getRunUsageTotals("ana-1", "run-that-never-ran")._unsafeUnwrap()).toEqual({ calls: 0 });
    });

    test("the inclusive session totals exceed the session grain by exactly the run it launched", () => {
        const inclusive = getSessionUsageTotalsIncludingRuns("ana-1", THREAD)._unsafeUnwrap();
        const grain = listAnalysisUsageBySession("ana-1")
            ._unsafeUnwrap()
            .find((g) => g.threadId === THREAD)?.totals;
        const run = getRunUsageTotals("ana-1", RUN)._unsafeUnwrap();

        // The 74× gap the design names: the conversation's own turn against the run it started.
        expect(grain).toEqual({ calls: 1, inputTokens: 11_083, outputTokens: 2_863 });
        expect(inclusive).toEqual({ calls: 48, inputTokens: 820_316, outputTokens: 43_294 });

        // Neither read is wrong; they differ by the whole of the run and by nothing else. Asserted as a
        // difference rather than as two literals so a future fixture change cannot make both drift
        // together and leave the relationship untested.
        // Typed as the read's own shape so the expectation may carry an absent quantity: a partition
        // asserted only over quantities that happen to be present is not the assertion we want.
        const difference: LlmUsageTotals = {
            calls: inclusive.calls - (grain?.calls ?? 0),
            inputTokens: (inclusive.inputTokens ?? 0) - (grain?.inputTokens ?? 0),
            outputTokens: (inclusive.outputTokens ?? 0) - (grain?.outputTokens ?? 0),
        };
        expect(difference).toEqual({ calls: run.calls, inputTokens: run.inputTokens, outputTokens: run.outputTokens });
        // And the profile is in neither: it carries no thread, so no session can absorb it.
        expect(inclusive.inputTokens).not.toBe(820_316 + 55_534);
    });

    test("a session's model and agent groupings cover its runs and exclude the profile", () => {
        // Both the turn and the run it launched served on opus-4, so they fold into one group; the
        // profile's haiku-4 calls carry no thread and cannot appear.
        expect(listSessionUsageByModel("ana-1", THREAD)._unsafeUnwrap()).toEqual([
            { servedModelId: "opus-4", totals: { calls: 48, inputTokens: 820_316, outputTokens: 43_294 } },
        ]);
        // By agent is where the fold is visible: the run's planner loop reports under its own id rather
        // than under the conversation that started it.
        expect(listSessionUsageByAgent("ana-1", THREAD)._unsafeUnwrap()).toEqual([
            { agentId: "conversation", totals: { calls: 1, inputTokens: 11_083, outputTokens: 2_863 } },
            { agentId: "planner", totals: { calls: 47, inputTokens: 809_233, outputTokens: 40_431 } },
        ]);
    });

    test("a session's groupings cannot see another thread's or another analysis's rows", () => {
        spread("other", 1, 777, 77, { threadId: "thr-other", agentId: "conversation", servedModelId: "opus-4" });
        upsertLlmUsage(entry({ recordKey: "x1", scopeId: "ana-2", threadId: THREAD, usage: { inputTokens: 999 } }))._unsafeUnwrap();

        expect(getSessionUsageTotalsIncludingRuns("ana-1", THREAD)._unsafeUnwrap().inputTokens).toBe(820_316);
        expect(listSessionUsageByModel("ana-1", THREAD)._unsafeUnwrap()).toHaveLength(1);
        expect(getSessionUsageTotalsIncludingRuns("ana-1", "thr-never-opened")._unsafeUnwrap()).toEqual({ calls: 0 });
    });

    test("several analyses' totals come back from one read, keyed by analysis", () => {
        upsertLlmUsage(entry({ recordKey: "y1", scopeId: "ana-2", usage: { inputTokens: 500, outputTokens: 50 } }))._unsafeUnwrap();

        // A duplicate id and an analysis with no rows at all: the map is total over what was ASKED for,
        // so a picker draws every row it listed without a second lookup or a missing-key branch.
        const totals = listUsageTotalsByAnalysis(["ana-1", "ana-2", "ana-1", "ana-never"])._unsafeUnwrap();

        expect(totals.size).toBe(3);
        expect(totals.get("ana-1")).toEqual({ calls: 52, inputTokens: 875_850, outputTokens: 46_489 });
        expect(totals.get("ana-2")).toEqual({ calls: 1, inputTokens: 500, outputTokens: 50 });
        expect(totals.get("ana-never")).toEqual({ calls: 0 });
        // The batched answer is the per-analysis answer — a picker showing one figure and a detail
        // screen showing the other would be the failure this equality rules out.
        expect(totals.get("ana-1")).toEqual(getAnalysisUsageTotals("ana-1")._unsafeUnwrap());
        expect(totals.get("ana-never")).toEqual(getAnalysisUsageTotals("ana-never")._unsafeUnwrap());
    });

    test("an empty list of analyses answers with an empty map", () => {
        // `IN ()` is a syntax error in SQLite, so the short-circuit is what keeps a picker with nothing
        // to draw from failing rather than rendering nothing.
        expect(listUsageTotalsByAnalysis([])._unsafeUnwrap().size).toBe(0);
    });

    test("the grains still sum per quantity to the headline with the profile partitioned out", () => {
        const headline = getAnalysisUsageTotals("ana-1")._unsafeUnwrap();
        const parts: LlmUsageTotals[] = [
            ...listAnalysisUsageBySession("ana-1")
                ._unsafeUnwrap()
                .map((g) => g.totals),
            ...listAnalysisUsageByRun("ana-1")
                ._unsafeUnwrap()
                .map((g) => g.totals),
            getAnalysisDataProfileUsageTotals("ana-1")._unsafeUnwrap(),
            getAnalysisUnattributedUsageTotals("ana-1")._unsafeUnwrap(),
        ];

        // Per quantity, never as one number — summing across quantities is the arithmetic every
        // surface here is forbidden to do.
        const summed: LlmUsageTotals = {
            calls: parts.reduce((acc, p) => acc + p.calls, 0),
            inputTokens: parts.reduce((acc, p) => acc + (p.inputTokens ?? 0), 0),
            outputTokens: parts.reduce((acc, p) => acc + (p.outputTokens ?? 0), 0),
        };
        expect(summed).toEqual({ calls: headline.calls, inputTokens: headline.inputTokens, outputTokens: headline.outputTokens });
        // The inclusive session read is NOT a part of the partition — adding it would count the run
        // twice, which is the whole reason the grain read exists beside it.
        expect(getSessionUsageTotalsIncludingRuns("ana-1", THREAD)._unsafeUnwrap().calls).toBeGreaterThan(
            listAnalysisUsageBySession("ana-1")._unsafeUnwrap()[0]?.totals.calls ?? 0,
        );
    });
});

describe("absent means not reported, at every new read", () => {
    // One quantity reported and four never mentioned, across all three frames. Every read below must
    // carry the reported one and OMIT the other four — a `?? 0` anywhere in the query layer would make
    // each of these assertions fail on a key that should not exist.
    const THREAD = "thr-silent";
    const RUN = "run-silent";

    function absentKeys(totals: LlmUsageTotals): string[] {
        return (["outputTokens", "cacheCreationInputTokens", "cacheReadInputTokens", "reasoningTokens"] as const).filter((k) => !(k in totals));
    }

    beforeEach(() => {
        upsertLlmUsage(entry({ recordKey: "s-chat", threadId: THREAD, usage: { inputTokens: 10 } }))._unsafeUnwrap();
        upsertLlmUsage(entry({ recordKey: "s-run", threadId: THREAD, runId: RUN, usage: { inputTokens: 20 } }))._unsafeUnwrap();
        upsertLlmUsage(entry({ recordKey: "s-prof", threadId: undefined, runId: DATA_PROFILE_RUN_LITERAL, usage: { inputTokens: 30 } }))._unsafeUnwrap();
    });

    test("a quantity no row reported is missing from every new read, never zeroed", () => {
        const reads: [string, LlmUsageTotals][] = [
            ["data profile", getAnalysisDataProfileUsageTotals("ana-1")._unsafeUnwrap()],
            ["run totals", getRunUsageTotals("ana-1", RUN)._unsafeUnwrap()],
            ["session inclusive", getSessionUsageTotalsIncludingRuns("ana-1", THREAD)._unsafeUnwrap()],
            ["session by model", listSessionUsageByModel("ana-1", THREAD)._unsafeUnwrap()[0]!.totals],
            ["session by agent", listSessionUsageByAgent("ana-1", THREAD)._unsafeUnwrap()[0]!.totals],
            ["batched analysis totals", listUsageTotalsByAnalysis(["ana-1"])._unsafeUnwrap().get("ana-1")!],
        ];

        for (const [name, totals] of reads) {
            // Named in the assertion so a failure says WHICH read started reporting a zero.
            expect({ [name]: absentKeys(totals) }).toEqual({
                [name]: ["outputTokens", "cacheCreationInputTokens", "cacheReadInputTokens", "reasoningTokens"],
            });
            expect(totals.inputTokens).toBeGreaterThan(0);
        }
    });

    test("a group whose provider reported nothing keeps its calls and reports no figures at all", () => {
        upsertLlmUsage(entry({ recordKey: "q1", threadId: "thr-quiet", runId: "run-quiet", usage: {} }))._unsafeUnwrap();
        upsertLlmUsage(entry({ recordKey: "q2", threadId: "thr-quiet", runId: "run-quiet", usage: {} }))._unsafeUnwrap();

        // Two calls happened; every figure is an unknown. `calls` is the only thing that separates this
        // from an analysis that never ran anything, which is why it is never absent.
        expect(getRunUsageTotals("ana-1", "run-quiet")._unsafeUnwrap()).toEqual({ calls: 2 });
        expect(getSessionUsageTotalsIncludingRuns("ana-1", "thr-quiet")._unsafeUnwrap()).toEqual({ calls: 2 });
        expect(listSessionUsageByAgent("ana-1", "thr-quiet")._unsafeUnwrap()).toEqual([{ agentId: "orchestrator", totals: { calls: 2 } }]);
        expect(listUsageTotalsByAnalysis(["ana-1"])._unsafeUnwrap().get("ana-1")).not.toHaveProperty("outputTokens");
    });

    test("an analysis that never profiled reports zero profile calls rather than nothing at all", () => {
        // Same discipline as the unattributed read: a grain with no rows is still a report.
        expect(getAnalysisDataProfileUsageTotals("ana-never-profiled")._unsafeUnwrap()).toEqual({ calls: 0 });
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
