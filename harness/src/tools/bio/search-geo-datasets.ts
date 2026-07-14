/**
 * searchGeoDatasets — search NCBI GEO for public gene expression datasets.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { apiFetchValidated, describeApiError } from "../lib/api-utils.js";

const ESEARCH_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

// NCBI E-utilities wire shapes, validated at the fetch boundary. Every field is
// optional because the API omits absent values; the mapping in `execute` keys
// off the esearch `idlist` (request context) and reshapes each summary, so the
// schemas model only the raw wire.
const GeoEsearchResponseSchema = z.object({
    esearchresult: z
        .object({
            idlist: z.array(z.string()).optional(),
            count: z.string().optional(),
        })
        .optional(),
});

const GeoDatasetSummarySchema = z.object({
    accession: z.string().optional(),
    gse: z.string().optional(),
    title: z.string().optional(),
    summary: z.string().optional(),
    gpl: z.string().nullable().optional(),
    platform: z.string().nullable().optional(),
    n_samples: z.union([z.string(), z.number()]).optional(),
    taxon: z.string().nullable().optional(),
    pubmedids: z.array(z.union([z.string(), z.number()])).optional(),
});
type GeoDatasetSummary = z.infer<typeof GeoDatasetSummarySchema>;

// The esummary `result` object mixes a `uids` string array in with the
// numeric-keyed dataset summaries; `.catch(undefined)` on the record value lets
// that `uids` entry (and any drifted summary) fall through as undefined rather
// than rejecting the whole response — the mapping reads only the numeric ids.
const GeoEsummaryResponseSchema = z.object({
    result: z.record(z.string(), GeoDatasetSummarySchema.optional().catch(undefined)).optional(),
});

export const searchGeoDatasetsTool = defineTool({
    id: "search_geo_datasets",
    description:
        "Search NCBI GEO for public gene-expression datasets by disease, tissue, or experimental condition — use it to find external validation cohorts or to cite published data. " +
        "Returns totalFound plus datasets[]: { accession (GSE…/GDS…), title, summary (truncated to 500 chars), platform, sampleCount, organism, pubmedIds }. " +
        "HARD CAVEAT: sandbox containers cannot download GEO data. This tool identifies and cites accessions only — never plan an analysis step that fetches a GEO dataset. " +
        "An empty datasets array is a valid 'nothing matched' — do not retry the identical query.",
    inputSchema: z.object({
        query: z
            .string()
            .describe("NCBI Entrez free-text query (e.g. 'breast cancer RNA-seq responder', 'NSCLC pembrolizumab'). Entrez field tags are allowed."),
        organism: z
            .string()
            .optional()
            .describe("Optional organism filter, appended as an [Organism] term. Use the scientific name, e.g. 'Homo sapiens', 'Mus musculus'."),
        datasetType: z
            .enum(["gds", "gse"])
            .default("gse")
            .describe(
                "'gse' (default) — GEO Series: raw submitter-deposited studies, far more numerous. 'gds' — curated DataSets: fewer, but normalized and value-added.",
            ),
        limit: z.number().int().min(1).max(50).default(15).describe("Max datasets to return (default 15, max 50)."),
    }),
    execute: async ({ query, organism, datasetType = "gse", limit = 15 }) => {
        let searchQuery = query;
        if (organism) searchQuery += ` AND "${organism.replace(/"/g, '\\"')}"[Organism]`;

        const db = "gds";
        const typeFilter = datasetType === "gse" ? " AND gse[Entry Type]" : " AND gds[Entry Type]";
        searchQuery += typeFilter;

        const searchUrl = `${ESEARCH_BASE}/esearch.fcgi?db=${db}&term=${encodeURIComponent(searchQuery)}&retmax=${limit}&retmode=json`;
        const searchRes = await apiFetchValidated(searchUrl, GeoEsearchResponseSchema);
        if (searchRes.isErr()) throw new Error(describeApiError(searchRes.error));

        const ids: string[] = searchRes.value?.esearchresult?.idlist ?? [];
        if (ids.length === 0) return ok({ totalFound: 0, datasets: [] });

        const summaryUrl = `${ESEARCH_BASE}/esummary.fcgi?db=${db}&id=${ids.join(",")}&retmode=json`;
        const summaryRes = await apiFetchValidated(summaryUrl, GeoEsummaryResponseSchema);
        if (summaryRes.isErr()) throw new Error(describeApiError(summaryRes.error));

        const result: Record<string, GeoDatasetSummary | undefined> = summaryRes.value?.result ?? {};
        const datasets = ids
            .map((id) => {
                const r = result[id];
                if (!r) return null;
                return {
                    accession: r.accession ?? r.gse ?? `GDS${id}`,
                    title: r.title ?? "",
                    summary: (r.summary ?? "").slice(0, 500),
                    platform: r.gpl ?? r.platform ?? null,
                    sampleCount: r.n_samples ? Number(r.n_samples) : null,
                    organism: r.taxon ?? null,
                    pubmedIds: r.pubmedids ?? [],
                };
            })
            .filter((d): d is NonNullable<typeof d> => d !== null);

        const totalFound = Number(searchRes.value?.esearchresult?.count) || datasets.length;

        return ok({ totalFound, datasets });
    },
});
