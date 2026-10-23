/**
 * The golden-fixture assertions of the SearXNG search-response contract.
 *
 * SearXNG has no public endpoint: the harness talks to the instance of the
 * embedder, thus the positive fixture is hand-built from the result classes of
 * `searx/results.py` and the JSON envelope of `searx/webapp.py`. It carries the
 * observed absence encodings of the provider: an explicit `null` content, an
 * omitted content, a `null` title, and an answer whose `answer` text is null.
 * The entry of the manifest is marked `replay: false`, because no fixture
 * refresh can ever reach a local instance that this machine does not run.
 *
 * The twin is the legacy answer form of SearXNG, a plain string in `answers`.
 * The engine set replaced it with answer objects, thus a regression to strings
 * is a genuine contract break, and the schema rejects it.
 */

import { describe, expect, it } from "bun:test";

import { mapSearxngResponse, SearxngSearchResponseSchema } from "../../../../research/searxng-engine.js";
import { fixtureCase, readFixture, runFixtureSuite } from "../../fixture-runner.js";

runFixtureSuite("searxng golden fixtures — the web search response", [
    fixtureCase({
        name: "SearxngSearchResponseSchema — a general search",
        provider: "searxng",
        fixture: "01-search-general.json",
        drift: "01-search-general.drift.json",
        schema: SearxngSearchResponseSchema,
        assertOutput: (response) => {
            const mapped = mapSearxngResponse(response);

            expect(mapped.results).toHaveLength(3);
            expect(mapped.results[0]).toEqual({
                title: "scanpy.tl.rank_genes_groups — scanpy 1.11.0 documentation",
                url: "https://scanpy.readthedocs.io/en/stable/api/scanpy.tl.rank_genes_groups.html",
                snippet: "Rank genes for characterizing groups. Expects logarithmized data.",
            });
            // A null content and an omitted content both give an absent snippet, and
            // the row of the null title drops, the absence policy of the mapper.
            expect(mapped.results[1]?.snippet).toBeUndefined();
            expect(mapped.results[2]?.snippet).toBeUndefined();
            expect(mapped.results.some((result) => result.url === "https://github.com/scverse/scanpy")).toBe(false);

            expect(mapped.answers).toEqual([
                {
                    answer: "Scanpy is a scalable Python toolkit for analyzing single-cell gene expression data.",
                    url: "https://en.wikipedia.org/wiki/Scanpy",
                },
                { url: "https://pypi.org/project/scanpy/" },
            ]);
        },
    }),
]);

describe("the searxng twin", () => {
    it("breaks the answer type against the positive fixture", () => {
        const positive = readFixture("searxng", "01-search-general.json") as { answers: unknown[] };
        const drift = readFixture("searxng", "01-search-general.drift.json") as { answers: unknown[] };

        expect(positive.answers.every((answer) => typeof answer === "object")).toBe(true);
        expect(drift.answers.every((answer) => typeof answer === "string")).toBe(true);
    });
});
