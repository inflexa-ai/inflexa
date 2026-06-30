import { afterEach, describe, expect, it } from "bun:test";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { searchTargetsTool } from "./search-targets.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function stubFetch(response: () => Response): void {
    globalThis.fetch = (async () => response()) as unknown as typeof fetch;
}

describe("searchTargets (ChEMBL family)", () => {
    it("returns a populated targets list for a found query", async () => {
        stubFetch(
            () =>
                new Response(
                    JSON.stringify({
                        targets: [
                            {
                                target_chembl_id: "CHEMBL203",
                                pref_name: "Epidermal growth factor receptor erbB1",
                                target_type: "SINGLE PROTEIN",
                                organism: "Homo sapiens",
                                target_components: [
                                    {
                                        accession: "P00533",
                                        target_component_synonyms: [{ syn_type: "GENE_SYMBOL", component_synonym: "EGFR" }],
                                    },
                                ],
                            },
                        ],
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                ),
        );

        const { ctx } = makeToolContext();
        const result = (await searchTargetsTool.execute({ query: "EGFR", limit: 25 }, ctx))._unsafeUnwrap();

        expect(result.targets).toHaveLength(1);
        expect(result.targets[0]!.targetChemblId).toBe("CHEMBL203");
        expect(result.targets[0]!.geneNames).toEqual(["EGFR"]);
    });

    it("returns an empty targets list when ChEMBL responds 404 (not is_error)", async () => {
        stubFetch(() => new Response("not found", { status: 404 }));

        const { ctx } = makeToolContext();
        const result = (await searchTargetsTool.execute({ query: "NOTATARGET", limit: 25 }, ctx))._unsafeUnwrap();

        expect(result.targets).toEqual([]);
    });

    it("throws on an upstream 5xx failure", async () => {
        stubFetch(() => new Response("upstream down", { status: 500 }));

        const { ctx } = makeToolContext();
        await expect(searchTargetsTool.execute({ query: "EGFR", limit: 25 }, ctx)).rejects.toThrow();
    });
});
