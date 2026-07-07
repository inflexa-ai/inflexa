/**
 * searchGeoDatasets — search NCBI GEO for public gene expression datasets.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { apiFetch, describeApiError } from "../lib/api-utils.js";

const ESEARCH_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

interface GeoEsearchResponse {
    esearchresult?: {
        idlist?: string[];
        count?: string;
    };
}

interface GeoDatasetSummary {
    accession?: string;
    gse?: string;
    title?: string;
    summary?: string;
    gpl?: string | null;
    platform?: string | null;
    n_samples?: string | number;
    taxon?: string | null;
    pubmedids?: (string | number)[];
}

interface GeoEsummaryResponse {
    result?: Record<string, GeoDatasetSummary | undefined>;
}

export const searchGeoDatasetsTool = defineTool({
    id: "search_geo_datasets",
    description:
        "Search NCBI GEO for public gene expression datasets by disease, tissue, or experimental condition. Returns dataset accessions and metadata for identifying external validation cohorts. Note: sandbox containers cannot download GEO data directly — use this tool to identify relevant datasets, then reference accessions in analysis plans.",
    inputSchema: z.object({
        query: z.string().describe("Search terms (e.g. 'breast cancer RNA-seq responder', 'NSCLC pembrolizumab')"),
        organism: z.string().optional().describe("Filter by organism (e.g. 'Homo sapiens')"),
        datasetType: z.enum(["gds", "gse"]).default("gse").describe("GDS (curated datasets) or GSE (series, more numerous)"),
        limit: z.number().int().min(1).max(50).default(15).describe("Max results"),
    }),
    execute: async ({ query, organism, datasetType = "gse", limit = 15 }) => {
        let searchQuery = query;
        if (organism) searchQuery += ` AND "${organism.replace(/"/g, '\\"')}"[Organism]`;

        const db = "gds";
        const typeFilter = datasetType === "gse" ? " AND gse[Entry Type]" : " AND gds[Entry Type]";
        searchQuery += typeFilter;

        const searchUrl = `${ESEARCH_BASE}/esearch.fcgi?db=${db}&term=${encodeURIComponent(searchQuery)}&retmax=${limit}&retmode=json`;
        const searchRes = await apiFetch<GeoEsearchResponse>(searchUrl);
        if (searchRes.isErr()) throw new Error(describeApiError(searchRes.error));

        const ids: string[] = searchRes.value?.esearchresult?.idlist ?? [];
        if (ids.length === 0) return ok({ totalFound: 0, datasets: [] });

        const summaryUrl = `${ESEARCH_BASE}/esummary.fcgi?db=${db}&id=${ids.join(",")}&retmode=json`;
        const summaryRes = await apiFetch<GeoEsummaryResponse>(summaryUrl);
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
