import type { CitationRecord, CitationSourceClient, CitationSourceOutcome, CitationSourceRequest } from "../types.js";
import { createSemanticScholarSource, type SemanticScholarPaper, type SemanticScholarSourceOptions } from "../../literature/sources/semantic-scholar.js";
import { firstNonEmpty, sourceOutcome } from "./common.js";

export interface SemanticScholarCitationClientOptions extends SemanticScholarSourceOptions {
    readonly maxCandidates?: number;
}

function externalId(value: Record<string, string> | undefined, key: string): string | undefined {
    const found = value?.[key];
    return found?.trim() ? found.trim() : undefined;
}

function semanticRecord(paper: SemanticScholarPaper): CitationRecord {
    const doi = externalId(paper.externalIds, "DOI")?.toLocaleLowerCase("en-US");
    const pmid = externalId(paper.externalIds, "PubMed");
    const arxiv = externalId(paper.externalIds, "ArXiv")?.toLocaleLowerCase("en-US");
    const corpusId = firstNonEmpty([externalId(paper.externalIds, "CorpusId"), paper.id]);
    return {
        source: "semantic_scholar",
        sourceRecordId: paper.id,
        identifiers: {
            ...(doi === undefined ? {} : { doi }),
            ...(pmid === undefined ? {} : { pmid }),
            ...(arxiv === undefined ? {} : { arxiv }),
            ...(corpusId === undefined ? {} : { corpusId }),
        },
        ...(paper.title === undefined ? {} : { title: paper.title }),
        ...(paper.authors.length === 0 ? {} : { authors: paper.authors }),
        ...(paper.year === undefined ? {} : { year: paper.year }),
        ...(paper.venue === undefined ? {} : { venue: paper.venue }),
        ...(paper.url === undefined ? {} : { url: paper.url }),
    };
}

export function createSemanticScholarCitationClient(options: SemanticScholarCitationClientOptions = {}): CitationSourceClient {
    const source = createSemanticScholarSource(options);
    return {
        source: "semantic_scholar",
        async resolve(request: CitationSourceRequest, signal?: AbortSignal): Promise<CitationSourceOutcome> {
            if (!request.plan.applicable) return sourceOutcome("semantic_scholar", request.plan.operation, "not_applicable", 0, [], request.plan.reason);
            const identifier = request.normalized.identifiers.doi
                ? `DOI:${request.normalized.identifiers.doi}`
                : request.normalized.identifiers.pmid
                  ? `PMID:${request.normalized.identifiers.pmid}`
                  : request.normalized.identifiers.arxiv
                    ? `ARXIV:${request.normalized.identifiers.arxiv}`
                    : undefined;
            const exact = request.plan.operation === "semantic_scholar_identifier" && identifier !== undefined;
            let papers: SemanticScholarPaper[];
            if (exact) {
                const result = await source.lookupIdentifier(identifier, signal);
                if (result.status !== "ok") return sourceOutcome("semantic_scholar", request.plan.operation, result.status, 1, [], result.detail);
                papers = [result.value];
            } else {
                const result = await source.search(request.input.title ?? request.input.citation, options.maxCandidates ?? 5, signal);
                if (result.status !== "ok") return sourceOutcome("semantic_scholar", request.plan.operation, result.status, 1, [], result.detail);
                papers = result.value;
            }
            const records = papers.map(semanticRecord);
            return sourceOutcome("semantic_scholar", request.plan.operation, records.length === 0 ? "no_data" : "ok", 1, records);
        },
    };
}
