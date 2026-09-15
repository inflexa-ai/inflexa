/**
 * Sandbox-agent shared types.
 *
 * `SandboxToolName` is the closed allowlist of tools any sandbox agent may
 * declare in its `AgentMeta.tools`. The `createSandboxAgent` resolver maps
 * each name to a concrete `Tool` (pure leaf or fully dep-bound factory
 * output) — unknown names throw at composition time, not at first LLM call.
 *
 * `geneDiseaseEvidence`, `drugGeneInteractions` and `comptox` each span several
 * corpora, some of which need a key (`DISGENET_API_KEY`, `DRUGBANK_API_KEY`,
 * `EPA_CCTE_API_KEY`). A missing key degrades that ONE corpus to `unavailable`
 * in the tool's `perSource` report; the rest of the call still answers.
 */

/** Closed allowlist of tools any sandbox agent may declare. */
export type SandboxToolName =
    // Sandbox-environment introspection.
    | "listAvailablePackages"
    | "listAvailableRefs"
    // Deterministic input-tree observation (the data profile's orientation pass).
    | "scanInputs"
    // Context7 library docs.
    | "resolveLibraryId"
    | "queryDocs"
    // Run inspection.
    | "inspectRun"
    // Literature (search / details / fulltext behind one action).
    | "pubmed"
    // Bibliographic verification (tool id is the same snake-case value).
    | "resolve_citation"
    // Identifier resolution.
    | "searchGene"
    // Functional annotation (GO / KEGG / Reactome) and STRING networks + enrichment.
    | "lookupAnnotation"
    | "searchInteractions"
    // ChEMBL (compounds / drug / mechanism / bioactivity / targets behind one action).
    | "chembl"
    // PubChem (compound / crossrefs / assays behind one action).
    | "pubchem"
    // Target assessment.
    | "opentargets"
    | "geneDiseaseEvidence"
    | "drugGeneInteractions"
    | "genePreclinicalProfile"
    // Clinical / public-data landscape.
    | "searchFaers"
    | "searchClinicalTrials"
    | "searchGeoDatasets"
    // Safety / toxicology.
    | "targetSafety"
    | "comptox"
    // The knowledge plane: render a tested script template into the step workspace.
    // Resolves to nothing when the embedder binds no knowledge client.
    | "knowledgeTemplate";

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
export const SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS = 200;
