/**
 * The lookups of the run synthesizer: the gene, protein, annotation,
 * interaction, PubMed, citation, drug-gene, and preclinical-profile tools.
 *
 * The synthesizer calls them directly, thus each lookup result, and each PMID
 * that the synthesis cites, is in the transcript of the synthesizer, where
 * `submit_synthesis` can check it.
 */

import type { CitationResolver } from "../../citations/types.js";
import type { Logger } from "../../lib/logger.js";
import { genePreclinicalProfileTool } from "../bio/gene-preclinical-profile.js";
import { createChemDbTools, createNcbiTools, type BioToolKeys } from "../bio/keys.js";
import { lookupAnnotationTool } from "../bio/lookup-annotation.js";
import { searchGeneTool } from "../bio/search-gene.js";
import { searchInteractionsTool } from "../bio/search-interactions.js";
import { searchProteinTool } from "../bio/search-protein.js";
import type { Tool } from "../define-tool.js";
import { createResolveCitationTool } from "./resolve-citation.js";

export type SynthesisLookupDeps = {
    /** API keys for the bio/chem data sources of the lookups. */
    readonly bioKeys: BioToolKeys;
    /** Shared bibliographic verification service; all agent surfaces share its pacing/cache. */
    readonly citationResolver: CitationResolver;
    /** Operational logging; omitted falls back to no-op. */
    readonly logger?: Logger;
};

export function createSynthesisLookupTools(deps: SynthesisLookupDeps): readonly Tool[] {
    const ncbi = createNcbiTools(deps.bioKeys);
    const chemDb = createChemDbTools(deps.bioKeys, { logger: deps.logger });
    return [
        searchGeneTool,
        searchProteinTool,
        lookupAnnotationTool,
        searchInteractionsTool,
        ncbi.pubmed,
        createResolveCitationTool(deps.citationResolver),
        chemDb.drugGeneInteractions,
        genePreclinicalProfileTool,
    ];
}
