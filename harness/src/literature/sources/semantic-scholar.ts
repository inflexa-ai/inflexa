import { z } from "zod";

import { requestJson, type SourceHttpOptions, type SourceHttpResult } from "./http.js";

const BASE_URL = "https://api.semanticscholar.org/graph/v1";
const FIELDS = "paperId,title,abstract,year,venue,citationCount,url,authors,externalIds";

const WirePaperSchema = z
    .object({
        paperId: z.string().optional(),
        title: z.string().nullable().optional(),
        abstract: z.string().nullable().optional(),
        year: z.number().nullable().optional(),
        venue: z.string().nullable().optional(),
        citationCount: z.number().nullable().optional(),
        url: z.string().nullable().optional(),
        authors: z.array(z.object({ name: z.string().nullable().optional() })).optional(),
        externalIds: z.record(z.string(), z.unknown()).nullable().optional(),
    })
    .passthrough();
const ExactPaperSchema = WirePaperSchema.extend({ paperId: z.string() });
const SearchResponseSchema = z.object({ data: z.array(WirePaperSchema).optional() });

export interface SemanticScholarPaper {
    id: string;
    title?: string;
    abstract?: string;
    year?: number;
    venue?: string;
    citationCount?: number;
    url?: string;
    authors: string[];
    externalIds?: Record<string, string>;
}

export interface SemanticScholarSearchPaper extends SemanticScholarPaper {
    title: string;
}

export interface SemanticScholarSourceOptions extends SourceHttpOptions {
    readonly apiKey?: string;
}

export interface SemanticScholarSource {
    search(query: string, limit: number, signal?: AbortSignal): Promise<SourceHttpResult<SemanticScholarSearchPaper[]>>;
    lookupIdentifier(identifier: string, signal?: AbortSignal): Promise<SourceHttpResult<SemanticScholarPaper>>;
}

function stringExternalIds(value: Record<string, unknown> | null | undefined): Record<string, string> | undefined {
    if (value === null || value === undefined) return undefined;
    const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
    return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function mapPaper(raw: z.infer<typeof WirePaperSchema>): SemanticScholarPaper | undefined {
    if (raw.paperId === undefined || raw.paperId.trim() === "") return undefined;
    const authors = raw.authors?.flatMap((author) => (typeof author.name === "string" && author.name.trim() ? [author.name] : [])) ?? [];
    const externalIds = stringExternalIds(raw.externalIds);
    return {
        id: raw.paperId,
        ...(typeof raw.title === "string" ? { title: raw.title } : {}),
        ...(typeof raw.abstract === "string" ? { abstract: raw.abstract } : {}),
        ...(typeof raw.year === "number" ? { year: raw.year } : {}),
        ...(typeof raw.venue === "string" ? { venue: raw.venue } : {}),
        ...(typeof raw.citationCount === "number" ? { citationCount: raw.citationCount } : {}),
        ...(typeof raw.url === "string" ? { url: raw.url } : {}),
        authors,
        ...(externalIds === undefined ? {} : { externalIds }),
    };
}

export function parseSemanticScholarResponse(raw: unknown): SemanticScholarSearchPaper[] {
    const parsed = SearchResponseSchema.safeParse(raw);
    if (!parsed.success) return [];
    return (parsed.data.data ?? []).flatMap((paper) => {
        const mapped = mapPaper(paper);
        return mapped?.title === undefined ? [] : [mapped as SemanticScholarSearchPaper];
    });
}

export function createSemanticScholarSource(options: SemanticScholarSourceOptions = {}): SemanticScholarSource {
    const headers: Record<string, string> = options.apiKey === undefined ? {} : { "x-api-key": options.apiKey };
    return {
        async search(query, limit, signal) {
            const params = new URLSearchParams({ query, limit: String(limit), fields: FIELDS });
            const result = await requestJson(`${BASE_URL}/paper/search?${params}`, SearchResponseSchema, options, signal, { headers });
            if (result.status !== "ok") return result;
            return { status: "ok", value: parseSemanticScholarResponse(result.value) };
        },
        async lookupIdentifier(identifier, signal) {
            const url = `${BASE_URL}/paper/${encodeURIComponent(identifier)}?fields=${encodeURIComponent(FIELDS)}`;
            const result = await requestJson(url, ExactPaperSchema, options, signal, { headers });
            if (result.status !== "ok") return result;
            const paper = mapPaper(result.value);
            return paper === undefined ? { status: "unavailable", detail: "response schema mismatch: missing paperId" } : { status: "ok", value: paper };
        },
    };
}
