/**
 * Planner-facing sandbox-agent catalog.
 *
 * Derives from `harness/agents/sandbox/index.ts` `SANDBOX_AGENT_META` —
 * the source of truth — by projecting `{ id, description }`
 * and filtering on the `plannable` flag. `generatePlan` consumes the
 * rendered markdown via `formatAgentCatalog()` to fill its prompt's
 * `{{AGENT_CATALOG}}` placeholder.
 */

import { SANDBOX_AGENT_META } from "./sandbox/index.js";
import type { SandboxToolName } from "./sandbox/types.js";

/** Planner-facing metadata for one sandbox agent. */
export type PlannerAgentMeta = {
    readonly id: string;
    readonly description: string;
    /** The public databases that the agent queries at run time, thus a step of the agent needs no staged copy of them. */
    readonly liveSources: readonly string[];
};

/**
 * The public database behind each lookup tool of a sandbox agent. `null` marks a tool that queries no public
 * database: a read of the environment or the run, the library documentation, or the knowledge template. The record
 * holds every tool name, thus a new tool cannot reach an agent without a decision here. A lookup that the planner
 * does not see makes it ask for a staged copy that no store holds.
 */
const LIVE_SOURCES: Record<SandboxToolName, string | null> = {
    listAvailablePackages: null,
    listAvailableRefs: null,
    scanInputs: null,
    resolveLibraryId: null,
    queryDocs: null,
    pubmed: "PubMed",
    resolve_citation: "Crossref, PubMed, arXiv, and Semantic Scholar",
    searchGene: "Ensembl and NCBI Gene",
    resolveGeneIds: "MyGene.info",
    lookupAnnotation: "GO, KEGG, and Reactome annotation",
    searchInteractions: "STRING",
    humanbase: "HumanBase tissue networks",
    chembl: "ChEMBL",
    pubchem: "PubChem",
    opentargets: "Open Targets",
    geneDiseaseEvidence: "GWAS Catalog, DisGeNET, and ClinVar",
    getVariantFrequencies: "gnomAD",
    getProteinDomains: "InterPro",
    drugGeneInteractions: "DGIdb, DrugBank, and PharmGKB",
    genePreclinicalProfile: "Bgee expression and IMPC knockouts",
    searchFaers: "FAERS",
    searchClinicalTrials: "ClinicalTrials.gov",
    searchGeoDatasets: "GEO",
    searchRegulatoryApprovals: "FDA and EMA approvals",
    targetSafety: "a curated target safety panel",
    comptox: "EPA CompTox",
    knowledgeTemplate: null,
};

/** The sandbox agents the planner may assign to analysis-plan steps. */
export const PLANNABLE_AGENT_CATALOG: readonly PlannerAgentMeta[] = Object.values(SANDBOX_AGENT_META)
    .filter((meta) => meta.plannable !== false)
    .map((meta) => ({
        id: meta.id,
        description: meta.description,
        liveSources: meta.tools.flatMap((tool) => {
            const source = LIVE_SOURCES[tool];
            return source === null ? [] : [source];
        }),
    }));

/**
 * Ids of the agents the planner may assign — the `z.enum` domain for
 * `PlanStepSchema.agent`. A non-empty tuple, as `z.enum` requires.
 */
export const PLANNABLE_AGENT_IDS: readonly [string, ...string[]] = (() => {
    const [first, ...rest] = PLANNABLE_AGENT_CATALOG.map((meta) => meta.id);
    if (first === undefined) {
        throw new Error("PLANNABLE_AGENT_CATALOG is empty");
    }
    return [first, ...rest];
})();

/**
 * Every sandbox agent id — plannable agents plus the workflow-dedicated
 * `data-profiler`. Plan validation checks step
 * assignments against this set.
 */
export const KNOWN_AGENT_IDS: readonly string[] = Object.keys(SANDBOX_AGENT_META);

/** The step agent of a step whose agent id the roster does not hold. */
export const DEFAULT_STEP_AGENT_ID = "analyst";

/**
 * The agent that runs a step. A stored plan, or the input of a run that recovers, can name an agent id that the
 * roster no longer holds. Such a step runs on the analyst, the agent of each analysis of data.
 */
export function resolveStepAgentId(agentId: string): string {
    return Object.hasOwn(SANDBOX_AGENT_META, agentId) ? agentId : DEFAULT_STEP_AGENT_ID;
}

/**
 * Render the catalog as the markdown block the planner prompt expects in
 * place of its `{{AGENT_CATALOG}}` placeholder.
 */
export function formatAgentCatalog(catalog: readonly PlannerAgentMeta[] = PLANNABLE_AGENT_CATALOG): string {
    return catalog
        .map((meta) => {
            const live = meta.liveSources.length === 0 ? "" : `, live lookups: [${meta.liveSources.join(", ")}]`;
            return `- **${meta.id}**: ${meta.description}${live}`;
        })
        .join("\n");
}
