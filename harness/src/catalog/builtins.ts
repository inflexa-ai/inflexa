/**
 * The built-in agents. A host can add and remove the attachments of each one, and it cannot change a prompt: a custom
 * agent of the same role, a clone for example, changes it. The default attachments of each agent are the tool sets
 * that it held before connectors, expressed as connectors.
 */

import { analogicalReasonerPrompt } from "../prompts/analogical-reasoner.js";
import { conversationPrompt } from "../prompts/conversation.js";
import { plannerPrompt } from "../prompts/planner.js";
import { reportSessionPrompt } from "../prompts/report-session.js";
import { analystPrompt } from "../prompts/sandbox/analyst.js";
import { dataProfilerPrompt } from "../prompts/sandbox/data-profiler.js";
import { drugAnalystPrompt } from "../prompts/sandbox/drug-analyst.js";
import { synthesisAgentPrompt } from "../prompts/synthesis-agent.js";
import type { AgentAttachments, AgentRole, BuiltinAgentId } from "./types.js";

export type BuiltinAgent = {
    readonly id: BuiltinAgentId;
    readonly name: string;
    readonly role: AgentRole;
    readonly description: string;
    /** The prompt body. The harness adds the parts that each agent of the role shares, for example the tools and the skills. */
    readonly prompt: string;
    readonly defaults: AgentAttachments;
    readonly canDisable: boolean;
    readonly defaultMaxSteps?: number;
};

const LITERATURE = ["pubmed", "citations", "arxiv", "semantic-scholar"] as const;

export const BUILTIN_AGENTS: readonly BuiltinAgent[] = [
    {
        id: "inflexa",
        name: "Inflexa",
        role: "chat",
        prompt: conversationPrompt,
        description: "The agent that the user talks to. It plans, starts and reads analyses.",
        defaults: {
            connectors: [
                "gene-search",
                "protein-search",
                "mygene",
                "annotations",
                "string",
                "humanbase",
                "alphafold",
                "interpro",
                ...LITERATURE,
                "web-search",
                "web-fetch",
                "chembl",
                "pubchem",
                "opentargets",
                "gene-disease-evidence",
                "gnomad",
                "drug-gene-interactions",
                "faers",
                "clinical-trials",
                "regulatory-approvals",
                "patents",
                "geo",
                "preclinical",
                "target-safety",
                "comptox",
            ],
            mcp: [],
            skills: [],
        },
        canDisable: false,
    },
    {
        id: "planner",
        name: "Planner",
        role: "planner",
        prompt: plannerPrompt,
        description: "Makes the analysis plan from the data profile and the research question.",
        defaults: { connectors: ["geo", "pubmed", "arxiv", "semantic-scholar", "github", "context7", "knowledge"], mcp: [], skills: [] },
        canDisable: false,
    },
    {
        id: "analyst",
        name: "Analyst",
        role: "executor",
        description:
            "Each analysis of data: the omics modalities, single-cell and spatial data, genetic variants, statistics and machine learning, enrichment and networks, multi-omics integration, and the preparation of MDV assets.",
        prompt: analystPrompt,
        defaults: {
            connectors: [
                "context7",
                ...LITERATURE,
                "geo",
                "gene-search",
                "mygene",
                "annotations",
                "string",
                "humanbase",
                "gnomad",
                "interpro",
                "protein-search",
                "alphafold",
            ],
            mcp: [],
            skills: [
                "bulk-transcriptomics",
                "omics-general",
                "single-cell",
                "multimodal-single-cell",
                "spatial-omics",
                "proteomics",
                "metabolomics",
                "genomic-variants",
                "dna-methylation",
                "chromatin-regulation",
                "microbiome",
                "enrichment",
                "network-regulatory",
                "statistical-modeling",
                "multi-omics-integration",
                "immune-profiling",
                "mdv-preparation",
            ],
        },
        canDisable: false,
    },
    {
        id: "drug-analyst",
        name: "Drug analyst",
        role: "executor",
        description:
            "The work on drugs and compounds: chemical structures and their activity, exposure and response in patients, safety and adverse events, and the use of a drug for a new indication.",
        prompt: drugAnalystPrompt,
        defaults: {
            connectors: [
                "context7",
                ...LITERATURE,
                "gene-search",
                "annotations",
                "string",
                "chembl",
                "drug-gene-interactions",
                "pubchem",
                "target-safety",
                "opentargets",
                "faers",
                "comptox",
                "preclinical",
                "clinical-trials",
                "regulatory-approvals",
                "gene-disease-evidence",
                "interpro",
                "protein-search",
                "alphafold",
            ],
            mcp: [],
            skills: [
                "cheminformatics",
                "omics-general",
                "translational-safety",
                "pkpd-clinical-response",
                "statistical-modeling",
                "drug-repurposing",
                "genomic-variants",
            ],
        },
        canDisable: true,
    },
    {
        id: "data-profiler",
        name: "Data profiler",
        role: "profiler",
        description: "Profiles the input files of an analysis for the planner.",
        prompt: dataProfilerPrompt,
        defaults: { connectors: ["context7"], mcp: [], skills: [] },
        canDisable: false,
    },
    {
        id: "synthesizer",
        name: "Synthesizer",
        role: "synthesizer",
        prompt: synthesisAgentPrompt,
        description: "Writes the literature-grounded synthesis of a run.",
        defaults: {
            connectors: ["gene-search", "protein-search", "annotations", "string", "pubmed", "citations", "drug-gene-interactions", "preclinical"],
            mcp: [],
            skills: [],
        },
        canDisable: false,
    },
    {
        id: "analogy",
        name: "Analogy reasoner",
        role: "analogy",
        prompt: analogicalReasonerPrompt,
        description: "Finds analogous problems and methods in other fields.",
        defaults: { connectors: ["semantic-scholar", "arxiv", "github", "pubmed"], mcp: [], skills: [] },
        canDisable: true,
    },
    {
        id: "reporter",
        name: "Reporter",
        role: "reporter",
        prompt: reportSessionPrompt,
        description: "Composes a report with the user in a report session.",
        defaults: { connectors: [], mcp: [], skills: [] },
        canDisable: false,
    },
];

export const BUILTIN_AGENT_IDS: ReadonlySet<string> = new Set(BUILTIN_AGENTS.map((agent) => agent.id));

/** The fallback executor of a step whose agent the catalog does not hold. */
export const DEFAULT_EXECUTOR_ID = "analyst";

export function builtinAgent(id: BuiltinAgentId): BuiltinAgent {
    const agent = BUILTIN_AGENTS.find((candidate) => candidate.id === id);
    // BuiltinAgentId is a closed union, and BUILTIN_AGENTS holds one entry for each member.
    if (agent === undefined) throw new Error(`no built-in agent "${id}"`);
    return agent;
}
