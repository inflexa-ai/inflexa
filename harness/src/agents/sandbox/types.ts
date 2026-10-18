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
    // FDA and EMA authorizations with their label text (Amass; keyed).
    | "searchRegulatoryApprovals"
    // Safety / toxicology.
    | "targetSafety"
    | "comptox"
    // The knowledge plane: render a tested script template into the step workspace.
    // Resolves to nothing when the embedder binds no knowledge client.
    | "knowledgeTemplate";

/**
 * The reference datasets that one capability of one agent cannot run without.
 *
 * A requirement belongs to a capability, never to the agent: an agent holds capabilities that need
 * no reference data at all, so an agent-wide requirement would refuse a step that needs nothing.
 * The skill of the agent still states what the data IS and how to use it. This states which catalog
 * entry carries it, in a form a test can pin.
 */
export interface CapabilityDataRequirement {
    /** One phrase of the same agent's `capabilities`, verbatim — the step copies it from the catalog. */
    readonly capability: string;
    /** Reference-catalog dataset ids. Declare only an opt-in dataset: a recommended one is already in a default store. */
    readonly datasets: readonly string[];
}

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
    /**
     * Per-capability reference-data requirements. Omitted by an agent whose capabilities all run on
     * what a default store holds.
     *
     * The pre-launch pass resolves these against the live store, so an absent dataset refuses the
     * launch instead of costing a run. The planner-facing projection deliberately drops this field:
     * a prompt names no dataset, so the ids reach a caller through a tool and the launch through here.
     */
    readonly dataRequirements?: readonly CapabilityDataRequirement[];
}

/** Default runaway-guard for sandbox agents. */
export const SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS = 200;
