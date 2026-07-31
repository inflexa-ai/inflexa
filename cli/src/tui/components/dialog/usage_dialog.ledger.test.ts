import { beforeEach, describe, expect, test } from "bun:test";

import { freshDb } from "../../../test_support/db.ts";
import { upsertLlmUsage, type LlmUsageEntry } from "../../../db/primary_mutation.ts";
import { readSessionUsage } from "./usage_dialog.tsx";

// The dialog's scoping, against a REAL ledger holding the shape a real analysis produces: a run
// stamped with the thread that launched it, a data profile carrying a run id and no thread, another
// conversation's turns, and background work carrying neither. `usage_dialog.test.ts` pins the
// composition arithmetic; this pins WHICH rows the composition is handed, which no pure test can.

const ANALYSIS = "an-1";
const THREAD = "019f0000-0000-0000-0000-00000000c2974";
const OTHER_THREAD = "019f1111-1111-1111-1111-11111111c2974";

function entry(over: Partial<LlmUsageEntry> & { recordKey: string }): LlmUsageEntry {
    return {
        recordedAt: 1_000,
        agentId: "conversation",
        callPath: "conversation",
        scopeKind: "analysis",
        scopeId: ANALYSIS,
        usage: {},
        ...over,
    };
}

beforeEach(() => {
    freshDb();
});

describe("readSessionUsage", () => {
    test("folds the runs the conversation launched into its headline, and says so by including them", () => {
        // The real ledger's proportions: the conversation's own turns are a rounding error beside the
        // run it started, which is why the dialog reports the inclusive reading rather than the grain.
        upsertLlmUsage(
            entry({ recordKey: "turn", threadId: THREAD, servedModelId: "claude-opus-4-8", usage: { inputTokens: 11_100, outputTokens: 2_900 } }),
        )._unsafeUnwrap();
        upsertLlmUsage(
            entry({
                recordKey: "run",
                threadId: THREAD,
                runId: "0182aaaa-bbbb-cccc-dddd-eeeeeeed70ae",
                agentId: "step-executor",
                servedModelId: "claude-sonnet-4-5",
                usage: { inputTokens: 809_200, outputTokens: 40_400 },
            }),
        )._unsafeUnwrap();

        const snap = readSessionUsage(ANALYSIS, THREAD)._unsafeUnwrap();

        expect(snap.totals).toEqual({ calls: 2, inputTokens: 820_300, outputTokens: 43_300 });
        // Two models and two agents, because the run's calls are this conversation's calls here.
        expect(snap.byModel.map((m) => m.servedModelId).sort()).toEqual(["claude-opus-4-8", "claude-sonnet-4-5"]);
        expect(snap.byAgent.map((a) => a.agentId).sort()).toEqual(["conversation", "step-executor"]);
    });

    test("another conversation's rows, and work carrying no thread at all, stay out of it", () => {
        upsertLlmUsage(entry({ recordKey: "mine", threadId: THREAD, usage: { inputTokens: 100 } }))._unsafeUnwrap();
        upsertLlmUsage(entry({ recordKey: "theirs", threadId: OTHER_THREAD, usage: { inputTokens: 5_000 } }))._unsafeUnwrap();
        // The data profile carries a run id and NO thread, so it belongs to no session even in
        // principle — it reports on its own section of the rail, never here.
        upsertLlmUsage(entry({ recordKey: "profile", runId: "data-profile", usage: { inputTokens: 55_500 } }))._unsafeUnwrap();
        // Background/boot-time work: neither frame.
        upsertLlmUsage(entry({ recordKey: "loose", usage: { inputTokens: 7 } }))._unsafeUnwrap();

        const snap = readSessionUsage(ANALYSIS, THREAD)._unsafeUnwrap();

        expect(snap.totals).toEqual({ calls: 1, inputTokens: 100 });
    });

    test("a quantity no call reported stays absent, never zero", () => {
        upsertLlmUsage(entry({ recordKey: "silent", threadId: THREAD, usage: { inputTokens: 10 } }))._unsafeUnwrap();

        const snap = readSessionUsage(ANALYSIS, THREAD)._unsafeUnwrap();

        expect(snap.totals.outputTokens).toBeUndefined();
        expect(snap.totals.cacheReadInputTokens).toBeUndefined();
        expect(snap.totals.reasoningTokens).toBeUndefined();
        expect(snap.byModel[0]?.totals.outputTokens).toBeUndefined();
    });

    test("a conversation the ledger has never seen answers zero calls rather than failing", () => {
        const snap = readSessionUsage(ANALYSIS, THREAD)._unsafeUnwrap();

        expect(snap.totals).toEqual({ calls: 0 });
        expect(snap.byModel).toEqual([]);
        expect(snap.byAgent).toEqual([]);
    });
});
