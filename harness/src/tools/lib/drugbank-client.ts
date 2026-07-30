/**
 * Pure async client functions for DrugBank.
 *
 * Requires a DrugBank API key; `getDrugbankHeaders` throws when it is absent.
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError } from "./api-utils.js";
import { DRUGBANK_BASE, getDrugbankHeaders } from "./drugbank-config.js";

/** Hard ceiling on each prose field at the parse boundary; callers trim further. */
const PROSE_CEILING = 500;

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
        description: (raw.description ?? "").slice(0, PROSE_CEILING),
        type: raw.type ?? "",
        groups: raw.groups ?? [],
        categories: (raw.categories ?? []).map((c) => c.category ?? "").filter(Boolean),
        indication: (raw.indication ?? "").slice(0, PROSE_CEILING),
        pharmacodynamics: (raw.pharmacodynamics ?? "").slice(0, PROSE_CEILING),
        mechanismOfAction: (raw.mechanism_of_action ?? "").slice(0, PROSE_CEILING),
        toxicity: (raw.toxicity ?? "").slice(0, PROSE_CEILING),
        halfLife: raw.half_life ?? "",
        targets: (raw.targets ?? []).map((t) => ({
            name: t.name ?? "",
            geneSymbol: t.gene_name ?? "",
            actions: t.actions ?? [],
            knownAction: t.known_action ?? "",
        })),
        interactions: (raw.drug_interactions ?? []).map((i) => ({
            drugbankId: i.drugbank_id ?? "",
            name: i.name ?? "",
            description: (i.description ?? "").slice(0, 200),
        })),
    }));

export type DrugResult = z.infer<typeof DrugResultSchema>;

// The /drugs endpoint returns a single object (by-id lookup) or an array
// (query/target lookups); accept either, transforming each element.
const DrugResponseSchema = z.union([DrugResultSchema, z.array(DrugResultSchema)]);

export async function searchDrugbank(apiKey: string, query: string, searchType: "drug" | "target", limit = 10): Promise<DrugResult[]> {
    const headers = getDrugbankHeaders(apiKey);

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
    return drugs.slice(0, limit);
}
