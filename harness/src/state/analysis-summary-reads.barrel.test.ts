import { describe, expect, it } from "bun:test";

import { queryDataProfileStatusByAnalyses, queryLatestRunsByAnalyses } from "@inflexa-ai/harness";
import type { DataProfileSettlement, DataProfileSummary, LatestRunSummary, NotifyDataProfileSettled } from "@inflexa-ai/harness";

import * as stateBarrel from "./index.js";

// An empty list sends no query, thus the reads never touch the querier.
const unusedQuerier = {} as never;

describe("the exports of the grouped analysis reads", () => {
    it("reaches the two reads from the package root, as the same functions of the state barrel", () => {
        expect(queryLatestRunsByAnalyses).toBe(stateBarrel.queryLatestRunsByAnalyses);
        expect(queryDataProfileStatusByAnalyses).toBe(stateBarrel.queryDataProfileStatusByAnalyses);
    });

    it("types the entries and the settle notice from the package root", async () => {
        const run: LatestRunSummary | undefined = (await queryLatestRunsByAnalyses(unusedQuerier, []))._unsafeUnwrap()[0];
        const profile: DataProfileSummary | undefined = (await queryDataProfileStatusByAnalyses(unusedQuerier, []))._unsafeUnwrap()[0];
        const settlement: DataProfileSettlement = { analysisId: "a", status: "completed", completedAt: "2026-10-12T00:00:00.000Z" };
        const notify: NotifyDataProfileSettled | undefined = undefined;

        expect([run, profile, notify]).toEqual([undefined, undefined, undefined]);
        expect(settlement.status).toBe("completed");
    });
});
