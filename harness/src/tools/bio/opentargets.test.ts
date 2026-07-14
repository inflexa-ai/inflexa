import { afterEach, describe, expect, it } from "bun:test";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { openTargetsTool } from "./opentargets.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

interface GqlRequest {
    readonly operation: string;
    readonly variables: Record<string, unknown>;
}

/**
 * Route the single Open Targets GraphQL endpoint by the operation the client
 * sent, and record every request so a test can assert which upstream query an
 * action actually issued (and with which variables).
 */
function stubOpenTargets(responder: (req: GqlRequest) => Response): GqlRequest[] {
    const seen: GqlRequest[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
        const operation = /query (\w+)/.exec(body.query)?.[1] ?? "";
        const req: GqlRequest = { operation, variables: body.variables };
        seen.push(req);
        return responder(req);
    }) as unknown as typeof fetch;
    return seen;
}

function gqlResponse(data: unknown): Response {
    return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

const TP53 = "ENSG00000141510";

const TARGET_DATA = {
    target: {
        id: TP53,
        approvedSymbol: "TP53",
        approvedName: "tumor protein p53",
        tractability: [
            { label: "Approved Drug", modality: "SM", value: true },
            { label: "Advanced Clinical", modality: "AB", value: false },
            { label: "Literature", modality: "OC", value: true },
        ],
    },
    associations: {
        associatedDiseases: {
            rows: [
                {
                    disease: { id: "EFO_0000311", name: "cancer" },
                    score: 0.82,
                    datatypeScores: [
                        { id: "genetic_association", score: 0.9 },
                        { id: "known_drug", score: 0.4 },
                        { id: "literature", score: 0.7 },
                        { id: "animal_model", score: 0.2 },
                        { id: "somatic_mutation", score: 0.95 },
                    ],
                },
            ],
        },
    },
};

const DISEASE_DATA = {
    disease: {
        id: "EFO_0000311",
        name: "cancer",
        associatedTargets: {
            rows: [
                {
                    target: { id: TP53, approvedSymbol: "TP53", approvedName: "tumor protein p53" },
                    score: 0.71,
                    datatypeScores: [{ id: "genetic_association", score: 0.6 }],
                },
            ],
        },
    },
};

const SAFETY_DATA = {
    target: {
        id: TP53,
        approvedSymbol: "TP53",
        safetyLiabilities: [
            {
                event: "cardiac arrhythmia",
                biosamples: [{ tissueLabel: "heart" }, { tissueLabel: "myocardium" }],
                effects: [{ direction: "activation" }, { direction: "inhibition" }],
                datasource: "AOP-Wiki",
            },
        ],
    },
};

describe("opentargets — action 'target'", () => {
    it("returns targetInfo, tractability and the per-datatype association breakdown", async () => {
        const seen = stubOpenTargets(() => gqlResponse(TARGET_DATA));

        const { ctx } = makeToolContext();
        const result = (await openTargetsTool.execute({ action: "target", ensemblId: TP53, limit: 25 }, ctx))._unsafeUnwrap();

        // The 'target' action reaches the target-associations query with the Ensembl id.
        expect(seen).toEqual([{ operation: "TargetAssociations", variables: { ensemblId: TP53, size: 25 } }]);

        expect(result).toEqual({
            targetInfo: {
                ensemblId: TP53,
                approvedSymbol: "TP53",
                approvedName: "tumor protein p53",
                tractability: { smallMolecule: true, antibody: false, otherModalities: true },
                associations: [
                    {
                        diseaseId: "EFO_0000311",
                        diseaseName: "cancer",
                        score: 0.82,
                        geneticAssociationScore: 0.9,
                        knownDrugScore: 0.4,
                        literatureScore: 0.7,
                        animalModelScore: 0.2,
                        somaticMutationScore: 0.95,
                        literaturePmids: [],
                    },
                ],
            },
            associations: [
                {
                    diseaseId: "EFO_0000311",
                    diseaseName: "cancer",
                    score: 0.82,
                    geneticAssociationScore: 0.9,
                    knownDrugScore: 0.4,
                    literatureScore: 0.7,
                    animalModelScore: 0.2,
                    somaticMutationScore: 0.95,
                    literaturePmids: [],
                },
            ],
        });
    });

    it("returns a null targetInfo and no associations for an unresolvable id (does not throw)", async () => {
        stubOpenTargets(() => gqlResponse({ target: null, associations: null }));

        const { ctx } = makeToolContext();
        const result = (await openTargetsTool.execute({ action: "target", ensemblId: "ENSG00000000000", limit: 25 }, ctx))._unsafeUnwrap();

        expect(result).toEqual({ targetInfo: null, associations: [] });
    });

    it("forwards limit as the page size, and defaults it to 25 when omitted", async () => {
        const seen = stubOpenTargets(() => gqlResponse(TARGET_DATA));

        const { ctx } = makeToolContext();
        await openTargetsTool.execute({ action: "target", ensemblId: TP53, limit: 5 }, ctx);
        expect(seen[0]!.variables.size).toBe(5);

        // The schema's default is what the loop applies before `execute` runs.
        const parsed = openTargetsTool.inputSchema.safeParse({ action: "target", ensemblId: TP53 });
        expect(parsed.success && (parsed.data as { limit?: number }).limit).toBe(25);
    });

    it("throws on an upstream 5xx failure", async () => {
        stubOpenTargets(() => new Response("upstream down", { status: 500 }));

        const { ctx } = makeToolContext();
        await expect(openTargetsTool.execute({ action: "target", ensemblId: TP53, limit: 25 }, ctx)).rejects.toThrow();
    });
});

describe("opentargets — action 'disease'", () => {
    it("returns the targets ranked for the disease, each carrying its target identity", async () => {
        const seen = stubOpenTargets(() => gqlResponse(DISEASE_DATA));

        const { ctx } = makeToolContext();
        const result = (await openTargetsTool.execute({ action: "disease", efoId: "EFO_0000311", limit: 25 }, ctx))._unsafeUnwrap();

        // The 'disease' action reaches the disease-associations query with the EFO id.
        expect(seen).toEqual([{ operation: "DiseaseAssociations", variables: { efoId: "EFO_0000311", size: 25 } }]);

        expect(result).toEqual({
            associations: [
                {
                    diseaseId: "EFO_0000311",
                    diseaseName: "cancer",
                    targetId: TP53,
                    targetSymbol: "TP53",
                    targetName: "tumor protein p53",
                    score: 0.71,
                    geneticAssociationScore: 0.6,
                    knownDrugScore: null,
                    literatureScore: null,
                    animalModelScore: null,
                    somaticMutationScore: null,
                    literaturePmids: [],
                },
            ],
        });
    });

    it("returns an empty associations list for a disease with no evidence (does not throw)", async () => {
        stubOpenTargets(() => gqlResponse({ disease: null }));

        const { ctx } = makeToolContext();
        const result = (await openTargetsTool.execute({ action: "disease", efoId: "EFO_9999999", limit: 25 }, ctx))._unsafeUnwrap();

        expect(result).toEqual({ associations: [] });
    });
});

describe("opentargets — action 'safety'", () => {
    it("returns found: true with the curated liabilities, flattened to tissues and effect directions", async () => {
        const seen = stubOpenTargets(() => gqlResponse(SAFETY_DATA));

        const { ctx } = makeToolContext();
        const result = (await openTargetsTool.execute({ action: "safety", ensemblId: TP53, limit: 25 }, ctx))._unsafeUnwrap();

        // The 'safety' action reaches the safety query — and does not page.
        expect(seen).toEqual([{ operation: "TargetSafety", variables: { ensemblId: TP53 } }]);

        expect(result).toEqual({
            found: true,
            targetSymbol: "TP53",
            safetyLiabilities: [
                {
                    event: "cardiac arrhythmia",
                    biosamples: ["heart", "myocardium"],
                    effects: "activation, inhibition",
                    source: "AOP-Wiki",
                },
            ],
        });
    });

    it("returns found: false for an Ensembl id Open Targets does not know (not is_error)", async () => {
        stubOpenTargets(() => gqlResponse({ target: null }));

        const { ctx } = makeToolContext();
        const outcome = await openTargetsTool.execute({ action: "safety", ensemblId: "ENSG00000000000", limit: 25 }, ctx);

        expect(outcome.isOk()).toBe(true);
        expect(outcome._unsafeUnwrap()).toEqual({ found: false, ensemblId: "ENSG00000000000" });
    });

    it("returns found: true with an empty liabilities array when the target has none", async () => {
        stubOpenTargets(() => gqlResponse({ target: { id: TP53, approvedSymbol: "TP53", safetyLiabilities: [] } }));

        const { ctx } = makeToolContext();
        const result = (await openTargetsTool.execute({ action: "safety", ensemblId: TP53, limit: 25 }, ctx))._unsafeUnwrap();

        expect(result).toEqual({ found: true, targetSymbol: "TP53", safetyLiabilities: [] });
    });

    it("throws on an upstream 5xx failure", async () => {
        stubOpenTargets(() => new Response("upstream down", { status: 500 }));

        const { ctx } = makeToolContext();
        await expect(openTargetsTool.execute({ action: "safety", ensemblId: TP53, limit: 25 }, ctx)).rejects.toThrow();
    });
});

describe("opentargets — input validation", () => {
    it("emits a flat object schema whose only required field is the discriminator", () => {
        expect(openTargetsTool.jsonSchema.type).toBe("object");
        expect(openTargetsTool.jsonSchema.required).toEqual(["action"]);
    });

    it("rejects 'target' with no ensemblId, telling the model to resolve the symbol with search_gene", () => {
        const parsed = openTargetsTool.inputSchema.safeParse({ action: "target" });

        expect(parsed.success).toBe(false);
        const message = parsed.success ? "" : parsed.error.issues.map((i) => i.message).join(" ");
        expect(message).toContain("ensemblId is required");
        expect(message).toContain("search_gene");
    });

    it("rejects 'safety' with no ensemblId", () => {
        const parsed = openTargetsTool.inputSchema.safeParse({ action: "safety" });

        expect(parsed.success).toBe(false);
        const message = parsed.success ? "" : parsed.error.issues.map((i) => i.message).join(" ");
        expect(message).toContain("ensemblId is required");
    });

    it("rejects a 'target' whose ensemblId is blank", () => {
        expect(openTargetsTool.inputSchema.safeParse({ action: "target", ensemblId: "  " }).success).toBe(false);
    });

    it("rejects 'disease' with no efoId, naming the identifier it needs", () => {
        const parsed = openTargetsTool.inputSchema.safeParse({ action: "disease" });

        expect(parsed.success).toBe(false);
        const message = parsed.success ? "" : parsed.error.issues.map((i) => i.message).join(" ");
        expect(message).toContain("efoId is required");
        expect(message).toContain("EFO");
    });

    it("rejects a 'disease' that supplies only an ensemblId — the wrong identifier for the action", () => {
        expect(openTargetsTool.inputSchema.safeParse({ action: "disease", ensemblId: TP53 }).success).toBe(false);
    });

    it("accepts each action with its own identifier", () => {
        expect(openTargetsTool.inputSchema.safeParse({ action: "target", ensemblId: TP53 }).success).toBe(true);
        expect(openTargetsTool.inputSchema.safeParse({ action: "safety", ensemblId: TP53 }).success).toBe(true);
        expect(openTargetsTool.inputSchema.safeParse({ action: "disease", efoId: "EFO_0000311" }).success).toBe(true);
    });

    it("rejects an unknown action", () => {
        expect(openTargetsTool.inputSchema.safeParse({ action: "expression", ensemblId: TP53 }).success).toBe(false);
    });
});
