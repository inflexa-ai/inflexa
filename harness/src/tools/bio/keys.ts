import type { Tool } from "../define-tool.js";

import { createPubMedTool } from "./pubmed.js";
import { createSearchClinvarTool } from "./search-clinvar.js";
import { createSearchDrugbankTool } from "./search-drugbank.js";
import { createSearchDisgenetTool } from "./search-disgenet.js";
import { createComptoxTool } from "./comptox.js";

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

/**
 * The NCBI-backed literature tools, built from the shared key slice.
 *
 * `pubmed` is the consolidated literature tool (search / details / fulltext
 * behind one `action`); `searchClinvar` remains its own single-endpoint tool.
 */
export function createNcbiTools(keys: BioToolKeys): {
    pubmed: Tool;
    searchClinvar: Tool;
} {
    return {
        pubmed: createPubMedTool({ ncbiApiKey: keys.ncbi }),
        searchClinvar: createSearchClinvarTool({ ncbiApiKey: keys.ncbi }),
    };
}

/**
 * The DrugBank / DisGeNET / EPA CompTox tools, built from the key slice.
 *
 * `comptox` is the consolidated EPA CTX tool (toxcast / hazard / chemical /
 * exposure behind one `dataset`), built over the shared EPA_CCTE key.
 */
export function createChemDbTools(keys: BioToolKeys): {
    searchDrugbank: Tool;
    searchDisgenet: Tool;
    comptox: Tool;
} {
    return {
        searchDrugbank: createSearchDrugbankTool({ apiKey: keys.drugbank }),
        searchDisgenet: createSearchDisgenetTool({ apiKey: keys.disgenet }),
        comptox: createComptoxTool({ apiKey: keys.epaCcte }),
    };
}
