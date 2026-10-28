/**
 * The decision cases of the planner that `generate_plan` runs.
 *
 * The message of each case is the seed that `generate_plan` composes: the data context of the profile, the two
 * censuses, and the research question. The terminal tools are real, thus `submit_plan` checks each plan the same as
 * in production, and a planner that repairs a rejected plan is graded by its repair. The search tools give small
 * canned answers.
 *
 * Each case that requires a plan has a counter-case where the same seed requires a different outcome.
 */

import type { DataProfileResult } from "@inflexa-ai/harness/contracts/data-profile.js";
import { composePlannerSeed, formatPriorPlan, renderDataContext } from "@inflexa-ai/harness/tools/research/generate-plan.js";

import { REAL_TOOL, type ToolScript } from "../lib/agent.js";
import { all, decides, never, plans, type EvalCase, type PlanStepView } from "../lib/case.js";

const ANALYSIS_ID = "analysis-001";

const PROFILE: DataProfileResult = {
    summary: "Bulk RNA-seq of cultured cells, 6 samples, treated against control.",
    files: [
        { path: "data/inputs/f-counts/counts.tsv", description: "Raw gene-level count matrix", dataType: "count-matrix", format: "TSV", rows: 58_302, cols: 6 },
        {
            path: "data/inputs/f-meta/samples.csv",
            description: "Sample sheet: sample, group, batch",
            dataType: "clinical-metadata",
            format: "CSV",
            rows: 6,
            cols: 3,
        },
    ],
    profiledAt: "2026-10-27T08:00:00.000Z",
    domain: "transcriptomics",
    subtype: "bulk-rna-seq",
    organism: { scientificName: "Homo sapiens", taxonId: "9606", source: "metadata", confidence: "high" },
    condition: "treated vs control",
    experimentalDesign: "Two groups, treated (T1-T3) against control (C1-C3), three biological replicates for each group.",
    qualityAssessment: { concerns: ["sample C3 has a library size 40% below the median"] },
};

const DATA_CONTEXT = renderDataContext({ kind: "ready", result: PROFILE }, ANALYSIS_ID);

const REFS_WITH_GENE_SETS = [
    "## Available Reference Data",
    "",
    "Reference files visible beneath /:",
    "- msigdb/hallmark/h.all.v2024.1.Hs.symbols.gmt (file, 189412 bytes; MSigDB hallmark, 2024.1, gene-sets, Homo sapiens)",
    "    GMT — 50 hallmark gene sets of human gene symbols",
    "- msigdb/c2-kegg/c2.cp.kegg_medicus.v2024.1.Hs.symbols.gmt (file, 1022210 bytes; MSigDB KEGG MEDICUS, 2024.1, gene-sets, Homo sapiens)",
    "    GMT — KEGG MEDICUS pathways of human gene symbols",
    "- gencode/v46/gencode.v46.annotation.gtf.gz (file, 50123441 bytes; GENCODE, 46, annotation, Homo sapiens)",
    "    GTF — the gene annotation of the human genome",
].join("\n");

const PACKAGES = [
    "## Available Packages",
    "",
    "## R packages",
    "  DESeq2 1.46.0, edgeR 4.4.0, limma 3.62.1, apeglm 1.28.0, fgsea 1.32.0, clusterProfiler 4.14.0, msigdbr 7.5.1, ComplexHeatmap 2.22.0",
    "",
    "## Python packages",
    "  pandas 2.2.3, numpy 2.1.3, scipy 1.14.1, gseapy 1.1.4, matplotlib 3.9.2, seaborn 0.13.2, scikit-learn 1.5.2",
].join("\n");

function seed(researchQuestion: string, extra: { priorPlanBlock?: string; userConstraints?: string } = {}): string {
    return composePlannerSeed({
        priorPlanBlock: extra.priorPlanBlock ?? null,
        dataContextBlock: DATA_CONTEXT,
        groundingBlock: [REFS_WITH_GENE_SETS, PACKAGES].join("\n\n"),
        input: { researchQuestion, userConstraints: extra.userConstraints },
    });
}

