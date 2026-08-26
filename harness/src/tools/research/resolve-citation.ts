import { ok } from "neverthrow";

import { CitationInputSchema, type CitationResolver } from "../../citations/types.js";
import { defineTool, type Tool } from "../define-tool.js";

export function createResolveCitationTool(resolver: CitationResolver): Tool {
    return defineTool({
        id: "resolve_citation",
        description:
            "Verify one supplied citation against the applicable bibliographic authorities — the DOI registry, Crossref, PubMed, arXiv and Semantic " +
            "Scholar — and report where they agree. " +
            "Use this for 'does this reference exist and does its metadata agree?', not for topical literature discovery: pubmed, " +
            "search_semantic_scholar and search_arxiv are the discovery tools.\n" +
            "ACCEPTED IDENTIFIERS: a DOI ('10.1038/nature12373'), a PMID ('23945592'), an arXiv ID ('2301.00001'), or raw bibliographic text. Each " +
            "authority that the input cannot address is marked not_applicable rather than queried.\n" +
            "Returns source-labelled records, field comparisons, conflicts, coverage, and one of verified, metadata_mismatch, " +
            "not_found, unverifiable, or inconclusive. Source failure never becomes not_found — an unreachable authority reports unavailable, and " +
            "not_found means the authorities that answered hold no such record.",
        inputSchema: CitationInputSchema,
        describeCall: ({ citation }) => `verify ${citation}`,
        execute: async (input, ctx) => ok(await resolver.resolveOne(input, { signal: ctx.signal })),
    });
}
