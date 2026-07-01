/**
 * Sandbox-agent shared types.
 *
 * `SandboxToolName` is the closed allowlist of tools any sandbox agent may
 * declare in its `AgentMeta.tools`. The `createSandboxAgent` resolver maps
 * each name to a concrete `Tool` (pure leaf or fully dep-bound factory
 * output) — unknown names throw at composition time, not at first LLM call.
 *
 * `searchDisgenet` and `searchDrugbank` require keys (`DISGENET_API_KEY`,
 * `DRUGBANK_API_KEY`); without the key the underlying header builder
 * throws on first call, which the harness surfaces as a tool `is_error`
 * envelope. `searchGwasCatalog` is fully public.
 */

/** Closed allowlist of tools any sandbox agent may declare. */
export type SandboxToolName =
    // Sandbox-environment introspection.
    | "listAvailablePackages"
    | "listAvailableRefs"
    // Context7 library docs.
    | "resolveLibraryId"
    | "queryDocs"
    // Run inspection.
    | "inspectRun"
    // Literature.
    | "searchPubMed"
    | "getArticleDetails"
    | "getArticleFullText"
    // Genomics / pathways / ontology.
    | "searchGene"
    | "searchPathway"
    | "lookupGoTerm"
    | "searchInteractions"
    // ChEMBL.
    | "searchCompounds"
    | "getBioactivity"
    | "searchTargets"
    | "getMechanism"
    | "getDrugInfo"
    // PubChem.
    | "searchPubchemCompound"
    | "getPubchemCrossRefs"
    | "getPubchemAssays"
    // Translational medicine.
    | "searchOpenTargets"
    | "getTargetSafety"
    | "searchPharmgkb"
    | "searchFaers"
    | "searchClinicalTrials"
    | "searchGeoDatasets"
    | "searchClinvar"
    | "searchDgidb"
    | "searchGwasCatalog"
    | "searchDisgenet"
    | "searchDrugbank"
    // Preclinical.
    | "searchBgeeExpression"
    | "getImpcKoProfile"
    // Off-target liability / EPA CompTox.
    | "checkSafetyPanel"
    | "searchToxcast"
    | "searchCtxHazard"
    | "searchCtxChemical"
    | "searchCtxExposure";

/** Planner-facing metadata + tool allowlist for one sandbox agent. */
export interface AgentMeta {
    /** Stable agent id — also the key in the catalog and the `AgentDefinition.id`. */
    readonly id: string;
    /** Capabilities surfaced to the planner. */
    readonly capabilities: readonly string[];
    /** Omics / data types this agent handles. */
    readonly suitableFor: readonly string[];
    /** Skill directory names loaded into the agent's workspace. */
    readonly skills: readonly string[];
    /** Bio/literature tools the agent may use (workspace + sandbox tools are always wired). */
    readonly tools: readonly SandboxToolName[];
    /** Per-agent override for `maxIterations`; defaults to {@link SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS}. */
    readonly defaultMaxSteps?: number;
    /** False for agents the planner must NOT assign to plan steps (executors, the profiler). */
    readonly plannable?: boolean;
}

/** Default runaway-guard for sandbox agents. */
export const SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS = 50;
