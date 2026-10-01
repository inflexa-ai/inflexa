/**
 * Golden fixtures of the Amass Data Platform API.
 *
 * Each body is a live answer of 2026-09-30, captured with a key. The manifest
 * records no key, thus `scripts/refresh-fixtures.ts` gets a 401 on each replay.
 * A drift twin keeps only a few document sections: it has to fail the parse, not
 * to repeat the payload.
 */

import { expect } from "bun:test";

import { fixtureCase, runFixtureSuite } from "./__fixtures__/fixture-runner.js";
import {
    AmassErrorEnvelopeSchema,
    AmassLookupResponseSchema,
    mapPatentRecord,
    mapPatentSummary,
    mapRegulatoryRecord,
    mapRegulatorySearchRow,
    MAX_MATCHED_SECTIONS,
    PatentRecordResponseSchema,
    PatentSearchResponseSchema,
    RegulatoryRecordResponseSchema,
    RegulatorySearchResponseSchema,
    RegulatorySectionResponseSchema,
} from "./amass-client.js";

runFixtureSuite("Amass golden fixtures", [
    fixtureCase({
        name: "RegulatorySearchResponseSchema",
        provider: "amass",
        fixture: "regulatory-search.json",
        drift: "regulatory-search.drift.json",
        schema: RegulatorySearchResponseSchema,
        assertOutput: (response) => {
            const rows = response.data.map(mapRegulatorySearchRow);
            expect(rows.map((row) => row.agency)).toEqual(["FDA", "FDA", "EMA"]);

            // The active Gleevec label matched 16 sections; the row keeps 5, grouped by source document.
            const gleevec = rows[0]!;
            expect(gleevec.matchedSectionCount).toBe(16);
            expect(gleevec.matchedDocuments.flatMap((group) => group.sections)).toHaveLength(MAX_MATCHED_SECTIONS);
            expect(gleevec.matchedDocuments).toHaveLength(4);
            expect(gleevec.matchedDocuments[0]!.docType).toBe("FDA_LABEL");
            expect(gleevec.matchedDocuments[0]!.sections).toHaveLength(2);
            expect(gleevec.matchedDocuments[0]!.sections[0]).not.toHaveProperty("sourceUrl");

            // An absent base value is an explicit null.
            expect(rows[1]!.therapeuticIndication).toBeNull();
        },
    }),
    fixtureCase({
        name: "RegulatoryRecordResponseSchema (FDA)",
        provider: "amass",
        fixture: "regulatory-record-fda.json",
        drift: "regulatory-record-fda.drift.json",
        schema: RegulatoryRecordResponseSchema,
        assertOutput: (response) => {
            const record = mapRegulatoryRecord(response.data);
            expect(record.fdaDetails?.applicationNumber).toBe("NDA021588");
            // Amass stores the two-segment product NDC.
            expect(record.fdaDetails?.ndc).toContain("0078-0401");
            expect(record.fdaDetails?.withdrawalDate).toBeNull();
            // An include field that the request did not ask for is an omitted key.
            expect(record.emaDetails).toBeNull();
            expect(record.sectionCount).toBe(120);
            expect(record.documents).toHaveLength(5);
            expect(record.documents.reduce((sum, group) => sum + group.sections.length, 0)).toBe(120);
        },
    }),
    fixtureCase({
        name: "RegulatoryRecordResponseSchema (EMA)",
        provider: "amass",
        fixture: "regulatory-record-ema.json",
        drift: "regulatory-record-ema.drift.json",
        schema: RegulatoryRecordResponseSchema,
        assertOutput: (response) => {
            const record = mapRegulatoryRecord(response.data);
            expect(record.agency).toBe("EMA");
            expect(record.emaDetails?.productNumber).toBe("EMEA/H/C/000406");
            // Asked for, but the record is not an FDA one: an explicit null.
            expect(record.fdaDetails).toBeNull();
        },
    }),
    fixtureCase({
        name: "RegulatorySectionResponseSchema",
        provider: "amass",
        fixture: "regulatory-section.json",
        drift: "regulatory-section.drift.json",
        schema: RegulatorySectionResponseSchema,
        assertOutput: (response) => {
            expect(response.data.docType).toBe("FDA_LABEL");
            expect(response.data.content).toHaveLength(5296);
        },
    }),
    fixtureCase({
        name: "AmassLookupResponseSchema (RegulatoryCore)",
        provider: "amass",
        fixture: "regulatory-lookup.json",
        drift: "regulatory-lookup.drift.json",
        schema: AmassLookupResponseSchema,
        assertOutput: (response) => {
            // The bare number and the package NDC miss in-band; the prefixed number resolves.
            expect(response.data[0]!.error?.code).toBe("NOT_FOUND");
            expect(response.data[0]!.amassIds).toBeUndefined();
            expect(response.data[1]!.amassIds).toEqual(["AMRC_MMqv8cAEmfYfgoetgm9HSnLBlQg"]);
            expect(response.data[2]!.error?.code).toBe("NOT_FOUND");
        },
    }),
    fixtureCase({
        name: "AmassErrorEnvelopeSchema",
        provider: "amass",
        fixture: "regulatory-not-found.json",
        drift: "regulatory-not-found.drift.json",
        schema: AmassErrorEnvelopeSchema,
        assertOutput: (envelope) => {
            expect(envelope.error.status).toBe(404);
            expect(envelope.error.code).toBe("NOT_FOUND");
        },
    }),
    fixtureCase({
        name: "PatentSearchResponseSchema",
        provider: "amass",
        fixture: "patent-search.json",
        drift: "patent-search.drift.json",
        schema: PatentSearchResponseSchema,
        assertOutput: (response) => {
            const patent = mapPatentSummary(response.data[0]!);
            expect(patent.publicationNumber).toBe("CN-103570677-A");
            expect(patent.grantDate).toBeNull();
            expect(patent.familyMemberCount).toBe(1);
            expect(patent).not.toHaveProperty("claims");
        },
    }),
    fixtureCase({
        name: "PatentRecordResponseSchema",
        provider: "amass",
        fixture: "patent-record.json",
        drift: "patent-record.drift.json",
        schema: PatentRecordResponseSchema,
        assertOutput: (response) => {
            const patent = mapPatentRecord(response.data);
            expect(patent.hasClaims).toBe(false);
            // Asked for, and the patent carries no claims text.
            expect(patent.claims).toBe("");
            expect(patent).not.toHaveProperty("description");
        },
    }),
    fixtureCase({
        name: "AmassLookupResponseSchema (PatentCore)",
        provider: "amass",
        fixture: "patent-lookup.json",
        drift: "patent-lookup.drift.json",
        schema: AmassLookupResponseSchema,
        assertOutput: (response) => {
            expect(response.data[0]!.amassIds).toEqual(["AMPC_EzkKarMF7cIFSt3SZg13CV1tr3M"]);
            // One application number, two publications.
            expect(response.data[1]!.amassIds).toHaveLength(2);
            expect(response.data[2]!.error?.code).toBe("NOT_FOUND");
        },
    }),
]);
