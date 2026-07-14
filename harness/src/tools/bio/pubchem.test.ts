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
                            MolecularWeight: 180.16,
                            CanonicalSMILES: "CC(=O)OC1=CC=CC=C1C(=O)O",
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
        }
    });

    it("resolves by inchikey through the inchikey namespace", async () => {
        let seenUrl = "";
        stubFetch((url) => {
            seenUrl = url;
            return json({ PropertyTable: { Properties: [{ CID: 2244 }] } });
        });

        const { ctx } = makeToolContext();
        const result = (await pubchemTool.execute({ action: "compound", query: "BSYNRYMUTXBXSQ-UHFFFAOYSA-N", searchBy: "inchikey" }, ctx))._unsafeUnwrap();

        expect(seenUrl).toContain("/compound/inchikey/");
        expect("results" in result && result.results).toHaveLength(1);
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
    it("returns a flat crossRefs array of source/id pairs", async () => {
        stubFetch(() =>
            json({
                InformationList: {
                    Information: [
                        {
                            CID: 2244,
                            RegistryID: ["CHEMBL25", "DB00945"],
                            SourceName: ["ChEMBL", "DrugBank"],
                        },
                    ],
                },
            }),
        );

        const { ctx } = makeToolContext();
        const result = (await pubchemTool.execute({ action: "crossrefs", cid: 2244 }, ctx))._unsafeUnwrap();

        expect("crossRefs" in result && result.crossRefs).toEqual([
            { source: "ChEMBL", id: "CHEMBL25" },
            { source: "DrugBank", id: "DB00945" },
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
    const assayTable = {
        Table: {
            Columns: {
                Column: [{ Heading: "AID" }, { Heading: "AssayName" }, { Heading: "TargetName" }, { Heading: "ActivityOutcome" }, { Heading: "ActivityValue" }],
            },
            Row: [
                { Cell: [{ intval: 1 }, { sval: "Assay One" }, { sval: "COX-1" }, { sval: "Active" }, { fval: 1.5 }] },
                { Cell: [{ intval: 2 }, { sval: "Assay Two" }, { sval: "COX-2" }, { sval: "Inactive" }, {}] },
            ],
        },
    };

    it("returns per-assay screening summaries", async () => {
        stubFetch(() => json(assayTable));

        const { ctx } = makeToolContext();
        const result = (await pubchemTool.execute({ action: "assays", cid: 2244 }, ctx))._unsafeUnwrap();

        expect("assays" in result && result.assays).toHaveLength(2);
        if ("assays" in result) {
            expect(result.assays[0]!.aid).toBe(1);
            expect(result.assays[0]!.activityOutcome).toBe("Active");
        }
    });

    it("keeps only active rows when activeOnly is true", async () => {
        stubFetch(() => json(assayTable));

        const { ctx } = makeToolContext();
        const result = (await pubchemTool.execute({ action: "assays", cid: 2244, activeOnly: true }, ctx))._unsafeUnwrap();

        expect("assays" in result && result.assays).toHaveLength(1);
        if ("assays" in result) expect(result.assays[0]!.activityOutcome).toBe("Active");
    });

    it("caps the returned rows at limit", async () => {
        stubFetch(() => json(assayTable));

        const { ctx } = makeToolContext();
        const result = (await pubchemTool.execute({ action: "assays", cid: 2244, limit: 1 }, ctx))._unsafeUnwrap();

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
