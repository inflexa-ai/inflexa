import { afterEach, describe, expect, it } from "bun:test";

import { presentAt } from "../../../lib/present.js";
import { CtStudySchema, searchTrials } from "../clinical-trials-client.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

/** A `fetch` test double: the callable plus the `preconnect` member that `typeof fetch` carries. */
function fetchDouble(run: () => Promise<Response>): typeof fetch {
    return Object.assign(run, { preconnect: fetch.preconnect });
}

const STUDY = {
    protocolSection: {
        identificationModule: { nctId: "NCT00000001", briefTitle: "A study" },
        armsInterventionsModule: {
            interventions: [{ name: "Imatinib", type: "DRUG", otherNames: ["Gleevec", 5, null, { alias: "STI571" }, "STI571"] }],
        },
    },
};

describe("the ClinicalTrials.gov intervention aliases", () => {
    it("parses a study whose otherNames holds a member that is not a string, and keeps the string members", () => {
        const parsed = CtStudySchema.safeParse(STUDY);
        expect(parsed.error?.issues ?? []).toEqual([]);
        expect(parsed.data?.protocolSection?.armsInterventionsModule?.interventions?.[0]?.otherNames).toEqual(["Gleevec", "STI571"]);
    });

    it("gives the study from the search with the string aliases only", async () => {
        globalThis.fetch = fetchDouble(() =>
            Promise.resolve(
                new Response(JSON.stringify({ totalCount: 1, studies: [STUDY] }), { status: 200, headers: { "content-type": "application/json" } }),
            ),
        );

        const result = await searchTrials("imatinib", { limit: 5 });

        expect(result.totalFound).toBe(1);
        expect(result.trials.map((trial) => trial.nctId)).toEqual(["NCT00000001"]);
        expect(presentAt(presentAt(result.trials, 0).interventionDetails, 0).otherNames).toEqual(["Gleevec", "STI571"]);
    });
});
