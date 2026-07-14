import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { ChemblOutput } from "./chembl.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import { chemblTool } from "./chembl.js";

const realFetch = globalThis.fetch;

/** Every URL the tool asked for, in call order — the record of which upstream endpoint an action reached. */
let requestedUrls: string[] = [];

beforeEach(() => {
    requestedUrls = [];
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

/**
 * Route ChEMBL requests by URL substring (first match wins). An unrouted URL
 * answers 404, which ChEMBL's client reads as an expected empty.
 */
function stubRoutes(routes: Array<[pattern: string, body: unknown]>): void {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        requestedUrls.push(url);
        for (const [pattern, body] of routes) {
            if (url.includes(pattern)) {
                return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
            }
        }
        return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
}

function stubStatus(status: number, body = "upstream said no"): void {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        requestedUrls.push(String(input));
        return new Response(body, { status });
    }) as unknown as typeof fetch;
}

type ChemblInput = Parameters<typeof chemblTool.execute>[0];

async function callChembl(input: ChemblInput): Promise<ChemblOutput> {
    const { ctx } = makeToolContext();
    return (await chemblTool.execute(input, ctx))._unsafeUnwrap();
}

type ResultKey = "compounds" | "drugs" | "mechanisms" | "activities" | "targets";
type RecordsFor<K extends ResultKey> = Extract<ChemblOutput, Record<K, unknown>> extends Record<K, infer R> ? R : never;

/** Read the action's result key, failing the test if the tool returned another action's shape. */
function resultKey<K extends ResultKey>(out: ChemblOutput, key: K): RecordsFor<K> {
    if (!(key in out)) throw new Error(`expected the '${key}' result shape, got ${JSON.stringify(out)}`);
    return (out as Record<K, RecordsFor<K>>)[key];
}

const EGFR_TARGET = {
    target_chembl_id: "CHEMBL203",
    pref_name: "Epidermal growth factor receptor erbB1",
    target_type: "SINGLE PROTEIN",
    organism: "Homo sapiens",
    target_components: [
        {
            accession: "P00533",
            target_component_synonyms: [{ syn_type: "GENE_SYMBOL", component_synonym: "EGFR" }],
        },
    ],
};

const ASPIRIN_MOLECULE = {
    molecule_chembl_id: "CHEMBL25",
    pref_name: "ASPIRIN",
    molecule_structures: { canonical_smiles: "CC(=O)Oc1ccccc1C(=O)O" },
    molecule_properties: { full_mwt: "180.16", alogp: "1.31", molecular_formula: "C9H8O4" },
};

describe("chembl — action: targets", () => {
    it("returns a populated targets list for a found query", async () => {
        stubRoutes([["/target/search.json", { targets: [EGFR_TARGET] }]]);

        const targets = resultKey(await callChembl({ action: "targets", query: "EGFR", limit: 25 }), "targets");

        expect(targets).toHaveLength(1);
        expect(targets[0]!.targetChemblId).toBe("CHEMBL203");
        expect(targets[0]!.geneNames).toEqual(["EGFR"]);
        expect(targets[0]!.organism).toBe("Homo sapiens");
        expect(requestedUrls[0]).toContain("/target/search.json?q=EGFR&limit=25");
    });

    it("defaults the limit to 25", async () => {
        stubRoutes([["/target/search.json", { targets: [EGFR_TARGET] }]]);

        await callChembl({ action: "targets", query: "EGFR" });

        expect(requestedUrls[0]).toContain("limit=25");
    });

    it("returns an empty targets list when ChEMBL responds 404 (not is_error)", async () => {
        stubStatus(404, "not found");

        const out = await callChembl({ action: "targets", query: "NOTATARGET", limit: 25 });

        expect(resultKey(out, "targets")).toEqual([]);
    });

    it("throws on an upstream 5xx failure", async () => {
        stubStatus(500, "upstream down");

        const { ctx } = makeToolContext();
        await expect(chemblTool.execute({ action: "targets", query: "EGFR", limit: 25 }, ctx)).rejects.toThrow();
    });
});

