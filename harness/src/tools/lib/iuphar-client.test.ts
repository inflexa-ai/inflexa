import { afterEach, describe, expect, it } from "bun:test";
import { z } from "zod";

import { fixtureCase, readFixture, runFixtureSuite } from "./__fixtures__/fixture-runner.js";
import { getFamily, getFamilyHeterodimers, IupharDatabaseLinkSchema, IupharFamilySchema, IupharTargetSchema } from "./iuphar-client.js";

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

runFixtureSuite("iuphar golden fixtures", [
    fixtureCase({
        name: "IupharTargetSchema — shape A, the /targets list",
        provider: "iuphar",
        fixture: "targets_geneSymbol_EGFR.json",
        drift: "targets_geneSymbol_EGFR.drift.json",
        schema: z.array(IupharTargetSchema),
        assertOutput: (targets) => {
            const target = targets[0]!;
            expect(target.targetId).toBe(1797);
            // Shape A omits the key. The parsed value is thus `undefined`, and
            // never `[]`, which is what the read site of `getFamilyHeterodimers`
            // has to tell apart.
            expect(target.complexIds).toBeUndefined();
            expect(target.familyIds).toEqual([320]);
            expect(target.type).toBe("catalytic_receptor");
        },
    }),
    fixtureCase({
        name: "IupharTargetSchema — shape A, the /complexes list",
        provider: "iuphar",
        fixture: "target_43_complexes.json",
        drift: "targets_geneSymbol_EGFR.drift.json",
        schema: z.array(IupharTargetSchema),
        assertOutput: (targets) => {
            const complex = targets[0]!;
            expect(complex.targetId).toBe(44);
            expect(complex.complexIds).toBeUndefined();
            expect(complex.subunitIds).toEqual([43, 51]);
        },
    }),
    fixtureCase({
        name: "IupharTargetSchema — shape B, the /subunits list",
        provider: "iuphar",
        fixture: "target_44_AMY1_subunits.json",
        drift: "target_44_AMY1_subunits.drift.json",
        schema: z.array(IupharTargetSchema),
        assertOutput: (subunits) => {
            const ramp1 = subunits[0]!;
            expect(ramp1.targetId).toBe(51);
            // Shape B is the one shape that carries `complexIds` populated, and
            // it is also the one shape that names the kind of the target in
            // CamelCase.
            expect(ramp1.complexIds).toEqual([44, 48]);
            expect(ramp1.type).toBe("AccessoryProtein");
            expect(ramp1.familyIds).toEqual([]);
        },
    }),
    fixtureCase({
        name: "IupharTargetSchema — shape C, the single target",
        provider: "iuphar",
        fixture: "target_single_51_RAMP1.json",
        drift: "target_single_51_RAMP1.drift.json",
        schema: IupharTargetSchema,
        assertOutput: (target) => {
            expect(target.targetId).toBe(51);
            expect(target.complexIds).toEqual([44, 48]);
            // The same accessory protein that shape B names `AccessoryProtein`
            // carries the empty string here.
            expect(target.type).toBe("");
        },
    }),
    fixtureCase({
        name: "IupharFamilySchema — a known family",
        provider: "iuphar",
        fixture: "family_11.json",
        drift: "family_11.drift.json",
        schema: IupharFamilySchema,
        assertOutput: (family) => {
            expect(family.familyId).toBe(11);
            expect(family.targetIds).toContain(44);
        },
    }),
    fixtureCase({
        name: "IupharFamilySchema — the unknown-family sentinel",
        provider: "iuphar",
        fixture: "family_unknown.json",
        drift: "family_11.drift.json",
        schema: IupharFamilySchema,
        assertOutput: (family) => {
            // GtoPdb answers an unknown family with HTTP 200 and this record.
            expect(family.familyId).toBe(-1);
            expect(family.targetIds).toEqual([]);
        },
    }),
    fixtureCase({
        name: "IupharDatabaseLinkSchema — the cross-references of a target",
        provider: "iuphar",
        fixture: "target_43_databaseLinks.json",
        drift: "target_43_databaseLinks.drift.json",
        schema: z.array(IupharDatabaseLinkSchema),
        assertOutput: (links) => {
            const human = links.filter((link) => link.database === "UniProtKB" && link.species === "Human");
            expect(human.map((link) => link.accession)).toEqual(["P30988"]);
        },
    }),
]);

describe("getFamilyHeterodimers", () => {
    it("asks for the complexes of a target whose list record omits complexIds", async () => {
        stubFetch((url) => {
            if (url.includes("/targets?geneSymbol=CALCR")) return json(readFixture("iuphar", "targets_geneSymbol_CALCR.json"));
            if (url.includes("/targets/43/complexes")) return json(readFixture("iuphar", "target_43_complexes.json"));
            if (url.includes("/targets/44/subunits")) return json(readFixture("iuphar", "target_44_AMY1_subunits.json"));
            return json([], 404);
        });

        const heterodimers = await getFamilyHeterodimers("CALCR");

        expect(heterodimers).toHaveLength(1);
        expect(heterodimers[0]!.complex.name).toBe("AMY1 receptor");
        expect(heterodimers[0]!.accessories.map((accessory) => accessory.name)).toEqual(["RAMP1"]);
        expect(heterodimers[0]!.subunits.map((subunit) => subunit.targetId)).toEqual([51, 43]);
    });
});

describe("getFamily", () => {
    it("reads the -1 sentinel of an unknown family as not found", async () => {
        stubFetch(() => json(readFixture("iuphar", "family_unknown.json")));
        expect(await getFamily(999999)).toBeNull();
    });

    it("gives the record of a known family", async () => {
        stubFetch(() => json(readFixture("iuphar", "family_11.json")));
        expect((await getFamily(11))!.targetIds).toContain(44);
    });
});
