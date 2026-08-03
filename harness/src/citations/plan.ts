import type { CitationInput, CitationSource, CitationSourceOperation, CitationSourcePlanItem, NormalizedCitation } from "./types.js";

const SOURCES: readonly CitationSource[] = ["doi_registry", "crossref", "pubmed", "arxiv", "semantic_scholar"];

function item(
    source: CitationSource,
    applicable: boolean,
    operation: CitationSourceOperation,
    reason: string,
    candidateGeneration = false,
): CitationSourcePlanItem {
    return { source, applicable, operation: applicable ? operation : "none", candidateGeneration: applicable && candidateGeneration, reason };
}

function enoughForEcitMatch(input: CitationInput): boolean {
    if (!input.venue) return false;
    const disambiguators = [input.year, input.volume, input.firstPage, input.authors?.[0]].filter((value) => value !== undefined).length;
    return disambiguators >= 2;
}

function indicatesArxiv(input: CitationInput, normalized: NormalizedCitation): boolean {
    return /\b(?:arxiv|preprint)\b/i.test(input.citation) || /\barxiv\b/i.test(input.venue ?? "") || normalized.identifiers.arxiv !== undefined;
}

export function planCitationSources(input: CitationInput, normalized: NormalizedCitation): CitationSourcePlanItem[] {
    if (normalized.unsupportedWorkKind !== undefined) {
        return SOURCES.map((source) => item(source, false, "none", `unsupported work kind: ${normalized.unsupportedWorkKind}`));
    }

    if (normalized.kind === "doi") {
        return [
            item("doi_registry", true, "doi_exact", "exact DOI handle and registration-agency lookup"),
            item("crossref", true, "crossref_doi_if_owned", "exact lookup only when DOI registry identifies Crossref"),
            item("pubmed", true, "pubmed_doi", "bounded DOI lookup in PubMed", true),
            item("arxiv", false, "none", "a DOI alone does not indicate an arXiv preprint"),
            item("semantic_scholar", true, "semantic_scholar_identifier", "DOI identifier lookup", true),
        ];
    }

    if (normalized.kind === "pmid") {
        return [
            item("doi_registry", false, "none", "no DOI supplied"),
            item("crossref", false, "none", "PMID-only input has no Crossref bibliographic query"),
            item("pubmed", true, "pubmed_exact", "exact PMID retrieval"),
            item("arxiv", false, "none", "PMID-only input does not indicate arXiv"),
            item("semantic_scholar", true, "semantic_scholar_identifier", "PMID identifier lookup", true),
        ];
    }

    if (normalized.kind === "arxiv") {
        return [
            item("doi_registry", false, "none", "no DOI supplied"),
            item("crossref", false, "none", "arXiv-only input has no Crossref bibliographic query"),
            item("pubmed", false, "none", "arXiv-only input has no PubMed query"),
            item("arxiv", true, "arxiv_exact", "exact arXiv identifier retrieval"),
            item("semantic_scholar", true, "semantic_scholar_identifier", "arXiv identifier lookup", true),
        ];
    }

    const pubmedStructured = enoughForEcitMatch(input);
    const pubmedTitle = !pubmedStructured && input.title !== undefined;
    const arxiv = indicatesArxiv(input, normalized);
    return [
        item("doi_registry", false, "none", "no exact DOI supplied"),
        item("crossref", true, "crossref_bibliographic", "raw or structured bibliographic match", true),
        item(
            "pubmed",
            pubmedStructured || pubmedTitle,
            pubmedStructured ? "pubmed_structured" : "pubmed_title",
            pubmedStructured
                ? "structured fields support constrained citation match"
                : pubmedTitle
                  ? "supplied title supports bounded candidate search"
                  : "insufficient structured PubMed signal",
            true,
        ),
        item("arxiv", arxiv, "arxiv_bibliographic", arxiv ? "citation indicates an arXiv preprint" : "citation does not indicate arXiv", true),
        item("semantic_scholar", true, "semantic_scholar_bibliographic", "bounded bibliographic candidate search", true),
    ];
}