describe("chembl — action: compounds", () => {
    it("searches molecule names for searchType='compound'", async () => {
        stubRoutes([["/molecule/search.json", { molecules: [ASPIRIN_MOLECULE] }]]);

        const compounds = resultKey(await callChembl({ action: "compounds", query: "aspirin", searchType: "compound" }), "compounds");

        expect(compounds).toEqual([
            {
                chemblId: "CHEMBL25",
                preferredCompoundName: "ASPIRIN",
                canonicalSmiles: "CC(=O)Oc1ccccc1C(=O)O",
                molecularWeight: 180.16,
                alogp: 1.31,
                molecularFormula: "C9H8O4",
            },
        ]);
        expect(requestedUrls[0]).toContain("/molecule/search.json?q=aspirin&limit=500");
    });

    it("flexmatches canonical SMILES for searchType='smiles'", async () => {
        stubRoutes([["/molecule.json?", { molecules: [ASPIRIN_MOLECULE] }]]);

        const compounds = resultKey(await callChembl({ action: "compounds", query: "CC(=O)Oc1ccccc1C(=O)O", searchType: "smiles", limit: 10 }), "compounds");

        expect(compounds).toHaveLength(1);
        expect(compounds[0]!.chemblId).toBe("CHEMBL25");
        expect(requestedUrls[0]).toContain("molecule_structures__canonical_smiles__flexmatch=");
        expect(requestedUrls[0]).toContain("limit=10");
    });

    it("resolves target → activities → unique molecules for searchType='target'", async () => {
        stubRoutes([
            ["/target/search.json", { targets: [{ target_chembl_id: "CHEMBL203" }] }],
            [
                "/activity.json",
                {
                    activities: [{ molecule_chembl_id: "CHEMBL25" }, { molecule_chembl_id: "CHEMBL941" }, { molecule_chembl_id: "CHEMBL25" }],
                },
            ],
            ["/molecule/set/", { molecules: [ASPIRIN_MOLECULE, { molecule_chembl_id: "CHEMBL941", pref_name: "IMATINIB" }] }],
        ]);

        const compounds = resultKey(await callChembl({ action: "compounds", query: "EGFR", searchType: "target", limit: 500 }), "compounds");

        expect(compounds.map((c) => c.chemblId)).toEqual(["CHEMBL25", "CHEMBL941"]);
        // A biologic with no structures/properties block still parses.
        expect(compounds[1]!.canonicalSmiles).toBeNull();
        expect(compounds[1]!.molecularWeight).toBeNull();
        expect(requestedUrls[0]).toContain("/target/search.json?q=EGFR&limit=1");
        expect(requestedUrls[1]).toContain("/activity.json?target_chembl_id=CHEMBL203&limit=500");
        // The duplicate molecule id is fetched once.
        expect(requestedUrls[2]).toContain("/molecule/set/CHEMBL25;CHEMBL941.json");
    });

    it("returns an empty compounds list when the target does not resolve", async () => {
        stubRoutes([["/target/search.json", { targets: [] }]]);

        const out = await callChembl({ action: "compounds", query: "NOTATARGET", searchType: "target" });

        expect(resultKey(out, "compounds")).toEqual([]);
    });
});

