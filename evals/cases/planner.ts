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

import type { PoolInventorySection } from "@inflexa-ai/harness/config/environment-stores.js";
import type { DataProfileResult } from "@inflexa-ai/harness/contracts/data-profile.js";
import { SANDBOX_AGENT_META } from "@inflexa-ai/harness/agents/sandbox/index.js";
import { composePlannerSeed, formatPriorPlan, renderDataContext } from "@inflexa-ai/harness/tools/research/generate-plan.js";

import { REAL_TOOL, type ToolScript } from "../lib/agent.js";
import { parseUnknownRecord } from "@inflexa-ai/harness/lib/unknown-containers.js";

import {
    all,
    anyOf,
    atMost,
    before,
    callsAny,
    decides,
    inputLacks,
    never,
    plans,
    submits,
    type EvalCase,
    type Grade,
    type PlanStepView,
    type Trial,
} from "../lib/case.js";

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

const R_BASE = ["DESeq2", "edgeR", "limma", "apeglm", "fgsea", "clusterProfiler", "msigdbr", "ComplexHeatmap"];
const PYTHON_BASE = ["pandas", "numpy", "scipy", "gseapy", "matplotlib", "seaborn", "scikit-learn"];

const PACKAGES = ["## Available Packages", "", "## R packages", `  ${R_BASE.join(", ")}`, "", "## Python packages", `  ${PYTHON_BASE.join(", ")}`].join("\n");

/** The pool that `submit_plan` reads, with the packages of a census of the seed. */
function poolOf(r: readonly string[], python: readonly string[]): readonly PoolInventorySection[] {
    return [
        { title: "R packages", track: "r", packages: r.map((name) => ({ name })) },
        { title: "Python packages", track: "python", packages: python.map((name) => ({ name })) },
    ];
}

const BASE_POOL = poolOf(R_BASE, PYTHON_BASE);

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
        ok: {
            totalFound: 1,
            results: [
                {
                    pmid: "25516281",
                    title: "Moderated estimation of fold change and dispersion for RNA-seq data with DESeq2",
                    journal: "Genome Biology",
                    year: "2014",
                    authors: "Love MI, Huber W, Anders S",
                },
            ],
        },
    },
    search_geo_datasets: { ok: { totalFound: 0, datasets: [] } },
    search_semantic_scholar: { ok: { success: true, papers: [] } },
    search_arxiv: { ok: { success: true, papers: [] } },
    search_github_repos: { ok: { success: true, repos: [] } },
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

/** The package census of the network cases: `igraph` is in both tracks, and the Python name of scikit-learn is not `sklearn`. */
const NETWORK_CENSUS = {
    r: ["DESeq2", "edgeR", "limma", "fgsea", "msigdbr", "WGCNA", "igraph", "ComplexHeatmap"],
    python: ["pandas", "numpy", "scipy", "networkx", "igraph", "leidenalg", "scikit-learn", "matplotlib", "seaborn", "gseapy"],
};

const NETWORK_PACKAGES = [
    "## Available Packages",
    "",
    "## R packages",
    `  ${NETWORK_CENSUS.r.join(", ")}`,
    "",
    "## Python packages",
    `  ${NETWORK_CENSUS.python.join(", ")}`,
].join("\n");

function networkSeed(researchQuestion: string): string {
    return composePlannerSeed({
        priorPlanBlock: null,
        dataContextBlock: DATA_CONTEXT,
        groundingBlock: [REFS_WITH_GENE_SETS, NETWORK_PACKAGES].join("\n\n"),
        input: { researchQuestion },
    });
}

const NETWORK_TOOLS: Readonly<Record<string, ToolScript>> = {
    ...PLANNER_TOOLS,
    list_available_packages: {
        ok: { available: true, total: 18, returned: 18, hasMore: false, content: NETWORK_PACKAGES.split("\n").slice(2).join("\n") },
    },
};

/** The problem of one `packages` entry against the census, or `undefined` when the pool resolves it to one package. */
function packageProblem(entry: string, census: { readonly r: readonly string[]; readonly python: readonly string[] }): string | undefined {
    const [head = "", ...rest] = entry.split("==")[0]?.split(":") ?? [];
    const track = rest.length > 0 ? head.toLowerCase() : undefined;
    const name = (rest.length > 0 ? rest.join(":") : head).trim().toLowerCase();
    const inR = census.r.some((p) => p.toLowerCase() === name);
    const inPython = census.python.some((p) => p.toLowerCase() === name);
    if (track === "r") return inR ? undefined : `${entry} is not an R package of the pool`;
    if (track === "python") return inPython ? undefined : `${entry} is not a Python package of the pool`;
    if (track !== undefined) return `${entry} has an unknown prefix`;
    if (inR && inPython) return `${entry} is in both tracks`;
    return inR || inPython ? undefined : `${entry} is not in the pool`;
}

