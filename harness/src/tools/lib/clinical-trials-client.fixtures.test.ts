import { afterEach, describe, expect, it } from "bun:test";

import { fixtureCase, readFixture, runFixtureSuite } from "./__fixtures__/fixture-runner.js";
import { CtSearchResponseSchema, CtStudySchema, getTrialDetails, mapClinicalTrialStudy, searchTrials } from "./clinical-trials-client.js";

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

runFixtureSuite("clinicaltrials golden fixtures", [
    fixtureCase({
        name: "CtSearchResponseSchema — a search page",
        provider: "clinicaltrials",
        fixture: "search-imatinib.json",
        drift: "search-imatinib.drift.json",
        schema: CtSearchResponseSchema,
        assertOutput: (body) => {
            const trials = (body.studies ?? []).map(mapClinicalTrialStudy);
            expect(trials).toHaveLength(5);
            expect(trials[0]!.nctId).toBe("NCT00039364");
            expect(trials[0]!.phase).toBe("PHASE2");
            expect(trials[0]!.enrollmentCount).toBe(112);
        },
    }),
    fixtureCase({
        name: "CtSearchResponseSchema — a page with the total count",
        provider: "clinicaltrials",
        fixture: "search-adalimumab-counttotal.json",
        drift: "search-adalimumab-counttotal.drift.json",
        schema: CtSearchResponseSchema,
        assertOutput: (body) => {
            // `countTotal=true` is what makes `totalCount` arrive at all.
            expect(body.totalCount).toBe(881);
            const phases = (body.studies ?? []).map((s) => s.protocolSection?.designModule?.phases);
            // An observational study omits the `phases` key altogether.
            expect(phases).toEqual([["PHASE3"], undefined, undefined]);
        },
    }),
    fixtureCase({
        name: "CtStudySchema — one study with results",
        provider: "clinicaltrials",
        fixture: "details-NCT00760929-results.json",
        drift: "details-NCT00760929-results.drift.json",
        schema: CtStudySchema,
        assertOutput: (study) => {
            const measure = study.resultsSection?.outcomeMeasuresModule?.outcomeMeasures?.[0];
            // The OpenAPI document types a measurement value as a string, thus the
            // client reads it with `parseFloat`.
            const value = measure?.classes?.[0]?.categories?.[0]?.measurements?.[0]?.value;
            expect(typeof value).toBe("string");
            expect(parseFloat(value!)).toBe(18);
            expect(study.resultsSection?.adverseEventsModule?.eventGroups).toHaveLength(4);
        },
    }),
]);

describe("the ClinicalTrials.gov client over the golden fixtures", () => {
    it("asks for the total count and never for filter.phase", async () => {
        stubFetch(readFixture("clinicaltrials", "search-adalimumab-counttotal.json"));

        const result = await searchTrials("adalimumab", { limit: 3 });

        expect(requested[0]).toContain("countTotal=true");
        expect(requested[0]).not.toContain("filter.phase");
        expect(result.totalFound).toBe(881);
        expect(result.trials).toHaveLength(3);
    });

    it("filters the phase after the fetch, over designModule.phases", async () => {
        stubFetch(readFixture("clinicaltrials", "search-adalimumab-counttotal.json"));

        const result = await searchTrials("adalimumab", { phase: "PHASE3", limit: 3 });

        expect(result.trials.map((t) => t.nctId)).toEqual(["NCT04798755"]);
        // The count belongs to the query, not to the phase-narrowed page.
        expect(result.totalFound).toBe(881);
    });

    it("parses a measurement value into the quantitative effect", async () => {
        stubFetch(readFixture("clinicaltrials", "details-NCT00760929-results.json"));

        const details = await getTrialDetails("NCT00760929");

        expect(details!.outcomes[0]!.effect).toMatchObject({ kind: "quantitative", value: 18, units: "Participants" });
        expect(details!.adverseEvents[0]!.counts[0]!.numAtRisk).toBe(26);
    });
});
