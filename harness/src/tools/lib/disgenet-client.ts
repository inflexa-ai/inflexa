/**
 * Pure async client functions for DisGeNET gene-disease associations (GDAs).
 *
 * Requires a DisGeNET API key; `getDisgenetHeaders` throws when it is absent.
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError } from "./api-utils.js";
import { DISGENET_BASE, getDisgenetHeaders } from "./disgenet-config.js";

// A single schema that both validates and normalizes one DisGeNET GDA record:
// the `.object(...)` half is the snake_case wire shape (every field optional —
// the API omits absent values), the `.transform(...)` half maps it to the
// camelCase `Gda` we return. Parsing IS the validation (`apiFetchValidated`
// runs it over the JSON), and because the transform rides on the schema,
// `z.infer` below is the OUTPUT type — no separate raw interface or mapper.
const GdaSchema = z
    .object({
        gene_symbol: z.string().nullable().optional(),
        gene_name: z.string().nullable().optional(),
        geneid: z.number().nullable().optional(),
        disease_name: z.string().nullable().optional(),
        diseaseid: z.string().nullable().optional(),
        disease_type: z.string().nullable().optional(),
        score: z.number().nullable().optional(),
        ei: z.number().nullable().optional(),
        year_initial: z.number().nullable().optional(),
        year_final: z.number().nullable().optional(),
        pmid_count: z.number().nullable().optional(),
        source: z.string().nullable().optional(),
    })
    .transform((gda) => ({
        geneSymbol: gda.gene_symbol ?? "",
        geneName: gda.gene_name ?? "",
        geneId: gda.geneid ?? 0,
        diseaseName: gda.disease_name ?? "",
        diseaseId: gda.diseaseid ?? "",
        diseaseType: gda.disease_type ?? "",
        score: gda.score ?? 0,
        evidenceIndex: gda.ei ?? 0,
        yearInitial: gda.year_initial ?? null,
        yearFinal: gda.year_final ?? null,
        nPmids: gda.pmid_count ?? 0,
        source: gda.source ?? "",
    }));

export type Gda = z.infer<typeof GdaSchema>;
const GdaListSchema = z.array(GdaSchema);

export type DisgenetSearchType = "gene" | "disease";
export type DisgenetSource = "ALL" | "CURATED" | "ANIMAL_MODELS" | "BEFREE";

export interface DisgenetSearchOptions {
    minScore?: number;
    source?: DisgenetSource;
    limit?: number;
}

export async function searchDisgenet(apiKey: string, query: string, searchType: DisgenetSearchType, options: DisgenetSearchOptions = {}): Promise<Gda[]> {
    const headers = getDisgenetHeaders(apiKey);
    const minScore = options.minScore ?? 0.1;
    const limit = options.limit ?? 25;
    const source = options.source ?? "ALL";

    const path = searchType === "gene" ? `gene/${encodeURIComponent(query)}` : `disease/${encodeURIComponent(query)}`;
    let url = `${DISGENET_BASE}/gda/${path}?min_score=${minScore}&limit=${limit}`;
    if (source !== "ALL") url += `&source=${source}`;

    const res = await apiFetchValidated(url, GdaListSchema, { headers });
    if (res.isErr()) throw new Error(describeApiError(res.error));

    // Already validated + normalized to camelCase by GdaSchema's transform.
    return res.value;
}
