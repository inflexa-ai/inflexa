import { afterEach, describe, expect, it } from "bun:test";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { searchClinicalTrialsTool } from "./search-clinical-trials.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function stubFetch(response: () => Response): void {
    globalThis.fetch = (async () => response()) as unknown as typeof fetch;
}

function trialsResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

describe("searchClinicalTrials (translational-medicine family)", () => {
    it("returns a populated data variant when trials are found", async () => {
        stubFetch(() =>
            trialsResponse({
                totalCount: 1,
                studies: [
                    {
                        protocolSection: {
                            identificationModule: {
                                nctId: "NCT01234567",
                                briefTitle: "A Study of Imatinib in CML",
                            },
                            statusModule: { overallStatus: "COMPLETED" },
                            designModule: {
                                phases: ["PHASE3"],
                                enrollmentInfo: { count: 400 },
                            },
                            conditionsModule: { conditions: ["Chronic Myeloid Leukemia"] },
                            armsInterventionsModule: {
                                interventions: [{ name: "Imatinib" }],
                            },
                            sponsorCollaboratorsModule: {
                                leadSponsor: { name: "Novartis" },
                            },
                        },
                    },
                ],
            }),
        );

        const { ctx } = makeToolContext();
        const result = (await searchClinicalTrialsTool.execute({ query: "imatinib", phase: undefined, status: undefined, limit: 20 }, ctx))._unsafeUnwrap();

        expect(result.totalFound).toBe(1);
        expect(result.trials).toHaveLength(1);
        expect(result.trials[0]!.nctId).toBe("NCT01234567");
        expect(result.trials[0]!.phase).toBe("PHASE3");
    });

    it("returns an empty trials list when nothing matches (does not throw)", async () => {
        stubFetch(() => trialsResponse({ totalCount: 0, studies: [] }));

        const { ctx } = makeToolContext();
        const result = (
            await searchClinicalTrialsTool.execute({ query: "no-such-drug-xyz", phase: undefined, status: undefined, limit: 20 }, ctx)
        )._unsafeUnwrap();

        expect(result.totalFound).toBe(0);
        expect(result.trials).toEqual([]);
    });

    it("throws on an upstream 5xx failure", async () => {
        stubFetch(() => new Response("upstream down", { status: 500 }));

        const { ctx } = makeToolContext();
        await expect(searchClinicalTrialsTool.execute({ query: "imatinib", phase: undefined, status: undefined, limit: 20 }, ctx)).rejects.toThrow();
    });

    it("selects the attrition statuses the registry serves", () => {
        for (const status of ["TERMINATED", "WITHDRAWN", "SUSPENDED"]) {
            expect(searchClinicalTrialsTool.inputSchema.safeParse({ query: "imatinib", status }).success).toBe(true);
        }
    });
});

describe("searchClinicalTrials — action 'details'", () => {
    it("reads one study back by its NCT id, with its outcomes and adverse events", async () => {
        const seen: string[] = [];
        globalThis.fetch = (async (input: unknown) => {
            seen.push(String(input));
            return trialsResponse({
                protocolSection: {
                    identificationModule: { nctId: "NCT01234567", briefTitle: "A Study of Imatinib in CML" },
                    statusModule: { overallStatus: "TERMINATED", whyStopped: "Slow accrual" },
                    outcomesModule: { primaryOutcomes: [{ measure: "Overall survival", timeFrame: "24 months" }] },
                },
                resultsSection: {
                    adverseEventsModule: {
                        eventGroups: [{ id: "EG000", title: "Imatinib" }],
                        seriousEvents: [{ term: "Neutropenia", organSystem: "Blood", stats: [{ groupId: "EG000", numAffected: 3, numAtRisk: 40 }] }],
                    },
                },
            });
        }) as unknown as typeof fetch;

        const { ctx } = makeToolContext();
        const result = (await searchClinicalTrialsTool.execute({ action: "details", nctId: "NCT01234567" }, ctx))._unsafeUnwrap();

        expect(seen[0]).toContain("/studies/NCT01234567");
        expect(result.trial!.trial.nctId).toBe("NCT01234567");
        expect(result.trial!.whyStopped).toBe("Slow accrual");
        expect(result.trial!.outcomes[0]!.measure).toBe("Overall survival");
        expect(result.trial!.adverseEvents[0]).toMatchObject({ term: "Neutropenia", serious: true });
    });

    it("returns a null trial for an NCT id the registry does not hold (not is_error)", async () => {
        stubFetch(() => new Response("not found", { status: 404 }));

        const { ctx } = makeToolContext();
        const result = (await searchClinicalTrialsTool.execute({ action: "details", nctId: "NCT99999999" }, ctx))._unsafeUnwrap();

        expect(result.trial).toBeNull();
    });

    it("rejects 'details' with no nctId at the schema boundary", () => {
        const parsed = searchClinicalTrialsTool.inputSchema.safeParse({ action: "details" });

        expect(parsed.success).toBe(false);
        const message = parsed.success ? "" : parsed.error.issues.map((i) => i.message).join(" ");
        expect(message).toContain("nctId is required");
    });
});
