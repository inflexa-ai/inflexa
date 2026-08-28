/**
 * Golden fixtures of the EPA CompTox (CTX) API.
 *
 * The bodies are the recorded 200 answers inside `ctxR` 1.1.3, the R client of
 * the EPA, captured against this same base. A `*.synthetic.json` file has no
 * recorded body: the chemical of the recording carries no such record. Its shape
 * comes from the server source of the EPA and from the karate contract test that
 * the manifest of the audit names, thus it carries no manifest entry.
 */

import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { fixtureCase, readFixture, runFixtureSuite } from "./__fixtures__/fixture-runner.js";
import {
    CancerSchema,
    CtxChemicalSearchRowSchema,
    GenetoxSchema,
    RawChemicalDetailSchema,
    RawFunctionalUseRowSchema,
    RawHttkRowSchema,
    RawSeemPredictionSchema,
    ToxValSchema,
} from "./ctx-ops.js";

runFixtureSuite("CompTox golden fixtures", [
    fixtureCase({
        name: "CtxChemicalSearchRowSchema",
        provider: "comptox",
        fixture: "chemical-search-equal.json",
        drift: "chemical-search-equal.drift.json",
        schema: z.array(CtxChemicalSearchRowSchema),
        assertOutput: (rows) => {
            expect(rows[0]!.dtxsid).toBe("DTXSID7020182");
            expect(rows[0]!.casrn).toBe("80-05-7");
        },
    }),
    fixtureCase({
        name: "CtxChemicalSearchRowSchema (a row with no DTXSID)",
        provider: "comptox",
        fixture: "chemical-search-equal-dtxcid.synthetic.json",
        drift: "chemical-search-equal-dtxcid.synthetic.drift.json",
        schema: z.array(CtxChemicalSearchRowSchema),
        assertOutput: (rows) => {
            // A DTXCID match carries no substance identifier. The row parses,
            // and `resolveDtxsid` drops it.
            expect(rows[0]!.dtxsid).toBeNull();
            expect(rows.filter((row) => row.dtxsid)).toHaveLength(0);
        },
    }),
    fixtureCase({
        name: "GenetoxSchema",
        provider: "comptox",
        fixture: "genetox-summary.json",
        drift: "genetox-summary.drift.json",
        schema: z.array(GenetoxSchema),
        assertOutput: (rows) => {
            const row = rows[0]!;
            expect(row.genetoxCall).toBe("negative");
            expect(row.ames).toBe("negative");
            expect(row.micronucleus).toBe("negative");
            expect(row.reportsNegative).toBe(3);
            expect(row.reportsPositive).toBe(0);
            expect(row.reportsOther).toBe(0);
            expect(row.clowderDocId).toContain("clowder");
        },
    }),
    fixtureCase({
        name: "CancerSchema",
        provider: "comptox",
        fixture: "cancer-summary.synthetic.json",
        drift: "cancer-summary.synthetic.drift.json",
        schema: z.array(CancerSchema),
        assertOutput: (rows) => {
            const row = rows[0]!;
            expect(row.cancerCall).toBe("Group 2B: Possibly carcinogenic to humans");
            expect(row.exposureRoute).toBe("oral");
            expect(row.source).toBe("IARC");
        },
    }),
    fixtureCase({
        name: "RawChemicalDetailSchema",
        provider: "comptox",
        fixture: "chemical-detail.json",
        drift: "chemical-detail.drift.json",
        schema: RawChemicalDetailSchema,
        assertOutput: (detail) => {
            expect(detail.dtxsid).toBe("DTXSID7020182");
            expect(detail.monoisotopicMass).toBe(228.115029755);
            expect(detail.totalAssays).toBe(981);
            // The provider serves an explicit null for an absent value.
            expect(detail.pubchemCid).toBeNull();
        },
    }),
    fixtureCase({
        name: "RawSeemPredictionSchema",
        provider: "comptox",
        fixture: "seem-general.json",
        drift: "seem-general.drift.json",
        schema: z.array(RawSeemPredictionSchema),
        assertOutput: (rows) => {
            const row = rows[0]!;
            expect(row.productionVolume).toBe(2780000);
            // `probabilityPesticde` is the wire name. The corrected spelling is
            // served nowhere, thus the mapped output renames it.
            expect(row.probabilityPesticde).toBe(0);
            expect(row.probabilityDietary).toBe(1);
        },
    }),
    fixtureCase({
        name: "ToxValSchema",
        provider: "comptox",
        fixture: "toxval.json",
        drift: "toxval.drift.json",
        schema: z.array(ToxValSchema),
        assertOutput: (rows) => {
            expect(rows.length).toBeGreaterThan(0);
            expect(rows.some((row) => row.toxvalNumeric !== null)).toBe(true);
            expect(rows.every((row) => typeof row.toxvalType === "string")).toBe(true);
        },
    }),
    fixtureCase({
        name: "RawHttkRowSchema",
        provider: "comptox",
        fixture: "httk.json",
        drift: "httk.drift.json",
        schema: z.array(RawHttkRowSchema),
        assertOutput: (rows) => {
            expect(rows[0]!.parameter).toBe("Css");
            expect(rows[0]!.predicted).toBe(1.114);
        },
    }),
    fixtureCase({
        name: "RawFunctionalUseRowSchema",
        provider: "comptox",
        fixture: "functional-use.json",
        drift: "functional-use.drift.json",
        schema: z.array(RawFunctionalUseRowSchema),
        assertOutput: (rows) => {
            // An absent category is an explicit null, not an omitted key.
            expect(rows[0]!.functioncategory).toBeNull();
            expect(rows.some((row) => row.functioncategory)).toBe(true);
        },
    }),
]);