/** The canned answers of the search tools, and the real terminal tools. */
const PLANNER_TOOLS: Readonly<Record<string, ToolScript>> = {
    submit_plan: REAL_TOOL,
    request_clarification: REAL_TOOL,
    report_blocker: REAL_TOOL,
    pubmed: {
        ok: { totalFound: 1, results: [{ pmid: "25516281", title: "Moderated estimation of fold change and dispersion for RNA-seq data with DESeq2" }] },
    },
    search_geo_datasets: { ok: { results: [] } },
    search_semantic_scholar: { ok: { results: [] } },
    search_arxiv: { ok: { results: [] } },
    search_github_repos: { ok: { results: [] } },
    list_available_refs: { ok: { available: true, content: REFS_WITH_GENE_SETS.split("\n").slice(2).join("\n") } },
    list_available_packages: { ok: { available: true, total: 15, returned: 15, hasMore: false, content: PACKAGES.split("\n").slice(2).join("\n") } },
};

/** The prior plan of the revision cases: a differential expression step, then a hallmark enrichment of its genes. */
const PRIOR_PLAN = formatPriorPlan("pln-1a2b3c4d", {
    title: "Treated vs control DE + hallmark pathways",
    analytical_narrative: "DESeq2 on the counts, then a hallmark enrichment of the significant genes.",
    created_at: "2026-10-27T09:00:00.000Z",
    steps: [
        {
            id: "T1S1",
            name: "Differential expression",
            track: "T1",
            step_type: "analysis",
            question: "Which genes change between treated and control?",
            acceptance_criteria: ["A results table with log2 fold change and adjusted p-value"],
            depends_on: [],
            status: "pending",
            agent: "bulk-transcriptomics-agent",
            maxSteps: 40,
        },
        {
            id: "T1S2",
            name: "Hallmark enrichment",
            track: "T1",
            step_type: "analysis",
            question: "Which hallmark gene sets are enriched among the genes that change between treated and control?",
            acceptance_criteria: ["An enrichment table with adjusted p-values"],
            depends_on: ["T1S1"],
            status: "pending",
            agent: "enrichment-agent",
            maxSteps: 40,
        },
    ],
});

if (PRIOR_PLAN === null) throw new Error("the prior plan of the planner cases does not parse");

const TRANSLATIONAL_AGENTS = ["drug-repurposing-agent", "cheminformatics-agent", "translational-safety-agent", "pkpd-clinical-response-agent"];

/** A step that only explores or profiles the data, which the profile already did. */
function exploresData(step: PlanStepView): boolean {
    const text = `${step.name} ${step.question}`.toLowerCase();
    return text.includes("explor") || text.includes("initial assessment") || text.includes("data profil");
}

function deThenEnrichment(steps: readonly PlanStepView[]): boolean {
    const de = steps.find((step) => step.agent === "bulk-transcriptomics-agent");
    const enrichment = steps.find((step) => step.agent === "enrichment-agent");
    if (de === undefined || enrichment === undefined) return false;
    const names = `${de.question} ${de.name}`.toLowerCase();
    return enrichment.depends_on.length > 0 && names.includes("treated") && names.includes("control") && !steps.some(exploresData);
}

function keepsPriorIds(steps: readonly PlanStepView[]): boolean {
    const de = steps.find((step) => step.id === "T1S1");
    const enrichment = steps.find((step) => step.id === "T1S2");
    return de?.agent === "bulk-transcriptomics-agent" && enrichment?.agent === "enrichment-agent";
}

const PLANNER: Pick<EvalCase, "agent" | "tools" | "maxSteps"> = { agent: "planner", tools: PLANNER_TOOLS, maxSteps: 10 };

