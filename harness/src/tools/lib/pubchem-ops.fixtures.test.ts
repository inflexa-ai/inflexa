import { expect } from "bun:test";

import { fixtureCase, runFixtureSuite } from "./__fixtures__/fixture-runner.js";
import { classifyRegistryId, parseAssaySummary, PubChemPropertyResponseSchema, PubChemXrefResponseSchema, PugAssaySummarySchema } from "./pubchem-ops.js";

runFixtureSuite("pubchem golden fixtures — the tool operations", [
    fixtureCase({
        name: "PubChemPropertyResponseSchema — a resolved compound",
        provider: "pubchem",
        fixture: "property-name-aspirin.json",
        drift: "property-name-aspirin.drift.json",
        schema: PubChemPropertyResponseSchema,
        assertOutput: (response) => {
            const aspirin = response.PropertyTable?.Properties?.[0];
            expect(aspirin?.cid).toBe(2244);
            // `canonicalSmiles` comes from the live wire key `ConnectivitySMILES`.
            expect(aspirin?.canonicalSmiles).toBe("CC(=O)OC1=CC=CC=C1C(=O)O");
            expect(aspirin?.molecularWeight).toBe(180.16);
            expect(aspirin?.molecularFormula).toBe("C9H8O4");
            expect(aspirin?.xlogp).toBe(1.2);
        },
    }),
    fixtureCase({
        name: "PubChemPropertyResponseSchema — a salt with no XLogP",
        provider: "pubchem",
        fixture: "property-cid-sodium-chloride.json",
        drift: "property-cid-sodium-chloride.drift.json",
        schema: PubChemPropertyResponseSchema,
        assertOutput: (response) => {
            const salt = response.PropertyTable?.Properties?.[0];
            expect(salt?.cid).toBe(5234);
            expect(salt?.canonicalSmiles).toBe("[Na+].[Cl-]");
            // PubChem omits the key of an absent property.
            expect(salt?.xlogp).toBeNull();
            expect(salt?.tpsa).toBe(0);
        },
    }),
    fixtureCase({
        name: "PubChemPropertyResponseSchema — a CID that does not exist",
        provider: "pubchem",
        fixture: "property-cid-nonexistent.json",
        drift: "property-cid-nonexistent.drift.json",
        schema: PubChemPropertyResponseSchema,
        assertOutput: (response) => {
            const row = response.PropertyTable?.Properties?.[0];
            // PubChem answers 200 with the CID alone, thus the row carries no property
            // and the caller must drop it instead of returning a blank compound.
            expect(row?.cid).toBe(999999999);
            expect(Object.entries(row ?? {}).filter(([key, value]) => key !== "cid" && value !== null)).toEqual([]);
        },
    }),
    fixtureCase({
        name: "PubChemXrefResponseSchema — the registry ids of a compound",
        provider: "pubchem",
        fixture: "xrefs-cid-2244.json",
        drift: "xrefs-cid-2244.drift.json",
        schema: PubChemXrefResponseSchema,
        assertOutput: (response) => {
            const ids = response.InformationList?.Information?.[0]?.RegistryID ?? [];
            const sources = new Map(ids.map((id) => [id, classifyRegistryId(id)]));
            expect(sources.get("CHEMBL25")).toBe("ChEMBL");
            expect(sources.get("DB00945")).toBe("DrugBank");
            expect(sources.get("C01405")).toBe("KEGG");
            expect(sources.get("CHEBI:15365")).toBe("ChEBI");
            expect(sources.get("HMDB0001879")).toBe("HMDB");
            expect(sources.get("50-78-2")).toBe("CAS");
            expect(sources.get("1oxr")).toBe("PDB");
            // An id that matches no pattern keeps a null source.
            expect(sources.get("1044006_USP")).toBeNull();
            // A UNII holds at least one letter. Thus a ten-digit registry number is
            // not a UNII, and the row must not claim that registry for it.
            expect(sources.get("0000050782")).toBeNull();
            expect(sources.get("2512372342")).toBeNull();
            expect(classifyRegistryId("R16CO5Y76E")).toBe("UNII");
        },
    }),
    fixtureCase({
        name: "PugAssaySummarySchema — the screening table",
        provider: "pubchem",
        fixture: "assaysummary-cid-2244.json",
        drift: "assaysummary-cid-2244.drift.json",
        schema: PugAssaySummarySchema,
        assertOutput: (table) => {
            const assays = parseAssaySummary(table);
            expect(assays[0]?.aid).toBe(92967);
            expect(assays[0]?.activityOutcome).toBe("Active");
            // `targetName` is the target accession of the row.
            expect(assays[0]?.targetName).toBe("P05106");
            expect(assays[0]?.activityValue).toBe(5);
            expect(assays[0]?.assayName).toBe("Inhibition of arachidonic acid-induced platelet aggregation");
            // An empty cell is the empty string, and it reads as an absent value.
            expect(assays.some((assay) => assay.activityValue === null)).toBe(true);
        },
    }),
]);
