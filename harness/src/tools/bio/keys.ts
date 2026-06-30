import type { Tool } from "../define-tool.js";

import { createSearchPubMedTool } from "./search-pubmed.js";
import { createGetArticleDetailsTool } from "./get-article-details.js";
import { createGetArticleFullTextTool } from "./get-article-full-text.js";
import { createSearchClinvarTool } from "./search-clinvar.js";
import { createSearchDrugbankTool } from "./search-drugbank.js";
import { createSearchDisgenetTool } from "./search-disgenet.js";
import { createSearchToxcastTool } from "./search-toxcast.js";
import { createSearchCtxHazardTool } from "./search-ctx-hazard.js";
import { createSearchCtxChemicalTool } from "./search-ctx-chemical.js";
import { createSearchCtxExposureTool } from "./search-ctx-exposure.js";

/**
 * API keys for the external bio/chem data sources. Threaded from the
 * composition root to every place that assembles bio tools (conversation
 * agent, sandbox agents, literature reviewer, analogy reporter). Each key
 * may be empty when its source is unconfigured — the tool surfaces the
 * resulting auth failure as a normal tool error.
 */
export interface BioToolKeys {
    readonly drugbank: string;
    readonly disgenet: string;
    readonly epaCcte: string;
    readonly ncbi?: string;
    readonly github?: string;
}

/** The NCBI-backed literature tools, built from the shared key slice. */
export function createNcbiTools(keys: BioToolKeys): {
    searchPubMed: Tool;
    getArticleDetails: Tool;
    getArticleFullText: Tool;
    searchClinvar: Tool;
} {
    return {
        searchPubMed: createSearchPubMedTool({ ncbiApiKey: keys.ncbi }),
        getArticleDetails: createGetArticleDetailsTool({ ncbiApiKey: keys.ncbi }),
        getArticleFullText: createGetArticleFullTextTool({ ncbiApiKey: keys.ncbi }),
        searchClinvar: createSearchClinvarTool({ ncbiApiKey: keys.ncbi }),
    };
}

/** The DrugBank / DisGeNET / EPA CompTox tools, built from the key slice. */
export function createChemDbTools(keys: BioToolKeys): {
    searchDrugbank: Tool;
    searchDisgenet: Tool;
    searchToxcast: Tool;
    searchCtxHazard: Tool;
    searchCtxChemical: Tool;
    searchCtxExposure: Tool;
} {
    return {
        searchDrugbank: createSearchDrugbankTool({ apiKey: keys.drugbank }),
        searchDisgenet: createSearchDisgenetTool({ apiKey: keys.disgenet }),
        searchToxcast: createSearchToxcastTool({ apiKey: keys.epaCcte }),
        searchCtxHazard: createSearchCtxHazardTool({ apiKey: keys.epaCcte }),
        searchCtxChemical: createSearchCtxChemicalTool({ apiKey: keys.epaCcte }),
        searchCtxExposure: createSearchCtxExposureTool({ apiKey: keys.epaCcte }),
    };
}
