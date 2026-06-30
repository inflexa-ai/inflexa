import { afterEach, describe, expect, it } from "bun:test";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { searchPubchemCompoundTool } from "./search-pubchem-compound.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function stubFetch(response: () => Response): void {
    globalThis.fetch = (async () => response()) as unknown as typeof fetch;
}

describe("searchPubchemCompound (pubchem family)", () => {
    it("returns a populated results variant for a found compound", async () => {
        stubFetch(
            () =>
                new Response(
                    JSON.stringify({
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
                    { status: 200, headers: { "content-type": "application/json" } },
                ),
        );

        const { ctx } = makeToolContext();
        const result = (await searchPubchemCompoundTool.execute({ query: "aspirin", searchBy: "name" }, ctx))._unsafeUnwrap();

        expect(result.results).toHaveLength(1);
        expect(result.results[0]!.cid).toBe(2244);
        expect(result.results[0]!.molecularFormula).toBe("C9H8O4");
    });

    it("returns an empty results variant for a not-found compound (does not throw)", async () => {
        stubFetch(() => new Response("PUGREST.NotFound", { status: 404 }));

        const { ctx } = makeToolContext();
        const result = (await searchPubchemCompoundTool.execute({ query: "definitely-not-a-compound", searchBy: "name" }, ctx))._unsafeUnwrap();

        expect(result.results).toEqual([]);
    });

    it("throws on an upstream 5xx failure", async () => {
        stubFetch(() => new Response("upstream down", { status: 500 }));

        const { ctx } = makeToolContext();
        await expect(searchPubchemCompoundTool.execute({ query: "aspirin", searchBy: "name" }, ctx)).rejects.toThrow();
    });
});
