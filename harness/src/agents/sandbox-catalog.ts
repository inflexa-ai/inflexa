/**
 * Planner-facing sandbox-agent catalog.
 *
 * Derives from `harness/agents/sandbox/index.ts` `SANDBOX_AGENT_META` —
 * the source of truth — by projecting `{ id, capabilities, suitableFor }`
 * and filtering on the `plannable` flag. `generatePlan` consumes the
 * rendered markdown via `formatAgentCatalog()` to fill its prompt's
 * `{{AGENT_CATALOG}}` placeholder.
 */

import { SANDBOX_AGENT_META } from "./sandbox/index.js";
import type { SandboxToolName } from "./sandbox/types.js";

/** Planner-facing metadata for one sandbox agent. */
export type PlannerAgentMeta = {
    readonly id: string;
    readonly capabilities: readonly string[];
    readonly suitableFor: readonly string[];
    /** The public databases that the agent queries at run time, thus a step of the agent needs no staged copy of them. */
    readonly liveSources: readonly string[];
};

/**
 * The public database behind each lookup tool of a sandbox agent. A tool that reads the environment or the run, and
 * not a public database, has no entry.
 */
const LIVE_SOURCES: Partial<Record<SandboxToolName, string>> = {
    pubmed: "PubMed",
    searchGene: "Ensembl and NCBI Gene",
    lookupAnnotation: "GO, KEGG, and Reactome annotation",
    searchInteractions: "STRING",
    chembl: "ChEMBL",
    pubchem: "PubChem",
    opentargets: "Open Targets",
    geneDiseaseEvidence: "GWAS Catalog, DisGeNET, and ClinVar",
    drugGeneInteractions: "DGIdb, DrugBank, and PharmGKB",
    genePreclinicalProfile: "Bgee expression and IMPC knockouts",
    searchFaers: "FAERS",
    searchClinicalTrials: "ClinicalTrials.gov",
    searchGeoDatasets: "GEO",
    searchRegulatoryApprovals: "FDA and EMA approvals",
    targetSafety: "a curated target safety panel",
    comptox: "EPA CompTox",
};

/** The sandbox agents the planner may assign to analysis-plan steps. */
export const PLANNABLE_AGENT_CATALOG: readonly PlannerAgentMeta[] = Object.values(SANDBOX_AGENT_META)
    .filter((meta) => meta.plannable !== false)
    .map((meta) => ({
        id: meta.id,
        capabilities: [...meta.capabilities],
        suitableFor: [...meta.suitableFor],
        liveSources: meta.tools.flatMap((tool) => {
            const source = LIVE_SOURCES[tool];
            return source === undefined ? [] : [source];
        }),
    }));

/**
 * The reference datasets one capability of one agent cannot run without, by catalog id.
 *
 * Empty for an unknown agent, for an agent that declares nothing, and for a phrase no declaration
 * matches. An unmatched phrase must NOT refuse a launch: the pass can only demand what a
 * declaration states, so a paraphrased phrase degrades to the behaviour of a step with no phrase.
 */
export function capabilityDataRequirement(agentId: string, capability: string): readonly string[] {
    const entry = SANDBOX_AGENT_META[agentId]?.dataRequirements?.find((requirement) => requirement.capability === capability);
    return entry?.datasets ?? [];
}

/** Every declared requirement, for a caller that asks what a capability wants before it plans. */
export function declaredDataRequirements(): readonly { agentId: string; capability: string; datasets: readonly string[] }[] {
    return Object.values(SANDBOX_AGENT_META).flatMap((meta) =>
        (meta.dataRequirements ?? []).map((requirement) => ({
            agentId: meta.id,
            capability: requirement.capability,
            datasets: requirement.datasets,
        })),
    );
}

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
 * ones (`data-profiler`, the executors). Plan validation checks step
 * assignments against this set.
 */
export const KNOWN_AGENT_IDS: readonly string[] = Object.keys(SANDBOX_AGENT_META);

/**
 * Render the catalog as the markdown block the planner prompt expects in
 * place of its `{{AGENT_CATALOG}}` placeholder.
 */
export function formatAgentCatalog(catalog: readonly PlannerAgentMeta[] = PLANNABLE_AGENT_CATALOG): string {
    return catalog
        .map((meta) => {
            const live = meta.liveSources.length === 0 ? "" : `, live lookups: [${meta.liveSources.join(", ")}]`;
            return `- **${meta.id}**: capabilities: [${meta.capabilities.join(", ")}], suitable for: [${meta.suitableFor.join(", ")}]${live}`;
        })
        .join("\n");
}
