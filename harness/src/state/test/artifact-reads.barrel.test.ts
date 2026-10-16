import { describe, expect, it } from "bun:test";

import { countArtifactsByRuns, queryArtifactPage, readRunSynthesis } from "@inflexa-ai/harness";
import type { ArtifactPage, ArtifactPageEntry, ArtifactPageQuery, RunArtifactCount } from "@inflexa-ai/harness";

import * as runSynthesis from "../../execution/run-synthesis.js";
import * as stateBarrel from "../index.js";
import { poolDouble } from "../../lib/test/doubles.js";

// An empty list sends no query, thus the read never touches the querier.
const unusedQuerier = poolDouble(() => Promise.reject(new Error("an empty id list sends no query")));

describe("the exports of the artifact reads", () => {
    it("reaches the reads from the package root, as the same functions of their modules", () => {
        expect(queryArtifactPage).toBe(stateBarrel.queryArtifactPage);
        expect(countArtifactsByRuns).toBe(stateBarrel.countArtifactsByRuns);
        expect(readRunSynthesis).toBe(runSynthesis.readRunSynthesis);
    });

    it("types the query, the page, and the counts from the package root", async () => {
        const query: ArtifactPageQuery = { sort: "recent", limit: 50, offset: 0, q: "volcano" };
        const entry: ArtifactPageEntry | undefined = undefined;
        const page: ArtifactPage | undefined = undefined;
        const count: RunArtifactCount | undefined = (await countArtifactsByRuns(unusedQuerier, "a1", []))._unsafeUnwrap()[0];

        expect([entry, page, count]).toEqual([undefined, undefined, undefined]);
        expect(query.sort).toBe("recent");
    });
});
