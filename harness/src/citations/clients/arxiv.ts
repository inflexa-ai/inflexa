import type { CitationRecord, CitationSourceClient, CitationSourceOutcome, CitationSourceRequest } from "../types.js";
import { extractArxivId } from "../normalize.js";
import { createArxivSource, type ArxivPaper } from "../../literature/sources/arxiv.js";
import type { SourceHttpOptions } from "../../literature/sources/http.js";
import { parseYear, sourceOutcome } from "./common.js";

export type ArxivCitationClientOptions = SourceHttpOptions & {
    readonly maxCandidates?: number;
};

function arxivRecord(paper: ArxivPaper): CitationRecord {
    const year = parseYear(paper.published);
    const identifier = extractArxivId(paper.id) ?? paper.id.toLocaleLowerCase("en-US");
    return {
        source: "arxiv",
        sourceRecordId: paper.id,
        identifiers: { arxiv: identifier },
        title: paper.title,
        authors: paper.authors,
        year,
        venue: "arXiv",
        url: paper.url,
    };
}

export function createArxivCitationClient(options: ArxivCitationClientOptions = {}): CitationSourceClient {
    const source = createArxivSource(options);
    return {
        source: "arxiv",
        async resolve(request: CitationSourceRequest, signal?: AbortSignal): Promise<CitationSourceOutcome> {
            if (!request.plan.applicable) return sourceOutcome("arxiv", request.plan.operation, "not_applicable", 0, [], request.plan.reason);
            if (request.plan.operation === "arxiv_exact") {
                const arxivId = request.normalized.identifiers.arxiv;
                if (arxivId === undefined)
                    return sourceOutcome("arxiv", request.plan.operation, "unavailable", 0, [], "the exact plan carries no arXiv identifier");
                const result = await source.lookupExact(arxivId, options.maxCandidates ?? 5, signal);
                if (result.status !== "ok") return sourceOutcome("arxiv", request.plan.operation, result.status, 1, [], result.detail);
                const records = result.value.map(arxivRecord);
                return sourceOutcome("arxiv", request.plan.operation, records.length === 0 ? "no_data" : "ok", 1, records);
            }
            const result = await source.search({ query: request.input.title ?? request.input.citation, limit: options.maxCandidates ?? 5 }, signal);
            if (result.status !== "ok") return sourceOutcome("arxiv", request.plan.operation, result.status, 1, [], result.detail);
            const records = result.value.map(arxivRecord);
            return sourceOutcome("arxiv", request.plan.operation, records.length === 0 ? "no_data" : "ok", 1, records);
        },
    };
}
