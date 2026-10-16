import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { fixtureCase, readFixture, runFixtureSuite } from "../__fixtures__/fixture-runner.js";
import { RawCancerStudySchema, RawMutationRowSchema } from "../cbioportal-client.js";

runFixtureSuite("cBioPortal golden fixtures", [
    fixtureCase({
        name: "RawCancerStudySchema (projection=SUMMARY)",
        provider: "cbioportal",
        fixture: "studies-SUMMARY.json",
        drift: "studies-SUMMARY.drift.json",
        schema: z.array(RawCancerStudySchema),
        assertOutput: (studies) => {
            const study = studies[0];
            expect(study.studyId).toBe("acc_tcga");
            expect(study.cancerTypeId).toBe("acc");
            expect(study.allSampleCount).toBe(92);
            // The SUMMARY projection omits the nested block, thus the top-level
            // identifier is the only one that a summary row carries.
            expect(study.cancerType).toBeUndefined();
        },
    }),
    fixtureCase({
        name: "RawCancerStudySchema (projection=DETAILED)",
        provider: "cbioportal",
        fixture: "studies-DETAILED.json",
        drift: "studies-DETAILED.drift.json",
        schema: z.array(RawCancerStudySchema),
        assertOutput: (studies) => {
            const study = studies[0];
            // The nested block keys its identifier as `id`, not `cancerTypeId`.
            expect(study.cancerType?.id).toBe("prad");
            expect(study.cancerType?.name).toBe("Prostate Adenocarcinoma");
        },
    }),
    fixtureCase({
        name: "RawMutationRowSchema (mutations/fetch, projection=SUMMARY)",
        provider: "cbioportal",
        fixture: "mutations-fetch-SUMMARY.json",
        drift: "mutations-fetch-SUMMARY.drift.json",
        schema: z.array(RawMutationRowSchema),
        assertOutput: (rows) => {
            expect(rows).toHaveLength(5);
            expect(rows[0].studyId).toBe("acc_2019");
            expect(rows[0].sampleId).toBe("ACYC-FMI-02");
        },
    }),
]);

describe("the cBioPortal oracle and the wire", () => {
    it("shows no mutationCount on any observed mutation row", () => {
        const rows = z.array(z.record(z.string(), z.json())).parse(readFixture("cbioportal", "mutations-fetch-SUMMARY.json"));
        for (const row of rows) expect("mutationCount" in row).toBe(false);
    });

    it("shows that the nested cancer-type block wins over the published name", () => {
        // The Swagger of the provider declares `TypeOfCancer.cancerTypeId`, and
        // the DETAILED payload serves `id`. The sampled wire is the oracle for
        // this one field, thus the schema reads `id` and keeps the fallback.
        const oracle = z
            .looseObject({ definitions: z.looseObject({ TypeOfCancer: z.looseObject({ properties: z.record(z.string(), z.json()) }) }) })
            .parse(readFixture("cbioportal", "openapi-v2.json"));
        expect(Object.keys(oracle.definitions.TypeOfCancer.properties)).toContain("cancerTypeId");

        const detailed = z.array(z.looseObject({ cancerType: z.record(z.string(), z.json()) })).parse(readFixture("cbioportal", "studies-DETAILED.json"));
        expect(Object.keys(detailed[0].cancerType)).toContain("id");
        expect(Object.keys(detailed[0].cancerType)).not.toContain("cancerTypeId");
    });

    it("declares no mutationCount in the published Mutation definition", () => {
        const oracle = z
            .looseObject({ definitions: z.looseObject({ Mutation: z.looseObject({ properties: z.record(z.string(), z.json()) }) }) })
            .parse(readFixture("cbioportal", "openapi-v2.json"));
        expect(Object.keys(oracle.definitions.Mutation.properties)).not.toContain("mutationCount");
    });
});
