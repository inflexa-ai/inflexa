import { afterEach, describe, expect, it } from "bun:test";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { pubchemTool } from "./pubchem.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function stubFetch(response: (url: string) => Response): void {
    globalThis.fetch = (async (url: string | URL) => response(String(url))) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("pubchem tool — action 'compound'", () => {
    it("returns a populated results variant for a found compound", async () => {
        stubFetch(() =>
            json({
                PropertyTable: {
                    Properties: [
                        {
                            CID: 2244,
                            MolecularFormula: "C9H8O4",
                            // PubChem serializes the weight as a string, and it serves
                            // the SMILES under `ConnectivitySMILES`.
                            MolecularWeight: "180.16",
                            ConnectivitySMILES: "CC(=O)OC1=CC=CC=C1C(=O)O",
                            InChI: "InChI=1S/C9H8O4/c1-6(10)13-8-5-3-2-4-7(8)9(11)12/h2-5H,1H3",
                            InChIKey: "BSYNRYMUTXBXSQ-UHFFFAOYSA-N",
                            IUPACName: "2-acetyloxybenzoic acid",
                            XLogP: 1.2,
                            TPSA: 63.6,
                            HBondDonorCount: 1,
                            HBondAcceptorCount: 4,
                            RotatableBondCount: 3,
                            Complexity: 212,
                        },
                    ],
                },
            }),
        );

        const { ctx } = makeToolContext();
        const result = (await pubchemTool.execute({ action: "compound", query: "aspirin", searchBy: "name" }, ctx))._unsafeUnwrap();

        expect("results" in result && result.results).toHaveLength(1);
        if ("results" in result) {
            expect(result.results[0]!.cid).toBe(2244);
            expect(result.results[0]!.molecularFormula).toBe("C9H8O4");
            expect(result.results[0]!.molecularWeight).toBe(180.16);
            expect(result.results[0]!.canonicalSmiles).toBe("CC(=O)OC1=CC=CC=C1C(=O)O");
        }
    });

    it("resolves by inchikey through the inchikey namespace", async () => {
        let seenUrl = "";
        stubFetch((url) => {
            seenUrl = url;
            return json({ PropertyTable: { Properties: [{ CID: 2244, ConnectivitySMILES: "CC(=O)OC1=CC=CC=C1C(=O)O" }] } });
        });

        const { ctx } = makeToolContext();
        const result = (await pubchemTool.execute({ action: "compound", query: "BSYNRYMUTXBXSQ-UHFFFAOYSA-N", searchBy: "inchikey" }, ctx))._unsafeUnwrap();

        expect(seenUrl).toContain("/compound/inchikey/");
        expect("results" in result && result.results).toHaveLength(1);
    });

    it("returns an empty results variant for a CID that does not exist (200 with the CID alone)", async () => {
        // PubChem answers 200 for a nonexistent CID, with a row that carries no property.
        stubFetch(() => json({ PropertyTable: { Properties: [{ CID: 999999999 }] } }));

        const { ctx } = makeToolContext();
        const result = (await pubchemTool.execute({ action: "compound", query: "999999999", searchBy: "cid" }, ctx))._unsafeUnwrap();

        expect("results" in result && result.results).toEqual([]);
    });

    it("returns an empty results variant for a not-found compound (does not throw)", async () => {
        stubFetch(() => new Response("PUGREST.NotFound", { status: 404 }));

        const { ctx } = makeToolContext();
        const result = (await pubchemTool.execute({ action: "compound", query: "definitely-not-a-compound", searchBy: "name" }, ctx))._unsafeUnwrap();

        expect("results" in result && result.results).toEqual([]);
    });

    it("throws on an upstream 5xx failure", async () => {
        stubFetch(() => new Response("upstream down", { status: 500 }));

        const { ctx } = makeToolContext();
        await expect(pubchemTool.execute({ action: "compound", query: "aspirin", searchBy: "name" }, ctx)).rejects.toThrow();
    });
});

describe("pubchem tool — action 'crossrefs'", () => {
    it("names the registry of each id from its pattern", async () => {
        let seenUrl = "";
        stubFetch((url) => {
            seenUrl = url;
            return json({
                InformationList: {
                    Information: [
                        {
                            CID: 2244,
                            RegistryID: ["CHEMBL25", "DB00945", "C01405", "50-78-2", "1044006_USP"],
                        },
                    ],
                },
            });
        });

        const { ctx } = makeToolContext();
        const result = (await pubchemTool.execute({ action: "crossrefs", cid: 2244 }, ctx))._unsafeUnwrap();

        // `SourceName` is not parallel to `RegistryID`, thus the id itself names the registry.
        expect(seenUrl).toContain("/xrefs/RegistryID/JSON");
        expect("crossRefs" in result && result.crossRefs).toEqual([
            { source: "ChEMBL", id: "CHEMBL25" },
            { source: "DrugBank", id: "DB00945" },
            { source: "KEGG", id: "C01405" },
            { source: "CAS", id: "50-78-2" },
            // An id that matches no pattern keeps a null source.
            { source: null, id: "1044006_USP" },
        ]);
    });

    it("returns an empty crossRefs array for a 404 (valid no-data)", async () => {
        stubFetch(() => new Response("not found", { status: 404 }));

        const { ctx } = makeToolContext();
        const result = (await pubchemTool.execute({ action: "crossrefs", cid: 99999999 }, ctx))._unsafeUnwrap();

        expect("crossRefs" in result && result.crossRefs).toEqual([]);
    });
});

