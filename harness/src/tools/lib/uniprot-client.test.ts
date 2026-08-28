import { afterEach, describe, expect, it } from "bun:test";

import { readFixture } from "./__fixtures__/fixture-runner.js";
import { getUniProtRecord } from "./uniprot-client.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function stubFetch(body: unknown): void {
    globalThis.fetch = (async () =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

// `UniProtRecordSchema` is private to the client, thus this table drives the
// golden fixtures through `getUniProtRecord` instead of through the shared
// fixture runner. The assertions are the same three: the schema accepts the
// positive fixture, the mapped record holds, and the schema rejects the twin.
describe("uniprot golden fixtures", () => {
    it("accepts the positive fixture and maps the EGFR entry", async () => {
        stubFetch(readFixture("uniprot", "entry_P00533_EGFR.json"));

        const record = (await getUniProtRecord("P00533"))!;

        expect(record.primaryAccession).toBe("P00533");
        expect(record.uniProtkbId).toBe("EGFR_HUMAN");
        expect(record.geneNames).toEqual(["EGFR"]);
        expect(record.chemblIds).toEqual(["CHEMBL203"]);
        expect(record.reactomePathwayIds.length).toBe(37);
        expect(record.proteinFamilyText).toContain("protein kinase superfamily");
    });

    it("maps an entry that omits the genes and the comments", async () => {
        stubFetch(readFixture("uniprot", "entry_Q6ZQY7_obscure.json"));

        const record = (await getUniProtRecord("Q6ZQY7"))!;

        // UniProt omits the key of an absent value, and it never sends null.
        expect(record.primaryAccession).toBe("Q6ZQY7");
        expect(record.geneNames).toEqual([]);
        expect(record.chemblIds).toEqual([]);
        expect(record.proteinFamilyText).toBeNull();
    });

    it("rejects the drift twin", async () => {
        stubFetch(readFixture("uniprot", "entry_P00533_EGFR.drift.json"));

        await expect(getUniProtRecord("P00533")).rejects.toThrow(/schema/);
    });
});

describe("the UniProtKB oracle", () => {
    it("marks no field of the entry component as required", () => {
        // The published OpenAPI document is the evidence that the all-optional
        // record schema is contract-correct, and not a widening without a
        // reason.
        const oracle = readFixture("uniprot", "uniprotkb_openapi.json") as {
            components: { schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }> };
        };
        const entry = oracle.components.schemas["UniProtKBEntry"]!;

        expect(entry.required).toBeUndefined();
        expect(Object.keys(entry.properties ?? {})).toContain("genes");
    });
});
