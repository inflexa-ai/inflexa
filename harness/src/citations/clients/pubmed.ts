import type { CitationRecord, CitationSourceClient, CitationSourceOutcome, CitationSourceRequest } from "../types.js";
import { createPubmedSource, type ArticleDetail, type PubmedSourceOptions } from "../../literature/sources/pubmed.js";
import { parseYear, sourceOutcome } from "./common.js";

export interface PubmedCitationClientOptions extends PubmedSourceOptions {
    readonly maxCandidates?: number;
}

function pubmedRecord(article: ArticleDetail): CitationRecord {
    const year = parseYear(article.year);
    return {
        source: "pubmed",
        sourceRecordId: article.pmid,
        identifiers: { pmid: article.pmid, ...(article.doi ? { doi: article.doi.toLocaleLowerCase("en-US") } : {}) },
        ...(article.title ? { title: article.title } : {}),
        ...(article.authors.length === 0 ? {} : { authors: article.authors }),
        ...(year === undefined ? {} : { year }),
        ...(article.journal ? { venue: article.journal } : {}),
        url: `https://pubmed.ncbi.nlm.nih.gov/${article.pmid}/`,
    };
}

export function createPubmedCitationClient(options: PubmedCitationClientOptions = {}): CitationSourceClient {
    const source = createPubmedSource(options);

    async function resolve(request: CitationSourceRequest, signal?: AbortSignal): Promise<CitationSourceOutcome> {
        if (!request.plan.applicable) return sourceOutcome("pubmed", request.plan.operation, "not_applicable", 0, [], request.plan.reason);
        let requestCount = 0;
        let pmids: string[];

        if (request.plan.operation === "pubmed_exact") {
            pmids = [request.normalized.identifiers.pmid!];
        } else if (request.plan.operation === "pubmed_structured") {
            requestCount += 1;
            const match = await source.matchCitation(
                {
                    ...(request.input.venue === undefined ? {} : { venue: request.input.venue }),
                    ...(request.input.year === undefined ? {} : { year: request.input.year }),
                    ...(request.input.volume === undefined ? {} : { volume: request.input.volume }),
                    ...(request.input.firstPage === undefined ? {} : { firstPage: request.input.firstPage }),
                    ...(request.input.authors?.[0] === undefined ? {} : { firstAuthor: request.input.authors[0] }),
                    key: "citation-0",
                },
                signal,
            );
            if (match.status !== "ok") return sourceOutcome("pubmed", request.plan.operation, match.status, requestCount, [], match.detail);
            pmids = match.value;
        } else {
            requestCount += 1;
            const term = request.plan.operation === "pubmed_doi" ? `${request.normalized.identifiers.doi}[AID]` : `${request.input.title ?? ""}[Title]`;
            const search = await source.searchIds(term, options.maxCandidates ?? 5, signal);
            if (search.status !== "ok") return sourceOutcome("pubmed", request.plan.operation, search.status, requestCount, [], search.detail);
            pmids = search.value;
        }

        if (pmids.length === 0) return sourceOutcome("pubmed", request.plan.operation, "no_data", requestCount);
        requestCount += 1;
        const fetched = await source.fetchArticles(pmids, signal);
        if (fetched.status !== "ok") return sourceOutcome("pubmed", request.plan.operation, fetched.status, requestCount, [], fetched.detail);
        const records = fetched.value.map(pubmedRecord);
        return sourceOutcome("pubmed", request.plan.operation, records.length === 0 ? "no_data" : "ok", requestCount, records);
    }

    async function resolveMany(requests: readonly CitationSourceRequest[], signal?: AbortSignal): Promise<CitationSourceOutcome[]> {
        const results: Array<CitationSourceOutcome | undefined> = Array.from({ length: requests.length });
        const exact = requests.flatMap((request, index) =>
            request.plan.applicable && request.plan.operation === "pubmed_exact" && request.normalized.identifiers.pmid !== undefined
                ? [{ index, request, pmid: request.normalized.identifiers.pmid }]
                : [],
        );
        for (let offset = 0; offset < exact.length; offset += 20) {
            const chunk = exact.slice(offset, offset + 20);
            const fetched = await source.fetchArticles(
                chunk.map(({ pmid }) => pmid),
                signal,
            );
            if (fetched.status !== "ok") {
                for (const entry of chunk) results[entry.index] = sourceOutcome("pubmed", entry.request.plan.operation, fetched.status, 1, [], fetched.detail);
                continue;
            }
            const byPmid = new Map(fetched.value.map((article) => [article.pmid, pubmedRecord(article)]));
            for (const entry of chunk) {
                const record = byPmid.get(entry.pmid);
                results[entry.index] = sourceOutcome(
                    "pubmed",
                    entry.request.plan.operation,
                    record === undefined ? "no_data" : "ok",
                    1,
                    record === undefined ? [] : [record],
                );
            }
        }
        await Promise.all(
            requests.map(async (request, index) => {
                if (results[index] === undefined) results[index] = await resolve(request, signal);
            }),
        );
        return results.map((result) => result!);
    }

    return { source: "pubmed", resolve, resolveMany };
}
