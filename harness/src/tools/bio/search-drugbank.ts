/**
 * searchDrugbank — search DrugBank for drug records and target-driven lookups.
 *
 * Requires `DRUGBANK_API_KEY`. Without the key, `getDrugbankHeaders` throws
 * on first call; the harness surfaces that as a tool `is_error` envelope.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { apiFetchValidated, describeApiError } from "../lib/api-utils.js";
import { DRUGBANK_BASE, getDrugbankHeaders } from "../lib/drugbank-config.js";

// A single schema that both validates and normalizes one DrugBank record.
// The `.object(...)` half is the snake_case wire shape (every field optional —
// the API omits absent values); the `.transform(...)` half maps it into the
// camelCase result we return. Parsing IS the validation: `apiFetchValidated`
// runs this schema over the JSON, so a payload whose field TYPES drift (an
// object where the API used to send an array, a number for a string) is
// rejected as `invalid_response` instead of being silently mis-mapped. Because
// the schema carries the transform, `z.infer` below is the OUTPUT (camelCase)
// type callers receive — there is no separate raw interface or mapper to keep
// in sync.
const DrugResultSchema = z
    .object({
        drugbank_id: z.string().optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        type: z.string().optional(),
        groups: z.array(z.string()).optional(),
        categories: z.array(z.object({ category: z.string().optional() })).optional(),
        indication: z.string().optional(),
        pharmacodynamics: z.string().optional(),
        mechanism_of_action: z.string().optional(),
        toxicity: z.string().optional(),
        half_life: z.string().optional(),
        targets: z
            .array(
                z.object({
                    name: z.string().optional(),
                    gene_name: z.string().optional(),
                    actions: z.array(z.string()).optional(),
                    known_action: z.string().optional(),
                }),
            )
            .optional(),
        drug_interactions: z
            .array(
                z.object({
                    drugbank_id: z.string().optional(),
                    name: z.string().optional(),
                    description: z.string().optional(),
                }),
            )
            .optional(),
    })
    .transform((raw) => ({
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
    }));
type DrugResult = z.infer<typeof DrugResultSchema>;

// The /drugs endpoint returns a single object (by-id lookup) or an array
// (query/target lookups); accept either, transforming each element.
const DrugResponseSchema = z.union([DrugResultSchema, z.array(DrugResultSchema)]);

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

            const res = await apiFetchValidated(url, DrugResponseSchema, { headers });
            if (res.isErr()) throw new Error(describeApiError(res.error));

            // Already validated + normalized by DrugResultSchema's transform.
            const drugs: DrugResult[] = Array.isArray(res.value) ? res.value : [res.value];

            return ok({ drugs: drugs.slice(0, limit) });
        },
    });
}