describe("the CompTox oracles and the corrected fields", () => {
    function oracleSchemas(domain: string): Record<string, { properties: Record<string, unknown> }> {
        const spec = readFixture("comptox", `openapi-${domain}.excerpt.json`) as {
            components: { schemas: Record<string, { properties: Record<string, unknown> }> };
        };
        return spec.components.schemas;
    }

    it("names the genotoxicity summary fields that the client now declares", () => {
        const props = Object.keys(oracleSchemas("hazard").GenetoxSummary!.properties);
        for (const field of ["ames", "genetoxCall", "micronucleus", "reportsPositive", "reportsNegative", "reportsOther", "clowderDocId"]) {
            expect(props).toContain(field);
        }
        // The details record lives on a different endpoint.
        for (const field of ["assayCategory", "assayType", "metabolicActivation", "overallResult"]) {
            expect(props).not.toContain(field);
        }
    });

    it("names cancerCall and exposureRoute on the cancer summary", () => {
        const props = Object.keys(oracleSchemas("hazard").CancerSummary!.properties);
        expect(props).toContain("cancerCall");
        expect(props).toContain("exposureRoute");
        expect(props).not.toContain("classification");
        expect(props).not.toContain("cancerClassification");
    });

    it("declares no averageMass on the chemicaldetailstandard projection", () => {
        const props = Object.keys(oracleSchemas("chemical").ChemicalDetailStandard!.properties);
        expect(props).toContain("monoisotopicMass");
        expect(props).not.toContain("averageMass");
        const detail = readFixture("comptox", "chemical-detail.json") as Record<string, unknown>;
        expect("averageMass" in detail).toBe(false);
    });

    it("declares hitc as a double, thus the active predicate is a threshold", () => {
        const hitc = oracleSchemas("bioactivity").BioactivityDataAll!.properties.hitc as { type: string; format: string };
        expect(hitc.type).toBe("number");
        expect(hitc.format).toBe("double");
    });

    it("carries no assay identifier on the per-chemical roll-up", () => {
        const props = Object.keys(oracleSchemas("bioactivity").ChemicalAgg!.properties);
        expect(props).not.toContain("aeid");
        expect(props).not.toContain("aenm");
        // The assay resource is where the endpoint name lives.
        expect(Object.keys(oracleSchemas("bioactivity").AssayAnnotation!.properties)).toContain("assayComponentEndpointName");
    });

    it("serves only the misspelled pesticide probability", () => {
        const props = Object.keys(oracleSchemas("exposure").GenExpoPrediction!.properties);
        expect(props).toContain("probabilityPesticde");
        expect(props).not.toContain("probabilityPesticide");
    });
});
