/**
 * searchDisgenet — search DisGeNET for gene-disease associations (GDAs).
 *
 * Requires `DISGENET_API_KEY`. Without the key, `getDisgenetHeaders` throws
 * on first call; the harness surfaces that as a tool `is_error` envelope.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { apiFetch, describeApiError } from "../lib/api-utils.js";
import { DISGENET_BASE, getDisgenetHeaders } from "../lib/disgenet-config.js";

interface Gda {
    geneSymbol: string;
    geneName: string;
    geneId: number;
    diseaseName: string;
    diseaseId: string;
    diseaseType: string;
    score: number;
    evidenceIndex: number;
    yearInitial: number | null;
    yearFinal: number | null;
    nPmids: number;
    source: string;
}

interface RawGda {
    gene_symbol?: string;
    gene_name?: string;
    geneid?: number;
    disease_name?: string;
    diseaseid?: string;
    disease_type?: string;
    score?: number;
    ei?: number;
    year_initial?: number;
    year_final?: number;
    pmid_count?: number;
    source?: string;
}

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

            const res = await apiFetch<RawGda[]>(url, { headers });
            if (res.isErr()) throw new Error(describeApiError(res.error));

            const data = Array.isArray(res.value) ? res.value : [];
            const associations: Gda[] = data.map((gda) => ({
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

            return ok({ associations });
        },
    });
}