describe("chembl — action: drug", () => {
    it("returns drug registry rows with indications", async () => {
        stubRoutes([
            [
                "/drug/search.json",
                {
                    drugs: [
                        {
                            molecule_chembl_id: "CHEMBL941",
                            pref_name: "IMATINIB",
                            max_phase: 4,
                            molecule_type: "Small molecule",
                            first_approval: 2001,
                            drug_indications: [
                                { mesh_heading: "Leukemia, Myelogenous, Chronic, BCR-ABL Positive" },
                                { efo_term: "gastrointestinal stromal tumor" },
                            ],
                        },
                    ],
                },
            ],
        ]);

        const drugs = resultKey(await callChembl({ action: "drug", query: "imatinib" }), "drugs");

        expect(drugs).toHaveLength(1);
        expect(drugs[0]!.moleculeChemblId).toBe("CHEMBL941");
        expect(drugs[0]!.maxPhase).toBe(4);
        expect(drugs[0]!.firstApproval).toBe(2001);
        expect(drugs[0]!.indication).toBe("Leukemia, Myelogenous, Chronic, BCR-ABL Positive; gastrointestinal stromal tumor");
        expect(requestedUrls[0]).toContain("/drug/search.json?q=imatinib&limit=25");
    });

    it("falls back to an approved-molecule search (indication: null) when the drug endpoint is empty", async () => {
        stubRoutes([
            ["/drug/search.json", { drugs: [] }],
            [
                "/molecule/search.json",
                {
                    molecules: [
                        { molecule_chembl_id: "CHEMBL25", pref_name: "ASPIRIN", max_phase: 4, molecule_type: "Small molecule" },
                        { molecule_chembl_id: "CHEMBL999", pref_name: "TOOL COMPOUND", max_phase: 1 },
                    ],
                },
            ],
        ]);

        const drugs = resultKey(await callChembl({ action: "drug", query: "aspirin", limit: 25 }), "drugs");

        // Only max_phase >= 4 survives the fallback filter.
        expect(drugs).toHaveLength(1);
        expect(drugs[0]!.moleculeChemblId).toBe("CHEMBL25");
        expect(drugs[0]!.indication).toBeNull();
        expect(requestedUrls[1]).toContain("/molecule/search.json?q=aspirin&limit=25");
    });
});

describe("chembl — action: mechanism", () => {
    it("returns mechanisms with the target name resolved", async () => {
        stubRoutes([
            [
                "/mechanism.json",
                {
                    mechanisms: [
                        {
                            mechanism_of_action: "Cyclooxygenase inhibitor",
                            action_type: "INHIBITOR",
                            target_chembl_id: "CHEMBL203",
                            molecule_chembl_id: "CHEMBL25",
                        },
                    ],
                },
            ],
            ["/target/CHEMBL203.json", { pref_name: "Cyclooxygenase-1" }],
        ]);

        const mechanisms = resultKey(await callChembl({ action: "mechanism", chemblId: "CHEMBL25" }), "mechanisms");

        expect(mechanisms).toEqual([
            {
                mechanismOfAction: "Cyclooxygenase inhibitor",
                actionType: "INHIBITOR",
                targetChemblId: "CHEMBL203",
                targetName: "Cyclooxygenase-1",
                moleculeChemblId: "CHEMBL25",
            },
        ]);
        expect(requestedUrls[0]).toContain("/mechanism.json?molecule_chembl_id=CHEMBL25");
    });

    it("returns an empty mechanisms list for a compound ChEMBL curates no mechanism for", async () => {
        stubRoutes([["/mechanism.json", { mechanisms: [] }]]);

        const out = await callChembl({ action: "mechanism", chemblId: "CHEMBL999" });

        expect(resultKey(out, "mechanisms")).toEqual([]);
    });
});

describe("chembl — action: bioactivity", () => {
    const ACTIVITY_ROWS = {
        activities: [
            {
                activity_id: 31863,
                molecule_chembl_id: "CHEMBL25",
                target_chembl_id: "CHEMBL203",
                standard_type: "IC50",
                standard_value: "12.5",
                standard_units: "nM",
                assay_chembl_id: "CHEMBL829584",
                assay_type: "B",
                pchembl_value: "7.9",
            },
        ],
    };

    it("indexes the molecule side for idType='compound' and applies the activityType filter", async () => {
        stubRoutes([["/activity.json", ACTIVITY_ROWS]]);

        const activities = resultKey(
            await callChembl({ action: "bioactivity", chemblId: "CHEMBL25", idType: "compound", activityType: "IC50", limit: 500 }),
            "activities",
        );

        expect(activities).toHaveLength(1);
        expect(activities[0]!.standardType).toBe("IC50");
        expect(activities[0]!.standardValue).toBe(12.5);
        expect(activities[0]!.pchemblValue).toBe(7.9);
        expect(activities[0]!.compoundChemblId).toBe("CHEMBL25");
        expect(requestedUrls[0]).toContain("/activity.json?molecule_chembl_id=CHEMBL25&limit=500&standard_type=IC50");
    });

    it("indexes the target side for idType='target'", async () => {
        stubRoutes([["/activity.json", ACTIVITY_ROWS]]);

        const activities = resultKey(await callChembl({ action: "bioactivity", chemblId: "CHEMBL203", idType: "target" }), "activities");

        expect(activities[0]!.targetChemblId).toBe("CHEMBL203");
        expect(requestedUrls[0]).toContain("/activity.json?target_chembl_id=CHEMBL203&limit=500");
        expect(requestedUrls[0]).not.toContain("standard_type=");
    });

    it("returns an empty activities list when ChEMBL responds 404 (not is_error)", async () => {
        stubStatus(404, "not found");

        const out = await callChembl({ action: "bioactivity", chemblId: "CHEMBL999", idType: "compound" });

        expect(resultKey(out, "activities")).toEqual([]);
    });
});

