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

    it("forwards limit as the page size, and defaults it to 10 when omitted", async () => {
        const seen = stubOpenTargets(() => gqlResponse(TARGET_DATA));

        const { ctx } = makeToolContext();
        await openTargetsTool.execute({ action: "target", ensemblId: TP53, limit: 5 }, ctx);
        expect(seen[0]!.variables.size).toBe(5);

        // `execute` owns the default, so an omitted limit still pages at 10.
        await openTargetsTool.execute({ action: "target", ensemblId: TP53 }, ctx);
        expect(seen[1]!.variables.size).toBe(10);
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

describe("opentargets — action 'resolve_disease'", () => {
    it("turns a plain disease name into the ids the 'disease' action accepts", async () => {
        const seen = stubOpenTargets(() =>
            gqlResponse({
                search: {
                    total: 2,
                    hits: [
                        { id: "MONDO_0005148", name: "type 2 diabetes mellitus", description: "A type of diabetes mellitus." },
                        { id: "EFO_0004541", name: "HbA1c measurement", description: null },
                    ],
                },
            }),
        );

        const { ctx } = makeToolContext();
        const result = (await openTargetsTool.execute({ action: "resolve_disease", diseaseName: "type 2 diabetes", limit: 5 }, ctx))._unsafeUnwrap();

        expect(seen[0]!.operation).toBe("DiseaseSearch");
        expect(seen[0]!.variables).toMatchObject({ queryString: "type 2 diabetes", size: 5 });
        expect(result).toEqual({
            totalFound: 2,
            candidates: [
                { id: "MONDO_0005148", name: "type 2 diabetes mellitus", description: "A type of diabetes mellitus." },
                { id: "EFO_0004541", name: "HbA1c measurement", description: null },
            ],
        });
    });

    it("returns an empty candidate list for a name that matches no disease", async () => {
        stubOpenTargets(() => gqlResponse({ search: { total: 0, hits: [] } }));

        const { ctx } = makeToolContext();
        const result = (await openTargetsTool.execute({ action: "resolve_disease", diseaseName: "not a disease" }, ctx))._unsafeUnwrap();

        expect(result).toEqual({ totalFound: 0, candidates: [] });
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

    it("rejects the retired 'safety' action — it now lives in target_safety", () => {
        const parsed = openTargetsTool.inputSchema.safeParse({ action: "safety", ensemblId: TP53 });

        expect(parsed.success).toBe(false);
        const message = parsed.success ? "" : parsed.error.issues.map((i) => i.message).join(" ");
        expect(message).toContain('expected one of "target"|"disease"');
    });

    it("rejects a 'target' whose ensemblId is blank", () => {
        expect(openTargetsTool.inputSchema.safeParse({ action: "target", ensemblId: "  " }).success).toBe(false);
    });

    it("rejects 'resolve_disease' with no diseaseName", () => {
        const parsed = openTargetsTool.inputSchema.safeParse({ action: "resolve_disease" });

        expect(parsed.success).toBe(false);
        const message = parsed.success ? "" : parsed.error.issues.map((i) => i.message).join(" ");
        expect(message).toContain("diseaseName is required");
    });

    it("points a missing efoId at the resolver rather than leaving the caller stuck", () => {
        const parsed = openTargetsTool.inputSchema.safeParse({ action: "disease" });

        const message = parsed.success ? "" : parsed.error.issues.map((i) => i.message).join(" ");
        expect(message).toContain("resolve_disease");
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
        expect(openTargetsTool.inputSchema.safeParse({ action: "disease", efoId: "EFO_0000311" }).success).toBe(true);
    });

    it("rejects an unknown action", () => {
        expect(openTargetsTool.inputSchema.safeParse({ action: "expression", ensemblId: TP53 }).success).toBe(false);
    });
});
