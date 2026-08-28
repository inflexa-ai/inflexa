import { expect } from "bun:test";

import { fixtureCase, runFixtureSuite } from "../lib/__fixtures__/fixture-runner.js";
import { GeoEsearchResponseSchema, GeoEsummaryResponseSchema, mapGeoDatasets } from "./search-geo-datasets.js";

/** The uid order of the esummary fixture, as the esearch of the same query gave it. */
const SUMMARY_IDS = ["200305584", "200343535", "200337500", "200337499", "200322909"];

runFixtureSuite("NCBI GEO golden fixtures", [
    fixtureCase({
        name: "GeoEsearchResponseSchema",
        provider: "geo",
        fixture: "esearch_gse_breast_cancer.json",
        drift: "esearch_gse_breast_cancer.drift.json",
        schema: GeoEsearchResponseSchema,
        assertOutput: (res) => {
            // Each esearch scalar is a string, thus the count reaches the caller
            // only through a numeric read.
            expect(typeof res.esearchresult?.count).toBe("string");
            expect(Number(res.esearchresult?.count)).toBe(2343);
            expect(res.esearchresult?.idlist).toEqual(SUMMARY_IDS);
        },
    }),
    fixtureCase({
        name: "GeoEsummaryResponseSchema",
        provider: "geo",
        fixture: "esummary_gse_multi.json",
        drift: "esummary_gse_multi.drift.json",
        schema: GeoEsummaryResponseSchema,
        assertOutput: (res) => {
            const datasets = mapGeoDatasets(SUMMARY_IDS, res);
            expect(datasets.length).toBe(5);
            // `gpl` is the platform accession, as a bare number string. esummary
            // serves no `platform` key.
            expect(datasets[0]?.platform).toBe("20301");
            expect(datasets[0]?.accession).toBe("GSE305584");
            expect(datasets[0]?.organism).toBe("Homo sapiens");
        },
    }),
    fixtureCase({
        name: "GeoEsummaryResponseSchema, the 200-with-error record",
        provider: "geo",
        fixture: "esummary_invalid_uid.json",
        drift: "esummary_gse_multi.drift.json",
        schema: GeoEsummaryResponseSchema,
        assertOutput: (res) => {
            // esummary answers HTTP 200 for a uid that it does not hold, and it
            // puts an error record under that key. The record parses as a valid
            // summary, thus only the `error` key separates it from a dataset.
            expect(mapGeoDatasets(["999999999"], res)).toEqual([]);
        },
    }),
]);
