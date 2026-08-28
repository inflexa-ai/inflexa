/**
 * Golden fixtures of the DisGeNET v1 API.
 *
 * `v1-public-version.json` is a live 200 from the one route that serves without
 * a key, thus it proves the envelope. No live GDA body exists: every data route
 * demands a key. `gda-summary.synthetic.json` therefore carries no manifest
 * entry, and its shape comes from `GeneDiseaseAssocSummaryDTO`, `Paging`, and
 * `Response«List«GeneDiseaseAssocSummaryDTO»»` of the public Swagger.
 */

import { describe, expect, it } from "bun:test";

import { fixtureCase, readFixture, runFixtureSuite } from "./__fixtures__/fixture-runner.js";
import { GdaResponseSchema } from "./disgenet-client.js";

runFixtureSuite("DisGeNET golden fixtures", [
    fixtureCase({
        name: "GdaResponseSchema",
        provider: "disgenet",
        fixture: "gda-summary.synthetic.json",
        drift: "gda-summary.synthetic.drift.json",
        schema: GdaResponseSchema,
        assertOutput: (envelope) => {
            expect(envelope.status).toBe("OK");
            // The count of the whole query rides in `paging`, not in the payload.
            expect(envelope.paging?.totalElements).toBe(137);
            expect(envelope.paging?.pageSize).toBe(100);
            expect(envelope.paging?.currentPageNumber).toBe(0);

            const records = envelope.payload ?? [];
            expect(records).toHaveLength(2);
            expect(records[0]).toMatchObject({
                geneSymbol: "PCSK9",
                geneId: 255738,
                diseaseName: "Hypercholesterolemia, Autosomal Dominant, 3",
                diseaseId: "C1858729",
                diseaseType: "disease",
                score: 0.9,
                evidenceIndex: 1,
                yearInitial: 2003,
                yearFinal: 2024,
                nPmids: 142,
            });
            // A record carries no `gene_name` and no record-level `source`.
            expect(Object.keys(records[0]!)).not.toContain("geneName");
            expect(Object.keys(records[0]!)).not.toContain("source");
        },
    }),
    fixtureCase({
        name: "GdaResponseSchema (a gated answer)",
        provider: "disgenet",
        fixture: "gda-summary-gated.synthetic.json",
        drift: "gda-summary.synthetic.drift.json",
        schema: GdaResponseSchema,
        assertOutput: (envelope) => {
            // A free academic key serves the curated sources only, thus a gated
            // answer is an expected empty outcome. The envelope still parses.
            expect(envelope.status).toBe("ERROR");
            expect(envelope.error?.message).toBe("Access denied");
            expect(envelope.payload).toBeUndefined();
        },
    }),
]);

describe("the DisGeNET envelope", () => {
    it("is the live shape of the one keyless route", () => {
        const body = readFixture("disgenet", "v1-public-version.json") as Record<string, unknown>;
        expect(Object.keys(body)).toEqual(["status", "payload", "httpStatus"]);
        expect(body.status).toBe("OK");
        expect(body.httpStatus).toBe(200);
    });

    it("carries the records inside payload, never as a bare array", () => {
        const body = readFixture("disgenet", "gda-summary.synthetic.json");
        expect(Array.isArray(body)).toBe(false);
    });
});
