/**
 * searchDrugbank — search DrugBank for drug records and target-driven lookups.
 *
 * Requires `DRUGBANK_API_KEY`. Without the key, `getDrugbankHeaders` throws
 * on first call; the harness surfaces that as a tool `is_error` envelope.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { apiFetch, describeApiError } from "../lib/api-utils.js";
import { DRUGBANK_BASE, getDrugbankHeaders } from "../lib/drugbank-config.js";

interface DrugResult {
    drugbankId: string;
    name: string;
    description: string;
    type: string;
    groups: string[];
    categories: string[];
    indication: string;
    pharmacodynamics: string;
    mechanismOfAction: string;
    toxicity: string;
    halfLife: string;
    targets: {
        name: string;
        geneSymbol: string;
        actions: string[];
        knownAction: string;
    }[];
    interactions: {
        drugbankId: string;
        name: string;
        description: string;
    }[];
}

interface RawDrug {
    drugbank_id?: string;
    name?: string;
    description?: string;
    type?: string;
    groups?: string[];
    categories?: { category?: string }[];
    indication?: string;
    pharmacodynamics?: string;
    mechanism_of_action?: string;
    toxicity?: string;
    half_life?: string;
    targets?: {
        name?: string;
        gene_name?: string;
        actions?: string[];
        known_action?: string;
    }[];
    drug_interactions?: {
        drugbank_id?: string;
        name?: string;
        description?: string;
    }[];
}

function mapDrug(raw: RawDrug): DrugResult {
    return {
        drugbankId: raw.drugbank_id ?? "",
        name: raw.name ?? "",
        description: (raw.description ?? "").slice(0, 500),
        type: raw.type ?? "",
        groups: raw.groups ?? [],
        categories: (raw.categories ?? []).map((c) => c.category ?? "").filter(Boolean),
        indication: (raw.indication ?? "").slice(0, 500),
        pharmacodynamics: (raw.pharmacodynamics ?? "").slice(0, 500),
        mechanismOfAction: (raw.mechanism_of_action ?? "").slice(0, 500),
        toxicity: (raw.toxicity ?? "").slice(0, 500),
        halfLife: raw.half_life ?? "",
        targets: (raw.targets ?? []).slice(0, 20).map((t) => ({
            name: t.name ?? "",
            geneSymbol: t.gene_name ?? "",
            actions: t.actions ?? [],
            knownAction: t.known_action ?? "",
        })),
        interactions: (raw.drug_interactions ?? []).slice(0, 20).map((i) => ({
            drugbankId: i.drugbank_id ?? "",
            name: i.name ?? "",
            description: (i.description ?? "").slice(0, 200),
        })),
    };
}

export function createSearchDrugbankTool(deps: { apiKey: string }) {
    return defineTool({
        id: "search_drugbank",
        description:
            "Search DrugBank for drug information including targets, interactions, indications, " +
            "pharmacodynamics, and toxicity. Requires DRUGBANK_API_KEY. Use for drug repurposing " +
            "analysis, drug-drug interaction assessment, and connecting omics targets to existing therapeutics.",
        inputSchema: z.object({
            query: z.string().describe("Drug name (e.g. imatinib), DrugBank ID (e.g. DB00619), or target gene symbol for reverse lookup"),
            searchType: z.enum(["drug", "target"]).default("drug").describe("'drug' to search by drug name/ID, 'target' to find drugs for a gene target"),
            limit: z.number().int().min(1).max(50).default(10).describe("Max results to return"),
        }),
        execute: async ({ query, searchType = "drug", limit = 10 }) => {
            const headers = getDrugbankHeaders(deps.apiKey);
            let url: string;

            if (searchType === "target") {
                url = `${DRUGBANK_BASE}/drugs?target=${encodeURIComponent(query)}&limit=${limit}`;
            } else if (query.startsWith("DB")) {
                url = `${DRUGBANK_BASE}/drugs/${query}`;
            } else {
                url = `${DRUGBANK_BASE}/drugs?q=${encodeURIComponent(query)}&limit=${limit}`;
            }

            const res = await apiFetch<RawDrug | RawDrug[]>(url, { headers });
            if (res.isErr()) throw new Error(describeApiError(res.error));

            const rawDrugs: RawDrug[] = Array.isArray(res.value) ? res.value : [res.value];

            return ok({
                drugs: rawDrugs.slice(0, limit).map(mapDrug),
            });
        },
    });
}