export const plannerCases: readonly EvalCase[] = [
    {
        id: "plan-de-enrichment",
        set: "dev",
        source: "planner prompt: route by the data object, name the actual conditions, and plan no exploration step",
        user: seed("Which genes change between treated and control, and which pathways do they point to?"),
        ...PLANNER,
        grade: plans("a DE step on treated and control, then an enrichment step that depends on it", deThenEnrichment),
    },
    {
        id: "plan-missing-reference",
        set: "dev",
        source: "planner prompt: an absent reference that the question cannot do without is a clarification, not a plan",
        user: seed("Infer the transcription factor activity of treated against control with a curated TF-target regulon."),
        ...PLANNER,
        grade: decides("request_clarification", ["submit_plan", "report_blocker"]),
    },
    {
        id: "plan-revision-keeps-ids",
        set: "dev",
        source: "planner prompt: a revision keeps the ids and the agents of the steps that it does not change",
        user: seed("Which genes change between treated and control, and which pathways do they point to?", {
            priorPlanBlock: PRIOR_PLAN,
            userConstraints: "Use the KEGG gene sets instead of the hallmark gene sets for the enrichment.",
        }),
        ...PLANNER,
        grade: plans("a revision that keeps T1S1 and T1S2", keepsPriorIds),
    },
    {
        id: "plan-no-speculative-translation",
        set: "dev",
        source: "planner prompt: add a translational step only when the question asks for one",
        user: seed("Which genes are differentially expressed between treated and control?"),
        ...PLANNER,
        grade: all(
            plans("a DE plan with no translational step", (steps) => !steps.some((step) => TRANSLATIONAL_AGENTS.includes(step.agent))),
            never(["request_clarification", "report_blocker"]),
        ),
    },
    {
        id: "plan-druggable-targets",
        set: "dev",
        source: "planner prompt: a question about druggable targets gets a step that maps the genes to known drugs",
        user: seed("Which of the genes that the treatment changes are druggable targets with existing compounds?"),
        ...PLANNER,
        grade: plans("a plan with a drug mapping step", (steps) =>
            steps.some((step) => ["drug-repurposing-agent", "cheminformatics-agent"].includes(step.agent)),
        ),
    },
    {
        id: "plan-de-enrichment-held-out",
        set: "held-out",
        source: "paraphrase of plan-de-enrichment",
        user: seed("Find the differentially expressed genes of the treatment, and test them for pathway enrichment."),
        ...PLANNER,
        grade: plans("a DE step on treated and control, then an enrichment step that depends on it", deThenEnrichment),
    },
    {
        id: "plan-missing-reference-held-out",
        set: "held-out",
        source: "paraphrase of plan-missing-reference",
        user: seed("Score the activity of the transcription factors that drive the treatment response, from a TF regulon."),
        ...PLANNER,
        grade: decides("request_clarification", ["submit_plan", "report_blocker"]),
    },
    {
        id: "plan-revision-keeps-ids-held-out",
        set: "held-out",
        source: "paraphrase of plan-revision-keeps-ids",
        user: seed("Which genes change between treated and control, and which pathways do they point to?", {
            priorPlanBlock: PRIOR_PLAN,
            userConstraints:
                "Keep the steps, and add a step after the differential expression that clusters the significant genes by their expression pattern.",
        }),
        ...PLANNER,
        grade: plans("a revision that keeps T1S1 and T1S2", keepsPriorIds),
    },
    {
        id: "plan-no-speculative-translation-held-out",
        set: "held-out",
        source: "paraphrase of plan-no-speculative-translation",
        user: seed("Give me the list of genes that the treatment changes, with their fold changes."),
        ...PLANNER,
        grade: all(
            plans("a DE plan with no translational step", (steps) => !steps.some((step) => TRANSLATIONAL_AGENTS.includes(step.agent))),
            never(["request_clarification", "report_blocker"]),
        ),
    },
    {
        id: "plan-druggable-targets-held-out",
        set: "held-out",
        source: "paraphrase of plan-druggable-targets",
        user: seed("For the genes that respond to the treatment, which existing drugs could act on them?"),
        ...PLANNER,
        grade: plans("a plan with a drug mapping step", (steps) =>
            steps.some((step) => ["drug-repurposing-agent", "cheminformatics-agent"].includes(step.agent)),
        ),
    },
];