/** Issue #512: each `packages` entry of the last plan resolves to one package of the census. */
function packagesResolve(census: { readonly r: readonly string[]; readonly python: readonly string[] }) {
    return (steps: readonly PlanStepView[]): boolean => steps.every((step) => step.packages.every((entry) => packageProblem(entry, census) === undefined));
}

/** The `capability` of each step is one phrase of the capabilities of its agent, as the catalog spells it. */
function capabilitiesExact(steps: readonly PlanStepView[]): boolean {
    return steps.every((step) => SANDBOX_AGENT_META[step.agent]?.capabilities.includes(step.capability) === true);
}

/** The prior plan of the completed differential expression step. */
const PRIOR_PLAN_DONE = formatPriorPlan("pln-1a2b3c4d", {
    title: "Treated vs control DE",
    analytical_narrative: "DESeq2 on the counts of treated against control.",
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
            status: "completed",
            agent: "bulk-transcriptomics-agent",
            maxSteps: 40,
        },
    ],
});

if (PRIOR_PLAN_DONE === null) throw new Error("the completed prior plan of the planner cases does not parse");

const PRIOR_RUN =
    "Run 0193f7a2 completed T1S1 (differential expression, DESeq2): 412 genes up and 198 down at FDR 0.05. The results table is runs/0193f7a2/T1S1/output/de_results.csv.";

/** No step other than the completed T1S1 does the differential expression again. */
function noSecondDe(steps: readonly PlanStepView[]): boolean {
    return !steps.some(
        (step) => step.id !== "T1S1" && /differential expression|deseq2/i.test(`${step.name} ${step.question}`) && step.agent === "bulk-transcriptomics-agent",
    );
}

function revisionSeed(researchQuestion: string): string {
    return composePlannerSeed({
        priorPlanBlock: PRIOR_PLAN_DONE,
        dataContextBlock: DATA_CONTEXT,
        groundingBlock: [REFS_WITH_GENE_SETS, PACKAGES].join("\n\n"),
        input: { researchQuestion, priorRuns: PRIOR_RUN },
    });
}

function notesSeed(researchQuestion: string, analystNotes: string): string {
    return composePlannerSeed({
        priorPlanBlock: null,
        dataContextBlock: DATA_CONTEXT,
        groundingBlock: [REFS_WITH_GENE_SETS, PACKAGES].join("\n\n"),
        input: { researchQuestion, analystNotes },
    });
}

const PENDING_CONTEXT = renderDataContext({ kind: "pending" }, ANALYSIS_ID);

function pendingSeed(researchQuestion: string): string {
    return composePlannerSeed({
        priorPlanBlock: null,
        dataContextBlock: PENDING_CONTEXT,
        groundingBlock: [REFS_WITH_GENE_SETS, PACKAGES].join("\n\n"),
        input: { researchQuestion },
    });
}

/** The specifics of the profile that a planner with no profile can only invent. */
const PROFILE_SPECIFICS = ["C3", "58,302", "58302", "Homo sapiens", "human", "fibroblast"];

/** With no profile, the planner asks, or it plans with no dataset specifics. */
const NO_INVENTED_SPECIFICS = anyOf(
    decides("request_clarification", ["submit_plan", "report_blocker"]),
    all(callsAny(["submit_plan"]), inputLacks("submit_plan", PROFILE_SPECIFICS)),
);

/** The real knowledge tools, over the knowledge service of the eval (`lib/agent.ts`). */
const KNOWLEDGE_TOOLS: Readonly<Record<string, ToolScript>> = {
    ...PLANNER_TOOLS,
    knowledge_recommend: REAL_TOOL,
    knowledge_check: REAL_TOOL,
};

/** The last accepted `submit_plan` comes after a `knowledge_check`. A submit that the host refused before the check is free. */
function acceptedAfterCheck(trial: Trial): Grade {
    const check = trial.calls.findIndex((call) => call.tool === "knowledge_check");
    const accepted = trial.calls.findLastIndex((call) => call.tool === "submit_plan" && parseUnknownRecord(call.value)?.accepted === true);
    if (accepted === -1) return { pass: false, detail: "no accepted submit_plan" };
    return check !== -1 && check < accepted
        ? { pass: true, detail: "the accepted plan follows a check" }
        : { pass: false, detail: "an accepted plan with no check before it" };
}

