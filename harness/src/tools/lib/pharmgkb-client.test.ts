import { afterEach, describe, expect, it } from "bun:test";

import { fixtureCase, readFixture, runFixtureSuite } from "./__fixtures__/fixture-runner.js";
import { PharmgkbResponseSchema, searchPharmgkb } from "./pharmgkb-client.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function stubFetch(response: (url: string) => Response): void {
    globalThis.fetch = (async (input: unknown) => response(String(input))) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

runFixtureSuite("clinpgx golden fixtures", [
    fixtureCase({
        name: "PharmgkbResponseSchema — a gene query",
        provider: "clinpgx",
        fixture: "clinicalAnnotation_gene_CYP2C19.json",
        drift: "clinicalAnnotation_gene_CYP2C19.drift.json",
        schema: PharmgkbResponseSchema,
        assertOutput: (response) => {
            const rows = response.data!;
            // The excerpt keeps the first row of each level-of-evidence term.
            expect(rows.map((row) => row.levelOfEvidence?.term)).toEqual(["3", "4", "2A", "1A"]);
            expect(rows[0]!.location?.genes?.[0]?.symbol).toBe("CYP2C19");
            expect(rows[0]!.relatedChemicals?.length).toBeGreaterThan(0);
        },
    }),
    fixtureCase({
        name: "PharmgkbResponseSchema — a drug query with an empty gene list",
        provider: "clinpgx",
        fixture: "clinicalAnnotation_drug_clopidogrel.json",
        drift: "clinicalAnnotation_gene_CYP2C19.drift.json",
        schema: PharmgkbResponseSchema,
        assertOutput: (response) => {
            const rows = response.data!;
            // An annotation of a variant that no gene carries sends the empty
            // array, and not an omitted key.
            expect(rows[1]!.location?.genes).toEqual([]);
        },
    }),
]);

describe("searchPharmgkb", () => {
    it("maps each annotation onto the gene, the drug, and the level of evidence", async () => {
        stubFetch(() => json(readFixture("clinpgx", "clinicalAnnotation_gene_CYP2C19.json")));

        const { annotations, totalFound } = await searchPharmgkb("CYP2C19", "gene");

        expect(totalFound).toBe(4);
        expect(annotations[0]!.gene).toBe("CYP2C19");
        expect(annotations[0]!.levelOfEvidence).toBe("3");
        expect(annotations.map((annotation) => annotation.levelOfEvidence)).toEqual(["3", "4", "2A", "1A"]);
    });

    it("gives an empty result for the 404 that answers a query with no match", async () => {
        stubFetch(() => json({ status: "fail", data: { errors: [{ message: "No results matching criteria." }] } }, 404));

        expect(await searchPharmgkb("NOTAGENE", "gene")).toEqual({ annotations: [], totalFound: 0 });
    });

    it("throws when the host is down", async () => {
        stubFetch(() => new Response("upstream down", { status: 500 }));

        await expect(searchPharmgkb("CYP2C19", "gene")).rejects.toThrow(/500/);
    });
});
