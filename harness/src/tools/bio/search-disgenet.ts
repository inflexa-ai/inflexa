/**
 * searchDisgenet — search DisGeNET for gene-disease associations (GDAs).
 *
 * Requires `DISGENET_API_KEY`. Without the key, `getDisgenetHeaders` throws
 * on first call; the harness surfaces that as a tool `is_error` envelope.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { apiFetchValidated, describeApiError } from "../lib/api-utils.js";
import { DISGENET_BASE, getDisgenetHeaders } from "../lib/disgenet-config.js";

// A single schema that both validates and normalizes one DisGeNET GDA record:
// the `.object(...)` half is the snake_case wire shape (every field optional —
// the API omits absent values), the `.transform(...)` half maps it to the
// camelCase `Gda` we return. Parsing IS the validation (`apiFetchValidated`
// runs it over the JSON), and because the transform rides on the schema,
// `z.infer` below is the OUTPUT type — no separate raw interface or mapper.
const GdaSchema = z
    .object({
        gene_symbol: z.string().optional(),
        gene_name: z.string().optional(),
        geneid: z.number().optional(),
        disease_name: z.string().optional(),
        diseaseid: z.string().optional(),
        disease_type: z.string().optional(),
        score: z.number().optional(),
        ei: z.number().optional(),
        year_initial: z.number().optional(),
        year_final: z.number().optional(),
        pmid_count: z.number().optional(),
        source: z.string().optional(),
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
type Gda = z.infer<typeof GdaSchema>;
const GdaListSchema = z.array(GdaSchema);

export function createSearchDisgenetTool(deps: { apiKey: string }) {
    return defineTool({
        id: "search_disgenet",
        description:
            "Search DisGeNET for gene-disease associations (GDAs). Returns association scores, " +
            "evidence counts, and disease classifications. Requires DISGENET_API_KEY. " +
            "Use for target validation — high-scoring GDAs provide genetic support for a " +
            "therapeutic target's disease relevance.",
        inputSchema: z.object({
            query: z.string().describe("Gene symbol (e.g. TP53), Entrez gene ID (e.g. 7157), or disease name/UMLS CUI (e.g. C0006142 for breast cancer)"),
            searchType: z.enum(["gene", "disease"]).describe("'gene' to find diseases for a gene, 'disease' to find genes for a disease"),
            minScore: z.number().min(0).max(1).default(0.1).describe("Minimum GDA score (0–1). Higher = stronger evidence"),
            source: z.enum(["ALL", "CURATED", "ANIMAL_MODELS", "BEFREE"]).default("ALL").describe("Evidence source filter"),
            limit: z.number().int().min(1).max(100).default(25).describe("Max results to return"),
        }),
        execute: async ({ query, searchType, minScore = 0.1, source = "ALL", limit = 25 }) => {
            const headers = getDisgenetHeaders(deps.apiKey);
            let url: string;

            if (searchType === "gene") {
                const isNumeric = /^\d+$/.test(query);
                const param = isNumeric ? `gene/${query}` : `gene/${encodeURIComponent(query)}`;
                url = `${DISGENET_BASE}/gda/${param}?min_score=${minScore}&limit=${limit}`;
            } else {
                url = `${DISGENET_BASE}/gda/disease/${encodeURIComponent(query)}?min_score=${minScore}&limit=${limit}`;
            }

            if (source !== "ALL") {
                url += `&source=${source}`;
            }

            const res = await apiFetchValidated(url, GdaListSchema, { headers });
            if (res.isErr()) throw new Error(describeApiError(res.error));

            // Already validated + normalized to camelCase by GdaSchema's transform.
            const associations: Gda[] = res.value;

            return ok({ associations });
        },
    });
}
