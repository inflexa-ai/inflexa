import { describe, expect, it } from "bun:test";

import { queryDataProfileStatusByAnalyses, queryLatestRunsByAnalyses, queryRunProgressByRuns, queryRunsEndedSince } from "@inflexa-ai/harness";
import type {
    DataProfileSettlement,
    DataProfileSummary,
    EndedRunSummary,
    LatestRunSummary,
    NotifyDataProfileSettled,
    RunProgressSummary,
    TerminalRunStatus,
} from "@inflexa-ai/harness";

import * as stateBarrel from "./index.js";

// An empty list sends no query, thus the reads never touch the querier.
const unusedQuerier = {} as never;

describe("the exports of the grouped analysis reads", () => {
    it("reaches the reads from the package root, as the same functions of the state barrel", () => {
        expect(queryLatestRunsByAnalyses).toBe(stateBarrel.queryLatestRunsByAnalyses);
        expect(queryDataProfileStatusByAnalyses).toBe(stateBarrel.queryDataProfileStatusByAnalyses);
        expect(queryRunProgressByRuns).toBe(stateBarrel.queryRunProgressByRuns);
        expect(queryRunsEndedSince).toBe(stateBarrel.queryRunsEndedSince);
    });

    it("types the entries and the settle notice from the package root", async () => {
        const run: LatestRunSummary | undefined = (await queryLatestRunsByAnalyses(unusedQuerier, []))._unsafeUnwrap()[0];
        const profile: DataProfileSummary | undefined = (await queryDataProfileStatusByAnalyses(unusedQuerier, []))._unsafeUnwrap()[0];
        const settlement: DataProfileSettlement = { analysisId: "a", status: "completed", completedAt: "2026-10-12T00:00:00.000Z" };
        const progress: RunProgressSummary | undefined = (await queryRunProgressByRuns(unusedQuerier, []))._unsafeUnwrap()[0];
        const ended: EndedRunSummary | undefined = undefined;
        const terminal: TerminalRunStatus = "canceled";
        const notify: NotifyDataProfileSettled | undefined = undefined;

        expect([run, profile, progress, ended, notify]).toEqual([undefined, undefined, undefined, undefined, undefined]);
        expect(terminal).toBe("canceled");
        expect(settlement.status).toBe("completed");
    });
});
