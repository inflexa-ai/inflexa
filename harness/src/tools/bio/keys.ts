import type { Logger } from "../../lib/logger.js";
import type { Tool } from "../define-tool.js";

import { createComptoxTool } from "./comptox.js";
import { createDrugGeneInteractionsTool } from "./drug-gene-interactions.js";
import { createGeneDiseaseEvidenceTool } from "./gene-disease-evidence.js";
import { createPubMedTool } from "./pubmed.js";

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
    readonly semanticScholar?: string;
}

/**
 * The NCBI-backed literature tool, built from the shared key slice.
 *
 * `pubmed` is the consolidated literature tool (search / details / fulltext
 * behind one `action`). ClinVar reaches a caller through
 * `gene_disease_evidence`, as one of the corpora behind it, and it needs the
 * same NCBI key.
 */
export function createNcbiTools(keys: BioToolKeys): {
    pubmed: Tool;
} {
    return {
        pubmed: createPubMedTool({ ncbiApiKey: keys.ncbi }),
    };
}

/**
 * The keyed multi-source tools.
 *
 * Each of these fans out over several corpora and needs more than one key, so
 * they are built together from the whole slice rather than per source:
 * `geneDiseaseEvidence` spans the GWAS Catalog (public), DisGeNET (keyed) and
 * ClinVar (NCBI key), and `drugGeneInteractions` spans DGIdb (public), DrugBank
 * (keyed) and PharmGKB (public). A tool whose key is absent degrades that one
 * corpus to `unavailable` in its `perSource` report rather than failing.
 */
export function createChemDbTools(
    keys: BioToolKeys,
    deps: { readonly logger?: Logger } = {},
): {
    geneDiseaseEvidence: Tool;
    drugGeneInteractions: Tool;
    comptox: Tool;
} {
    return {
        geneDiseaseEvidence: createGeneDiseaseEvidenceTool({
            disgenetApiKey: keys.disgenet,
            ...(keys.ncbi ? { ncbiApiKey: keys.ncbi } : {}),
            ...(deps.logger ? { logger: deps.logger } : {}),
        }),
        drugGeneInteractions: createDrugGeneInteractionsTool({
            drugbankApiKey: keys.drugbank,
            ...(deps.logger ? { logger: deps.logger } : {}),
        }),
        comptox: createComptoxTool({ apiKey: keys.epaCcte }),
    };
}
