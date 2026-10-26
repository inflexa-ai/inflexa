import { describe, expect, it } from "bun:test";

import { countArtifactsByRuns, countRunsByAnalysis, queryArtifactOrigins, queryArtifactPage, readRunSynthesis } from "@inflexa-ai/harness";
import type { ArtifactExtensionCount, ArtifactOrigin, ArtifactPage, ArtifactPageEntry, ArtifactPageQuery, RunArtifactCount } from "@inflexa-ai/harness";

import * as runSynthesis from "../../execution/run-synthesis.js";
import * as stateBarrel from "../index.js";
import type { Querier } from "../db.js";

// An empty list sends no query, thus the read never touches the querier.
const unusedQuerier: Querier = {
    query() {
        throw new Error("not driven by this test");
    },
};

describe("the exports of the artifact reads", () => {
    it("reaches the reads from the package root, as the same functions of their modules", () => {
        expect(queryArtifactPage).toBe(stateBarrel.queryArtifactPage);
        expect(queryArtifactOrigins).toBe(stateBarrel.queryArtifactOrigins);
        expect(countArtifactsByRuns).toBe(stateBarrel.countArtifactsByRuns);
        expect(readRunSynthesis).toBe(runSynthesis.readRunSynthesis);
        expect(countRunsByAnalysis).toBe(stateBarrel.countRunsByAnalysis);
    });

    it("types the query, the page, and the counts from the package root", async () => {
        const query: ArtifactPageQuery = { sort: "recent", limit: 50, offset: 0, q: "volcano" };
        const entry: ArtifactPageEntry | undefined = undefined;
        const extensionCount: ArtifactExtensionCount | undefined = undefined;
        const page: ArtifactPage | undefined = undefined;
        const count: RunArtifactCount | undefined = (await countArtifactsByRuns(unusedQuerier, "a1", []))._unsafeUnwrap()[0];
        const origin: ArtifactOrigin | undefined = (await queryArtifactOrigins(unusedQuerier, "a1", []))._unsafeUnwrap()[0];

        expect([entry, extensionCount, page, count, origin]).toEqual([undefined, undefined, undefined, undefined, undefined]);
        expect(query.sort).toBe("recent");
    });
});