describe("pubchem tool — action 'assays'", () => {
    // The wire shape: `Column` is a list of plain heading strings, and each `Cell` is a
    // list of plain strings with one entry for each column. An empty cell is "".
    const assayTable = {
        Table: {
            Columns: {
                Column: [
                    "AID",
                    "Panel Member ID",
                    "SID",
                    "CID",
                    "Activity Outcome",
                    "Target Accession",
                    "Target GeneID",
                    "Activity Value [uM]",
                    "Activity Name",
                    "Assay Name",
                    "Assay Type",
                    "PubMed ID",
                    "RNAi",
                ],
            },
            Row: [
                {
                    Cell: [
                        "92967",
                        "",
                        "103164874",
                        "2244",
                        "Active",
                        "P05106",
                        "3690",
                        "5",
                        "IC50",
                        "Inhibition of arachidonic acid-induced platelet aggregation",
                        "Confirmatory",
                        "7837237",
                        "",
                    ],
                },
                { Cell: ["410", "", "11110749", "2244", "Inactive", "NP_000752", "1544", "", "", "p450-cyp1a2", "Confirmatory", "", ""] },
            ],
        },
    };

    it("returns per-assay screening summaries, active rows only by default", async () => {
        stubFetch(() => json(assayTable));

        const { ctx } = makeToolContext();
        const result = (await pubchemTool.execute({ action: "assays", cid: 2244 }, ctx))._unsafeUnwrap();

        // activeOnly defaults true, so the Inactive row is filtered out.
        expect("assays" in result && result.assays).toHaveLength(1);
        if ("assays" in result) {
            expect(result.assays[0]!.aid).toBe(92967);
            expect(result.assays[0]!.activityOutcome).toBe("Active");
            // The target name of a record is the target accession of its row.
            expect(result.assays[0]!.targetName).toBe("P05106");
            expect(result.assays[0]!.activityValue).toBe(5);
            expect(result.assays[0]!.assayName).toBe("Inhibition of arachidonic acid-induced platelet aggregation");
        }
    });

    it("includes inactive rows when activeOnly is explicitly false", async () => {
        stubFetch(() => json(assayTable));

        const { ctx } = makeToolContext();
        const result = (await pubchemTool.execute({ action: "assays", cid: 2244, activeOnly: false }, ctx))._unsafeUnwrap();

        expect("assays" in result && result.assays).toHaveLength(2);
        if ("assays" in result) {
            expect(result.assays.map((a) => a.activityOutcome)).toEqual(["Active", "Inactive"]);
            // An empty cell carries no value.
            expect(result.assays[1]!.activityValue).toBeNull();
        }
    });

    it("caps the returned rows at limit", async () => {
        stubFetch(() => json(assayTable));

        const { ctx } = makeToolContext();
        const result = (await pubchemTool.execute({ action: "assays", cid: 2244, activeOnly: false, limit: 1 }, ctx))._unsafeUnwrap();

        expect("assays" in result && result.assays).toHaveLength(1);
    });
});

describe("pubchem tool — refine guards", () => {
    it("rejects action 'compound' with no query", () => {
        const parsed = pubchemTool.inputSchema.safeParse({ action: "compound", searchBy: "name" });
        expect(parsed.success).toBe(false);
        expect(JSON.stringify(parsed.error?.issues)).toContain("query is required when action is 'compound'");
    });

    it("rejects action 'compound' with no searchBy", () => {
        const parsed = pubchemTool.inputSchema.safeParse({ action: "compound", query: "aspirin" });
        expect(parsed.success).toBe(false);
        expect(JSON.stringify(parsed.error?.issues)).toContain("searchBy is required when action is 'compound'");
    });

    it("rejects action 'crossrefs' with no cid", () => {
        const parsed = pubchemTool.inputSchema.safeParse({ action: "crossrefs" });
        expect(parsed.success).toBe(false);
        expect(JSON.stringify(parsed.error?.issues)).toContain("cid is required when action is 'crossrefs' or 'assays'");
    });

    it("rejects action 'assays' with no cid", () => {
        const parsed = pubchemTool.inputSchema.safeParse({ action: "assays", activeOnly: true });
        expect(parsed.success).toBe(false);
        expect(JSON.stringify(parsed.error?.issues)).toContain("cid is required when action is 'crossrefs' or 'assays'");
    });

    it("accepts a well-formed compound call", () => {
        const parsed = pubchemTool.inputSchema.safeParse({ action: "compound", query: "aspirin", searchBy: "name" });
        expect(parsed.success).toBe(true);
    });
});