const KNOWLEDGE: Pick<EvalCase, "agent" | "tools" | "maxSteps" | "pool"> = {
    agent: "planner-knowledge",
    tools: KNOWLEDGE_TOOLS,
    maxSteps: 12,
    pool: BASE_POOL,
};

/** The accepted plan comes after a `knowledge_recommend` answer and a `knowledge_check` of the draft, with one check. */
const RECOMMEND_THEN_CHECK = all(
    before({ tool: "knowledge_recommend" }, { tool: "knowledge_check" }),
    acceptedAfterCheck,
    atMost({ tool: "knowledge_check" }, 1),
);

const SC_PROFILE: DataProfileResult = {
    ...PROFILE,
    summary: "Single-cell RNA-seq of PBMCs, one AnnData file of 48,213 cells.",
    files: [
        { path: "data/inputs/f-sc/pbmc.h5ad", description: "AnnData with raw counts", dataType: "count-matrix", format: "H5AD", rows: 48_213, cols: 33_538 },
    ],
    subtype: "single-cell-rna-seq",
    condition: "two donors",
    experimentalDesign: "Peripheral blood mononuclear cells of two donors, one sample each.",
    qualityAssessment: { concerns: [] },
};

const SC_PYTHON = ["scanpy", "anndata", "leidenalg", "celltypist", "scvi-tools"];
const SC_PACKAGES = `${PACKAGES}, ${SC_PYTHON.join(", ")}`;
const SC_POOL = poolOf(R_BASE, [...PYTHON_BASE, ...SC_PYTHON]);

function scSeed(researchQuestion: string): string {
    return composePlannerSeed({
        priorPlanBlock: null,
        dataContextBlock: renderDataContext({ kind: "ready", result: SC_PROFILE }, ANALYSIS_ID),
        groundingBlock: [REFS_WITH_GENE_SETS, SC_PACKAGES].join("\n\n"),
        input: { researchQuestion },
    });
}

