import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { fixtureCase, readFixture, runFixtureSuite } from "./__fixtures__/fixture-runner.js";
import { StringEnrichmentSchema, StringInteractionSchema } from "./string-client.js";

runFixtureSuite("string golden fixtures", [
    fixtureCase({
        name: "StringInteractionSchema — the interaction partners of one protein",
        provider: "string",
        fixture: "partners_ACE.json",
        drift: "partners_ACE.drift.json",
        schema: z.array(StringInteractionSchema),
        assertOutput: (rows) => {
            const first = rows[0]!;
            expect(first.proteinA).toBe("ACE");
            expect(first.proteinB).toBe("AGT");
            // STRING serializes each score as a JSON number, never as a string.
            expect(typeof first.score).toBe("number");
            expect(first.score).toBe(0.999);
            expect(rows.every((row) => typeof row.score === "number")).toBe(true);
        },
    }),
    fixtureCase({
        name: "StringEnrichmentSchema — one enriched term of each category",
        provider: "string",
        fixture: "enrichment_gabaa.json",
        drift: "enrichment_gabaa.drift.json",
        schema: z.array(StringEnrichmentSchema),
        assertOutput: (rows) => {
            expect(rows[0]!.genes).toEqual(["GABRB2", "GABRB1", "GABRA1", "GABRG2", "GABRA2"]);
            expect(rows.every((row) => Array.isArray(row.genes))).toBe(true);
            expect(rows.every((row) => row.genes.length === row.geneCount)).toBe(true);
        },
    }),
]);

describe("the STRING enrichment twin", () => {
    it("breaks preferredNames into the comma-joined form of the tsv renderer", () => {
        // The `/api/json` renderer sends an array on every row. The twin holds
        // the string form, thus the reject assertion above guards the schema
        // against a widening back onto a union.
        const drift = readFixture("string", "enrichment_gabaa.drift.json") as { preferredNames: unknown }[];

        expect(typeof drift[0]!.preferredNames).toBe("string");
    });
});
