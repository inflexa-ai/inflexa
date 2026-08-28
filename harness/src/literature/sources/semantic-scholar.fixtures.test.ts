/**
 * The golden fixtures of the two Semantic Scholar contracts.
 *
 * Semantic Scholar sends every field that a request asks for, and it encodes an
 * absent value as an explicit null. The one exception is `venue`, whose absent
 * form is the empty string. The search fixture carries all four variants: a
 * complete paper, a null abstract, a null year, and an empty venue.
 *
 * `CorpusId` is a JSON integer on every observed paper, thus the value type of
 * `externalIds` admits a number and the map site gives it one text form.
 */

import { describe, expect, it } from "bun:test";

import { fixtureCase, readFixture, runFixtureSuite } from "../../tools/lib/__fixtures__/fixture-runner.js";
import {
    createSemanticScholarSource,
    ExactPaperSchema,
    parseSemanticScholarResponse,
    SearchResponseSchema,
    type SemanticScholarSource,
} from "./semantic-scholar.js";

runFixtureSuite("semantic scholar golden fixtures — the literature source", [
    fixtureCase({
        name: "SearchResponseSchema — a paper batch",
        provider: "semantic-scholar",
        fixture: "15-search-bulk.json",
        drift: "15-search-bulk.drift.json",
        schema: SearchResponseSchema,
        assertOutput: (response) => {
            const [complete, noYear, noAbstract, noVenue] = parseSemanticScholarResponse(response);

            expect(complete).toMatchObject({ year: 2023, venue: "Cytoskeleton" });
            expect(complete?.abstract).toBeDefined();
            // A null abstract and a null year drop out of the mapped paper.
            expect(noAbstract).not.toHaveProperty("abstract");
            expect(noYear).not.toHaveProperty("year");
            // An absent venue is the empty string on the wire, and it stays one.
            expect(noVenue?.venue).toBe("");
            expect(noVenue?.year).toBe(2022);
            // The wire serves the CorpusId as an integer, and the caller keys on text.
            expect(complete?.externalIds).toMatchObject({ CorpusId: "265032769", DOI: "10.1002/cm.21804" });
        },
    }),
    fixtureCase({
        name: "ExactPaperSchema — one paper by identifier",
        provider: "semantic-scholar",
        fixture: "07-paper-arxiv.json",
        drift: "07-paper-arxiv.drift.json",
        schema: ExactPaperSchema,
        assertOutput: (paper) => {
            expect(paper.paperId).toBe("204e3073870fae3d05bcbc2f6a8e263d9b72e776");
            expect(paper.title).toBe("Attention is All you Need");
            expect(paper.externalIds?.CorpusId).toBe(13756489);
        },
    }),
]);

/** A source whose every request answers with one fixture file. */
function sourceOver(file: string): SemanticScholarSource {
    const body = readFixture("semantic-scholar", file);
    return createSemanticScholarSource({ fetch: async () => Response.json(body) });
}

describe("the Semantic Scholar source over the golden fixtures", () => {
    it("maps an identifier lookup, and keeps the numeric CorpusId as a string", async () => {
        const result = await sourceOver("07-paper-arxiv.json").lookupIdentifier("ARXIV:1706.03762");

        expect(result).toMatchObject({
            status: "ok",
            value: { id: "204e3073870fae3d05bcbc2f6a8e263d9b72e776", title: "Attention is All you Need", year: 2017 },
        });
        const paper = result.status === "ok" ? result.value : undefined;
        expect(paper?.externalIds).toMatchObject({ CorpusId: "13756489", ArXiv: "1706.03762" });
        expect(paper?.authors[0]).toBe("Ashish Vaswani");
    });

    it("reports a contract break as unavailable, not as an empty answer", async () => {
        const search = await sourceOver("15-search-bulk.drift.json").search("mitochondria", 10);
        const exact = await sourceOver("07-paper-arxiv.drift.json").lookupIdentifier("ARXIV:1706.03762");

        expect(search).toMatchObject({ status: "unavailable" });
        expect(search.status === "unavailable" ? search.detail : "").toContain("response schema mismatch");
        expect(exact).toMatchObject({ status: "unavailable" });
    });
});