const PLANNER: Pick<EvalCase, "agent" | "tools" | "maxSteps" | "pool"> = { agent: "planner", tools: PLANNER_TOOLS, maxSteps: 10, pool: BASE_POOL };

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
    {
        id: "plan-packages-resolve",
        set: "dev",
        source: "issue #512: half of the accepted plans name a package that the pool cannot resolve to one package",
        user: networkSeed("Group the significant genes of treated against control into co-expression modules, and show the network of each module."),
        ...PLANNER,
        tools: NETWORK_TOOLS,
        pool: poolOf(NETWORK_CENSUS.r, NETWORK_CENSUS.python),
        grade: plans("a plan whose packages each resolve to one package of the pool", packagesResolve(NETWORK_CENSUS)),
    },
    {
        id: "plan-packages-resolve-held-out",
        set: "held-out",
        source: "paraphrase of plan-packages-resolve",
        user: networkSeed("Build a correlation network of the genes that the treatment changes, find its communities, and cluster the samples on them."),
        ...PLANNER,
        tools: NETWORK_TOOLS,
        pool: poolOf(NETWORK_CENSUS.r, NETWORK_CENSUS.python),
        grade: plans("a plan whose packages each resolve to one package of the pool", packagesResolve(NETWORK_CENSUS)),
    },
    {
        id: "plan-capability-exact",
        set: "dev",
        source: "planner prompt: copy one capability phrase of the agent, spelled as the catalog spells it",
        user: seed("Which genes change between treated and control, and which hallmark pathways do they point to?"),
        ...PLANNER,
        grade: plans("a plan whose capabilities each match the catalog", capabilitiesExact),
    },
    {
        id: "plan-capability-exact-held-out",
        set: "held-out",
        source: "paraphrase of plan-capability-exact",
        user: seed("Find the genes that respond to the treatment, and run a KEGG enrichment on them."),
        ...PLANNER,
        grade: plans("a plan whose capabilities each match the catalog", capabilitiesExact),
    },
    {
        id: "plan-skips-completed-step",
        set: "dev",
        source: "planner prompt: do not re-plan steps that completed",
        user: revisionSeed("Now add a hallmark enrichment of the significant genes."),
        ...PLANNER,
        grade: plans("a plan that does not run the differential expression again", noSecondDe),
    },
    {
        id: "plan-skips-completed-step-held-out",
        set: "held-out",
        source: "paraphrase of plan-skips-completed-step",
        user: revisionSeed("Extend the analysis: cluster the significant genes by their expression pattern and test each cluster for KEGG enrichment."),
        ...PLANNER,
        grade: plans("a plan that does not run the differential expression again", noSecondDe),
    },
    {
        id: "plan-analyst-notes-win",
        set: "dev",
        source: "planner prompt: where an analyst note contradicts the Data Context, the note wins",
        user: notesSeed(
            "Which genes change between treated and control?",
            "Sample T3 is a control. The sample sheet has its group label swapped, so the design is 2 treated against 4 control.",
        ),
        ...PLANNER,
        grade: submits("submit_plan", ["T3"]),
    },
    {
        id: "plan-analyst-notes-win-held-out",
        set: "held-out",
        source: "paraphrase of plan-analyst-notes-win",
        user: notesSeed(
            "Find the differentially expressed genes of the treatment.",
            "C1 and T1 come from donor A, C2 and T2 from donor B, C3 and T3 from donor C. The samples are paired by donor.",
        ),
        ...PLANNER,
        grade: submits("submit_plan", ["donor"]),
    },
    {
        id: "plan-pending-profile-no-invention",
        set: "dev",
        source: "planner prompt: with profiling pending, do not invent dataset specifics",
        user: pendingSeed("Which genes are differentially expressed between the conditions?"),
        ...PLANNER,
        grade: NO_INVENTED_SPECIFICS,
    },
    {
        id: "plan-pending-profile-no-invention-held-out",
        set: "held-out",
        source: "paraphrase of plan-pending-profile-no-invention",
        user: pendingSeed("Find the genes and the pathways that differ between my groups."),
        ...PLANNER,
        grade: NO_INVENTED_SPECIFICS,
    },
    {
        id: "plan-knowledge-recommend-and-check",
        set: "dev",
        source: "knowledge_recommend and knowledge_check descriptions: the procedure before a method step, and one check of the draft",
        user: seed("Which genes change between treated and control, and which pathways do they point to?"),
        ...KNOWLEDGE,
        grade: RECOMMEND_THEN_CHECK,
    },
    {
        id: "plan-knowledge-recommend-and-check-held-out",
        set: "held-out",
        source: "paraphrase of plan-knowledge-recommend-and-check",
        user: seed("Find the differentially expressed genes of the treatment, and test them for hallmark enrichment."),
        ...KNOWLEDGE,
        grade: RECOMMEND_THEN_CHECK,
    },
    {
        id: "plan-knowledge-skips-uncovered",
        set: "dev",
        source: "counter-case of plan-knowledge-recommend-and-check: the service covers expression analyses, not a single-cell clustering",
        user: scSeed("Cluster the cells and label each cluster with its cell type."),
        ...KNOWLEDGE,
        pool: SC_POOL,
        tools: {
            ...KNOWLEDGE_TOOLS,
            list_available_packages: { ok: { available: true, total: 20, returned: 20, hasMore: false, content: SC_PACKAGES.split("\n").slice(2).join("\n") } },
        },
        grade: all(callsAny(["submit_plan"]), never(["knowledge_recommend"])),
    },
    {
        id: "plan-knowledge-skips-uncovered-held-out",
        set: "held-out",
        source: "paraphrase of plan-knowledge-skips-uncovered",
        user: scSeed("Which cell types does this sample hold, and in what proportions?"),
        ...KNOWLEDGE,
        pool: SC_POOL,
        tools: {
            ...KNOWLEDGE_TOOLS,
            list_available_packages: { ok: { available: true, total: 20, returned: 20, hasMore: false, content: SC_PACKAGES.split("\n").slice(2).join("\n") } },
        },
        grade: all(callsAny(["submit_plan"]), never(["knowledge_recommend"])),
    },
    {
        id: "plan-packages-habitual-absent",
        set: "dev",
        source: "issue #512: a plan names the habitual package (ggplot2, pheatmap, umap-learn) that the census does not hold",
        user: seed("Which genes change between treated and control? Show a volcano plot, a heatmap of the top 50 genes, and a UMAP of the samples."),
        ...PLANNER,
        grade: plans("a plan whose packages each resolve to one package of the pool", packagesResolve({ r: R_BASE, python: PYTHON_BASE })),
    },
    {
        id: "plan-packages-habitual-absent-held-out",
        set: "held-out",
        source: "paraphrase of plan-packages-habitual-absent",
        user: seed("Find the treatment response, and give me publication figures: a volcano plot, a clustered heatmap, and a 2-D embedding of the samples."),
        ...PLANNER,
        grade: plans("a plan whose packages each resolve to one package of the pool", packagesResolve({ r: R_BASE, python: PYTHON_BASE })),
    },
];
