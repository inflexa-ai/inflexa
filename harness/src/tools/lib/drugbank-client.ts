/**
 * Pure async client functions for the DrugBank Discovery API.
 *
 * CONTRACT UNVERIFIED (key-blocked, 2026-08-28). No key exists here, and an
 * unauthenticated probe answers 401 before it routes, thus no live call proves
 * a route or a record. The evidence is secondary: the Wayback captures of
 * `docs.drugbank.com/discovery/v1` and the sample code of the provider. Refer to
 * the truth map, file 07, section 1.
 *
 * Requires a DrugBank API key; `getDrugbankHeaders` throws when it is absent.
 *
 * Absence policy: no evidence establishes the encoding of an absent value,
 * because no key exists for a live call and both fixtures are synthetic. Each
 * maybe-absent field carries `.optional()` today, and no field carries
 * `.nullable()`.
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError } from "./api-utils.js";
import { DRUGBANK_BASE, getDrugbankHeaders } from "./drugbank-config.js";

/** Hard ceiling on each prose field at the parse boundary; callers trim further. */
const PROSE_CEILING = 500;
/** The page ceiling of the `per_page` parameter. There is no `limit` parameter. */
const MAX_PER_PAGE = 50;

// A single schema that both validates and normalizes one Discovery drug record.
// The `.object(...)` half is the snake_case wire shape; the `.transform(...)`
// half maps it into the camelCase result we return. Parsing IS the validation:
// `apiFetchValidated` runs this schema over the JSON, so a payload whose field
// TYPES drift is rejected as `invalid_response` instead of being silently
// mis-mapped. Because the schema carries the transform, `z.infer` below is the
// OUTPUT (camelCase) type callers receive.
//
// `drugbank_id` is MANDATORY. It is the one key that every Discovery record
// carries, thus an error envelope such as `{"error":"Key invalid"}` fails the
// parse and the caller sees `invalid_response` rather than one blank drug row.
const DrugResultSchema = z
    .object({
        drugbank_id: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
        type: z.string().optional(),
        groups: z.array(z.string()).optional(),
    })
    .transform((raw) => ({
        drugbankId: raw.drugbank_id,
        name: raw.name ?? "",
        description: (raw.description ?? "").slice(0, PROSE_CEILING),
        type: raw.type ?? "",
        groups: raw.groups ?? [],
    }));

export type DrugResult = z.infer<typeof DrugResultSchema>;

// The Discovery API wraps nothing: a list route answers with a bare JSON array,
// and a lookup route answers with a bare object. Accept either, and transform
// each element.
export const DrugResponseSchema = z.union([DrugResultSchema, z.array(DrugResultSchema)]);

// One bond of `/bonds/targets`. The row names the drug that binds the target,
// thus a gene query reaches the drugs through the bonds. The bond carries no
// drug record beyond the id and the name.
export const BondResponseSchema = z.array(
    z.object({
        drug: z.object({ drugbank_id: z.string(), name: z.string().optional() }),
    }),
);

/** Translate the internal limit into the `per_page` of the provider. */
function perPageOf(limit: number): number {
    return Math.min(Math.max(limit, 1), MAX_PER_PAGE);
}

/** The drugs that bind a target, keyed by the gene name of its polypeptides. */
async function searchDrugbankByTarget(headers: Record<string, string>, gene: string, limit: number): Promise<DrugResult[]> {
    const query = encodeURIComponent(`polypeptides.gene_name:${gene}`);
    const url = `${DRUGBANK_BASE}/bonds/targets?q=${query}&per_page=${perPageOf(limit)}`;

    const res = await apiFetchValidated(url, BondResponseSchema, { headers });
    if (res.isErr()) throw new Error(describeApiError(res.error));

    // One drug binds a target through more than one bond, thus the rows repeat a
    // drug. The map keeps the first row of each drug.
    const drugs = new Map<string, DrugResult>();
    for (const bond of res.value) {
        if (drugs.has(bond.drug.drugbank_id)) continue;
        drugs.set(bond.drug.drugbank_id, {
            drugbankId: bond.drug.drugbank_id,
            name: bond.drug.name ?? "",
            description: "",
            type: "",
            groups: [],
        });
    }
    return [...drugs.values()].slice(0, limit);
}

export async function searchDrugbank(apiKey: string, query: string, searchType: "drug" | "target", limit = 10): Promise<DrugResult[]> {
    const headers = getDrugbankHeaders(apiKey);

    if (searchType === "target") return searchDrugbankByTarget(headers, query, limit);

    const url = query.startsWith("DB")
        ? `${DRUGBANK_BASE}/drugs/${encodeURIComponent(query)}`
        : `${DRUGBANK_BASE}/drugs?q=${encodeURIComponent(query)}&per_page=${perPageOf(limit)}`;

    const res = await apiFetchValidated(url, DrugResponseSchema, { headers });
    if (res.isErr()) throw new Error(describeApiError(res.error));

    // Already validated + normalized by DrugResultSchema's transform.
    const drugs: DrugResult[] = Array.isArray(res.value) ? res.value : [res.value];
    return drugs.slice(0, limit);
}
