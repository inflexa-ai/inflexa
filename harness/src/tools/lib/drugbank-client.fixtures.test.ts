/**
 * The DrugBank fixtures are SYNTHETIC. No key exists here, thus no live payload
 * was captured. Each record is the documented shape of the Discovery API, from
 * the Wayback captures of `docs.drugbank.com/discovery/v1`. The files carry
 * `.synthetic.` in the name, and the fixture directory carries no manifest,
 * because the refresh script has no request to replay.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { fixtureCase, readFixture, runFixtureSuite } from "./__fixtures__/fixture-runner.js";
import { BondResponseSchema, DrugResponseSchema, searchDrugbank } from "./drugbank-client.js";

const realFetch = globalThis.fetch;
let requested: string[] = [];

afterEach(() => {
    globalThis.fetch = realFetch;
    requested = [];
});

/** Answer every request with the given payload, and record each URL. */
function stubFetch(body: unknown): void {
    globalThis.fetch = (async (input: unknown) => {
        requested.push(String(input));
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
}

runFixtureSuite("drugbank golden fixtures", [
    fixtureCase({
        name: "DrugResponseSchema — one Discovery drug record",
        provider: "drugbank",
        fixture: "discovery-record.synthetic.json",
        drift: "discovery-record.synthetic.drift.json",
        schema: DrugResponseSchema,
        assertOutput: (body) => {
            const drug = Array.isArray(body) ? body[0]! : body;
            expect(drug.drugbankId).toBe("DB00316");
            expect(drug.name).toBe("Acetaminophen");
            expect(drug.type).toBe("Small Molecule");
            expect(drug.groups).toEqual(["Approved"]);
            expect(drug.description).toContain("paracetamol");
        },
    }),
    fixtureCase({
        name: "BondResponseSchema — the target bonds of one gene",
        provider: "drugbank",
        fixture: "bonds-targets.synthetic.json",
        drift: "bonds-targets.synthetic.drift.json",
        schema: BondResponseSchema,
        assertOutput: (bonds) => {
            expect(bonds).toHaveLength(3);
            expect(bonds.map((b) => b.drug.drugbank_id)).toEqual(["DB16258", "DB00110", "DB16258"]);
        },
    }),
]);

describe("the DrugBank client over the golden fixtures", () => {
    it("rejects an error envelope instead of giving one blank drug row", async () => {
        stubFetch(readFixture("drugbank", "discovery-record.synthetic.drift.json"));

        await expect(searchDrugbank("test-key", "acetaminophen", "drug")).rejects.toThrow("did not match the expected schema");
    });

    it("pages a name search with per_page, because there is no limit parameter", async () => {
        stubFetch([readFixture("drugbank", "discovery-record.synthetic.json")]);

        const drugs = await searchDrugbank("test-key", "acetaminophen", "drug", 200);

        expect(requested[0]).toContain("/discovery/v1/drugs?q=acetaminophen");
        // `per_page` tops out at 50, and no `limit` parameter exists.
        expect(requested[0]).toContain("per_page=50");
        expect(requested[0]).not.toContain("limit=");
        expect(drugs[0]!.drugbankId).toBe("DB00316");
    });

    it("reads the drugs of a gene off the target bonds, one row per drug", async () => {
        stubFetch(readFixture("drugbank", "bonds-targets.synthetic.json"));

        const drugs = await searchDrugbank("test-key", "F", "target", 10);

        expect(requested[0]).toContain("/discovery/v1/bonds/targets?q=polypeptides.gene_name%3AF");
        expect(drugs.map((d) => d.drugbankId)).toEqual(["DB16258", "DB00110"]);
        expect(drugs[0]!.name).toBe("Nirsevimab");
    });
});
