import { expect } from "bun:test";

import { fixtureCase, runFixtureSuite } from "../__fixtures__/fixture-runner.js";
import { GnomadAnswerSchema, mapGnomadAnswer } from "../gnomad-client.js";

runFixtureSuite("gnomad golden fixtures", [
    fixtureCase({
        name: "GnomadAnswerSchema — a gnomad_r4 batch with a found variant and a miss",
        provider: "gnomad",
        fixture: "batch-r4.json",
        drift: "batch-r4.drift.json",
        schema: GnomadAnswerSchema,
        assertOutput: (answer) => {
            // A miss answers HTTP 200 with a null alias and an `errors` entry that carries no path.
            expect(answer.errors).toEqual([{ message: "Variant not found" }]);
            expect(answer.data?.v1).toBeNull();

            const out = mapGnomadAnswer(answer, ["1-55051215-G-GA", "1-1-A-T"], "gnomad_r4");
            expect(out.referenceGenome).toBe("GRCh38");
            expect(out.notFound).toEqual(["1-1-A-T"]);
            expect(out.variants).toHaveLength(1);
            const [variant] = out.variants;
            expect(variant?.variantId).toBe("1-55051215-G-GA");
            expect(variant?.rsids).toEqual(["rs527413419"]);
            expect(variant?.genome).toMatchObject({ ac: 727, an: 152324, af: 0.004772721304587589 });
            expect(variant?.exome).toMatchObject({ ac: 192, an: 303936, af: 0.0006317119393556538 });
            // The splits by sex and the 1KG and HGDP cohorts go, and each top-level ancestry group stays.
            expect(variant?.genome?.populations.map((group) => group.id)).toEqual(["remaining", "amr", "fin", "ami", "eas", "mid", "sas", "asj", "afr", "nfe"]);
            expect(variant?.genome?.populations.find((group) => group.id === "afr")).toEqual({ id: "afr", ac: 683, an: 41568, af: 683 / 41568 });
        },
    }),
    fixtureCase({
        name: "GnomadAnswerSchema — an exac variant with no genome callset",
        provider: "gnomad",
        fixture: "batch-exac.json",
        drift: "batch-exac.drift.json",
        schema: GnomadAnswerSchema,
        assertOutput: (answer) => {
            // A callset that the dataset does not hold is an explicit null, and an empty rsID list is an empty array.
            expect(answer.errors).toBeUndefined();

            const out = mapGnomadAnswer(answer, ["1-55516888-G-GA"], "exac");
            expect(out.referenceGenome).toBe("GRCh37");
            expect(out.notFound).toEqual([]);
            const [variant] = out.variants;
            expect(variant?.rsids).toEqual([]);
            expect(variant?.genome).toBeNull();
            expect(variant?.exome).toMatchObject({ ac: 1, an: 10522 });
            // A group with no called allele has no frequency.
            expect(variant?.exome?.populations.find((group) => group.id === "fin")).toEqual({ id: "fin", ac: 0, an: 0, af: null });
        },
    }),
]);