describe("chembl — input guards", () => {
    /** The loop validates a tool call against `inputSchema` before `execute` runs (run-agent dispatchTool). */
    function issues(input: unknown): string[] {
        const parsed = chemblTool.inputSchema.safeParse(input);
        if (parsed.success) return [];
        return parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    }

    it("rejects mechanism with no chemblId, naming how to resolve one", () => {
        const messages = issues({ action: "mechanism" });

        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain("chemblId:");
        expect(messages[0]).toContain("required when action is 'mechanism' or 'bioactivity'");
        expect(messages[0]).toContain("action='targets'");
    });

    it("rejects bioactivity with a chemblId but no idType", () => {
        const messages = issues({ action: "bioactivity", chemblId: "CHEMBL25" });

        expect(messages).toEqual([
            "idType: idType is required when action is 'bioactivity' — 'compound' if chemblId is a molecule ID, 'target' if it is a target ID",
        ]);
    });

    it("rejects bioactivity with no chemblId at all", () => {
        expect(issues({ action: "bioactivity", idType: "compound" })[0]).toContain("chemblId:");
    });

    it("rejects compounds with no searchType", () => {
        const messages = issues({ action: "compounds", query: "aspirin" });

        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain("searchType:");
        expect(messages[0]).toContain("required when action is 'compounds'");
    });

    it("rejects a query-taking action with no query", () => {
        for (const action of ["compounds", "drug", "targets"]) {
            const messages = issues({ action, searchType: "compound" });
            expect(messages.some((m) => m.startsWith("query:"))).toBe(true);
        }
    });

    it("holds drug and targets to their 25-record cap", () => {
        expect(issues({ action: "targets", query: "EGFR", limit: 100 })[0]).toContain("limit is capped at 25");
        expect(issues({ action: "drug", query: "imatinib", limit: 26 })[0]).toContain("limit is capped at 25");
        expect(issues({ action: "targets", query: "EGFR", limit: 25 })).toEqual([]);
    });

    it("lets compounds and bioactivity reach the 500-record cap", () => {
        expect(issues({ action: "compounds", query: "aspirin", searchType: "compound", limit: 500 })).toEqual([]);
        expect(issues({ action: "bioactivity", chemblId: "CHEMBL25", idType: "compound", limit: 500 })).toEqual([]);
        expect(issues({ action: "compounds", query: "aspirin", searchType: "compound", limit: 501 })[0]).toContain("limit:");
    });

    it("accepts each action's minimal well-formed call", () => {
        expect(issues({ action: "compounds", query: "aspirin", searchType: "compound" })).toEqual([]);
        expect(issues({ action: "drug", query: "imatinib" })).toEqual([]);
        expect(issues({ action: "mechanism", chemblId: "CHEMBL25" })).toEqual([]);
        expect(issues({ action: "bioactivity", chemblId: "CHEMBL25", idType: "target" })).toEqual([]);
        expect(issues({ action: "targets", query: "EGFR" })).toEqual([]);
    });
});
