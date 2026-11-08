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

import type { KnowledgeClient, RecommendResponse } from "@inflexa-ai/harness/tools/knowledge/client.js";
import { z } from "zod";

import { EVAL_SNAPSHOT, evalKnowledgeClient, REAL_TOOL, type ToolScript } from "../lib/agent.js";
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

/** The question of the hypothesis cases, as the conversation agent passes it after a completed DE run. */
const FEEDBACK_QUESTION =
    "Test whether negative regulators of interferon signaling (for example SOCS1, SOCS3, USP18, and ISG15) go up with the treatment compared with control. The earlier differential expression run found an interferon response: 412 genes up and 198 down at FDR 0.05.";

/** The same question with the analogy that the user chose to pursue, explained in biology. */
const FEEDBACK_WITH_ANALOGY = `${FEEDBACK_QUESTION} The hypothesis comes from an analogy with thermostat negative feedback: the signal that switches on the interferon response also switches on its own dampers.`;

/** The plan tests the hypothesis on the data, and no step models the analogy itself. */
const TESTS_HYPOTHESIS = plans("a step that tests the negative regulators, and no step that models the analogy", (steps) => {
    const text = (step: PlanStepView): string => `${step.name} ${step.question} ${step.description}`;
    const tests = steps.some((step) => /SOCS|USP18|negative (regulator|feedback)/i.test(text(step)));
    const speculative = steps.some((step) =>
        /thermostat|control (theory|engineering|model)|feedback (control )?model|\bODE\b|dynamical model|circuit/i.test(`${step.name} ${step.question}`),
    );
    return tests && !speculative;
});

const COHORT_PROFILE: DataProfileResult = {
    ...PROFILE,
    summary: "Bulk RNA-seq of 60 tumor biopsies before treatment, with the response of each patient to the therapy.",
    files: [
        {
            path: "data/inputs/f-counts/counts.tsv",
            description: "Raw gene-level count matrix",
            dataType: "count-matrix",
            format: "TSV",
            rows: 58_302,
            cols: 60,
        },
        {
            path: "data/inputs/f-clin/clinical.csv",
            description: "Clinical table: patient, response (responder or non-responder), age, stage",
            dataType: "clinical-metadata",
            format: "CSV",
            rows: 60,
            cols: 4,
        },
    ],
    condition: "responders vs non-responders",
    experimentalDesign: "One biopsy of each of 60 patients before the therapy: 24 responders and 36 non-responders.",
    qualityAssessment: { concerns: [] },
};

function cohortSeed(researchQuestion: string): string {
    return composePlannerSeed({
        priorPlanBlock: null,
        dataContextBlock: renderDataContext({ kind: "ready", result: COHORT_PROFILE }, ANALYSIS_ID),
        groundingBlock: [REFS_WITH_GENE_SETS, PACKAGES].join("\n\n"),
        input: { researchQuestion },
    });
}

/** The census of the routing cases: the references and the packages that an immune and a repurposing step need. */
const ROUTING_REFS = [
    REFS_WITH_GENE_SETS,
    "- immune/lm22/LM22.txt (file, 112340 bytes; LM22 leukocyte signature matrix, CIBERSORT, signatures, Homo sapiens)",
    "    TSV — 547 genes by 22 human immune cell types",
    "- lincs/l1000/cp_signatures.gmt (file, 48211340 bytes; LINCS L1000 compound signatures, 2020, gene-sets, Homo sapiens)",
    "    GMT — the up and the down genes of each compound perturbation, by drug name",
].join("\n");
const ROUTING_R = [...R_BASE, "immunedeconv", "GSVA"];
const ROUTING_PACKAGES = [
    "## Available Packages",
    "",
    "## R packages",
    `  ${ROUTING_R.join(", ")}`,
    "",
    "## Python packages",
    `  ${PYTHON_BASE.join(", ")}`,
].join("\n");
const ROUTING_POOL = poolOf(ROUTING_R, PYTHON_BASE);

/** The listings of the routing cases agree with their census. */
const ROUTING_TOOLS: Readonly<Record<string, ToolScript>> = {
    ...PLANNER_TOOLS,
    list_available_refs: { ok: { available: true, content: ROUTING_REFS.split("\n").slice(2).join("\n") } },
    list_available_packages: {
        ok: { available: true, total: 17, returned: 17, hasMore: false, content: ROUTING_PACKAGES.split("\n").slice(2).join("\n") },
    },
};

function routingSeed(profile: DataProfileResult, researchQuestion: string): string {
    return composePlannerSeed({
        priorPlanBlock: null,
        dataContextBlock: renderDataContext({ kind: "ready", result: profile }, ANALYSIS_ID),
        groundingBlock: [ROUTING_REFS, ROUTING_PACKAGES].join("\n\n"),
        input: { researchQuestion },
    });
}

/**
 * A modeling step selects the features inside the cross-validation, or it reports its estimate as optimistic. A
 * signature from the DE genes of the same samples is already a selection, thus a model on it alone overstates its
 * accuracy.
 */
const SELECTS_INSIDE_CV = plans("a modeling step that selects inside the cross-validation, or calls its estimate optimistic", (steps) =>
    steps.some(
        (step) =>
            step.agent === "statistical-modeling-agent" &&
            /cross-?validat|nested|\bCV\b/i.test(`${step.question} ${step.description}`) &&
            /(inside|within|in each|in every|nested)[^.]{0,60}(fold|cross-?validat|\bCV\b|loop)|optimistic/i.test(`${step.question} ${step.description}`),
    ),
);

const MOUSE_PROFILE: DataProfileResult = {
    ...PROFILE,
    summary: "Bulk RNA-seq of mouse liver, 6 samples, treated against control.",
    organism: { scientificName: "Mus musculus", taxonId: "10090", source: "metadata", confidence: "high" },
};

const MOUSE_REFS = [
    "- msigdb/hallmark/mh.all.v2024.1.Mm.symbols.gmt (file, 171230 bytes; MSigDB mouse hallmark, 2024.1, gene-sets, Mus musculus)",
    "    GMT — 50 hallmark gene sets of mouse gene symbols",
    "- gencode/vM35/gencode.vM35.annotation.gtf.gz (file, 31220114 bytes; GENCODE, M35, annotation, Mus musculus)",
    "    GTF — the gene annotation of the mouse genome",
].join("\n");

/** The reference census of a mouse study: the human sets come first, and the mouse sets of the same collection follow. */
const BOTH_ORGANISM_REFS = [REFS_WITH_GENE_SETS, MOUSE_REFS].join("\n");

function organismSeed(refs: string, researchQuestion: string): string {
    return composePlannerSeed({
        priorPlanBlock: null,
        dataContextBlock: renderDataContext({ kind: "ready", result: MOUSE_PROFILE }, ANALYSIS_ID),
        groundingBlock: [refs, PACKAGES].join("\n\n"),
        input: { researchQuestion },
    });
}

function refsTools(refs: string): Readonly<Record<string, ToolScript>> {
    return { ...PLANNER_TOOLS, list_available_refs: { ok: { available: true, content: refs.split("\n").slice(2).join("\n") } } };
}

const MOUSE_WORDS = /\bmouse\b|\bmurine\b|Mus musculus|\bMm\b|mh\.all|ortholog/i;
const HUMAN_RESOURCE = /\.Hs\.|h\.all\.v|Homo sapiens/;

/**
 * A step that uses gene sets names the organism of the dataset, or the ortholog mapping that bridges the two, and no
 * step names a human resource. A step that asks names the gap instead.
 */
const MATCHES_ORGANISM = plans("a plan whose gene-set step names the mouse resource or an ortholog mapping, and no human resource", (steps) => {
    const text = (step: PlanStepView): string => `${step.name} ${step.question} ${step.description}`;
    const enrichment = steps.filter((step) => step.agent === "enrichment-agent");
    const geneSets = enrichment.length > 0 ? enrichment : steps.filter((step) => /hallmark|GSEA/i.test(text(step)));
    return geneSets.length > 0 && geneSets.every((step) => MOUSE_WORDS.test(text(step))) && !steps.some((step) => HUMAN_RESOURCE.test(text(step)));
});

/** With the human sets only, the planner asks for the mouse sets, or it plans with an ortholog mapping that it states. */
const NO_SILENT_HUMAN_SETS = anyOf(decides("request_clarification", ["submit_plan", "report_blocker"]), MATCHES_ORGANISM);

/** `to` reaches `from` through the `depends_on` edges of the plan. */
function dependsOn(steps: readonly PlanStepView[], from: PlanStepView, to: PlanStepView): boolean {
    const byId = new Map(steps.map((step) => [step.id, step]));
    const seen = new Set<string>();
    const queue = [...from.depends_on];
    while (queue.length > 0) {
        const id = queue.shift() ?? "";
        if (id === to.id) return true;
        if (seen.has(id)) continue;
        seen.add(id);
        queue.push(...(byId.get(id)?.depends_on ?? []));
    }
    return false;
}

/**
 * The edges follow the data: the enrichment step reaches the DE step whose genes it reads, and the immune step does
 * not wait for the enrichment. The immune step can wait for the DE step only to read a matrix that the DE step writes,
 * and its text names that matrix. An edge that no data needs holds a step back, and the run loses its parallel wave.
 */
const DEPENDENCIES_FOLLOW_DATA = plans("enrichment after DE, and an immune step that waits only for data it reads", (steps) => {
    const de = steps.find((step) => step.agent === "bulk-transcriptomics-agent" && /differential|DE\b|DESeq|responder/i.test(`${step.name} ${step.question}`));
    const enrichment = steps.find((step) => step.agent === "enrichment-agent");
    const immune = steps.find((step) => step.agent === "immune-profiling-agent");
    if (de === undefined || enrichment === undefined || immune === undefined) return false;
    const readsMatrix = /TPM|VST|normali[sz]ed|expression matrix|log-?CPM/i.test(`${immune.question} ${immune.description}`);
    return dependsOn(steps, enrichment, de) && (!dependsOn(steps, immune, de) || readsMatrix) && !dependsOn(steps, immune, enrichment);
});

const GroundedStepSchema = z.object({
    id: z.string(),
    grounding: z
        .object({
            status: z.string(),
            snapshot: z.string().catch(""),
            template: z.string().optional(),
            claims: z.array(z.string()).catch([]),
            settings: z.array(z.object({ name: z.string(), value: z.unknown() })).catch([]),
        })
        .optional(),
});
type GroundedStep = z.infer<typeof GroundedStepSchema>;

const AcceptedPlanSchema = z.object({ plan: z.object({ steps: z.array(GroundedStepSchema) }) });

/** The plan of the last `submit_plan` that the host accepted meets `check`. Its whole input is the text that `text` reads. */
function acceptedPlan(describe: string, check: (steps: readonly GroundedStep[], text: string) => boolean): (trial: Trial) => Grade {
    return (trial) => {
        const accepted = trial.calls.findLast((call) => call.tool === "submit_plan" && parseUnknownRecord(call.value)?.accepted === true);
        if (accepted === undefined) return { pass: false, detail: "no accepted submit_plan" };
        const parsed = AcceptedPlanSchema.safeParse(accepted.input);
        if (!parsed.success) return { pass: false, detail: "the accepted submit_plan holds no plan with steps" };
        const grounding = parsed.data.plan.steps.map((step) => `${step.id}:${step.grounding?.status ?? "-"}:${step.grounding?.template ?? "-"}`).join(", ");
        return check(parsed.data.plan.steps, JSON.stringify(accepted.input))
            ? { pass: true, detail: `${describe} (${grounding})` }
            : { pass: false, detail: `not ${describe} (${grounding})` };
    };
}

const DraftedStepViewSchema = z.object({
    steps: z.array(z.object({ step_type: z.string(), method: z.string().catch(""), method_id: z.string().optional(), outcome: z.string().optional() })),
});
type DraftedStepView = z.infer<typeof DraftedStepViewSchema>["steps"][number];

/** The drafted steps of each `knowledge_check` call, in the order of the calls. */
function checkedDrafts(trial: Trial): (readonly DraftedStepView[])[] {
    return trial.calls.filter((call) => call.tool === "knowledge_check").map((call) => DraftedStepViewSchema.safeParse(call.input).data?.steps ?? []);
}

/** The knowledge service of the eval with its recommendation changed by `change`. */
function recommendWith(change: (answer: RecommendResponse) => RecommendResponse): () => Partial<KnowledgeClient> {
    return () => ({
        recommend: async (...args) => {
            const answer = await evalKnowledgeClient.recommend(...args);
            return "procedure" in answer ? change(answer) : answer;
        },
    });
}

/** The DE step keeps the template and the settings of the skeleton. `submit_plan` repairs a claim id by its rule, thus the grade reads no claim. */
const KEEPS_SKELETON = acceptedPlan("a step keeps the template and the alpha setting of the skeleton", (steps) =>
    steps.some(
        (step) =>
            step.grounding?.template === "tpl-deseq2-two-group@1.2.0" &&
            step.grounding.settings.some((setting) => setting.name === "alpha" && setting.value === 0.05),
    ),
);

const DESCRIPTIVE_FLAG = {
    rule: "R-0050",
    severity: "blocking",
    message: "With two samples in a group, the dispersion estimate has no power: report the fold changes only, with no test.",
    outcome: "descriptive_only",
};

/** Two samples in each group: the service flags the test, and the outcome of the step is descriptive. */
const FLAGGED_KNOWLEDGE = recommendWith((answer) => ({
    ...answer,
    match: "flag",
    flags: [DESCRIPTIVE_FLAG],
    procedure: answer.procedure.map((step) => (step.step === "differential_expression" ? { ...step, flags: [DESCRIPTIVE_FLAG] } : step)),
}));

/** The drafted test step carries the outcome of the flag, and the accepted plan marks a step as flagged. */
const STATES_FLAG = all(
    (trial: Trial): Grade => {
        const drafts = checkedDrafts(trial).flat();
        return drafts.some((step) => step.outcome === "descriptive_only")
            ? { pass: true, detail: "a drafted step states descriptive_only" }
            : {
                  pass: false,
                  detail: `no drafted step states descriptive_only (${drafts.map((step) => `${step.step_type}:${step.outcome ?? "-"}`).join(", ") || "no check"})`,
              };
    },
    acceptedPlan("a step is flagged", (steps) => steps.some((step) => step.grounding?.status === "flagged")),
);

/** The first check refuses the shrinkage of the draft, and names the permitted method. A later check passes. */
function refusingFirstCheck(): Partial<KnowledgeClient> {
    let checks = 0;
    return {
        check: () => {
            checks += 1;
            if (checks > 1) return Promise.resolve({ ok: true, snapshot: EVAL_SNAPSHOT, violations: [], warnings: [] });
            return Promise.resolve({
                ok: false,
                snapshot: EVAL_SNAPSHOT,
                warnings: [],
                violations: [
                    {
                        step_type: "shrink_lfc",
                        severity: "error",
                        rule: "R-0035",
                        message: "apeglm shrinks one coefficient of the model, and this contrast is not one: use ashr (M-0006).",
                        permitted: ["M-0006"],
                    },
                ],
            });
        },
    };
}

/** The accepted plan follows a check, and it uses the method that the violation permits. A second check is optional. */
const REVISES_AFTER_VIOLATION = all(
    acceptedAfterCheck,
    acceptedPlan("the plan names ashr", (_steps, text) => /ashr/i.test(text)),
);

/** The census and the pool of the revision case hold ashr, the method that the check permits. */
const ASHR_PACKAGES = [
    "## Available Packages",
    "",
    "## R packages",
    `  ${[...R_BASE, "ashr"].join(", ")}`,
    "",
    "## Python packages",
    `  ${PYTHON_BASE.join(", ")}`,
].join("\n");

function ashrSeed(researchQuestion: string): string {
    return composePlannerSeed({
        priorPlanBlock: null,
        dataContextBlock: DATA_CONTEXT,
        groundingBlock: [REFS_WITH_GENE_SETS, ASHR_PACKAGES].join("\n\n"),
        input: { researchQuestion },
    });
}

/** The service did not answer: the planner plans from the prose skills, and it claims no grounding. */
const UNAVAILABLE_KNOWLEDGE = (): Partial<KnowledgeClient> => ({
    recommend: () => Promise.resolve({ match: "unavailable", reason: "the knowledge service did not answer after 3 tries" }),
});

const PLANS_UNGROUNDED = acceptedPlan("a plan with no grounded step", (steps) =>
    steps.every((step) => step.grounding === undefined || (step.grounding.status !== "grounded" && step.grounding.snapshot !== EVAL_SNAPSHOT.digest)),
);

/** A dose study: vehicle and three doses, three replicates each. The two-group procedure of the service does not fit it. */
const DOSE_PROFILE: DataProfileResult = {
    ...PROFILE,
    summary: "Bulk RNA-seq of hepatocytes after 24 h of compound X at four doses, 12 samples.",
    files: [
        {
            path: "data/inputs/f-counts/counts.tsv",
            description: "Raw gene-level count matrix",
            dataType: "count-matrix",
            format: "TSV",
            rows: 58_302,
            cols: 12,
        },
        {
            path: "data/inputs/f-meta/samples.csv",
            description: "Sample sheet: sample, dose_nM, batch",
            dataType: "clinical-metadata",
            format: "CSV",
            rows: 12,
            cols: 3,
        },
    ],
    condition: "dose of compound X: 0, 1, 10, 100 nM",
    experimentalDesign: "Four dose levels (0, 1, 10, 100 nM), three biological replicates each, one time point.",
    qualityAssessment: { concerns: [] },
};

const TIME_PROFILE: DataProfileResult = {
    ...DOSE_PROFILE,
    summary: "Bulk RNA-seq of macrophages at five times after LPS, 15 samples.",
    files: [
        {
            path: "data/inputs/f-counts/counts.tsv",
            description: "Raw gene-level count matrix",
            dataType: "count-matrix",
            format: "TSV",
            rows: 58_302,
            cols: 15,
        },
        {
            path: "data/inputs/f-meta/samples.csv",
            description: "Sample sheet: sample, hours, donor",
            dataType: "clinical-metadata",
            format: "CSV",
            rows: 15,
            cols: 3,
        },
    ],
    condition: "time after LPS: 0, 1, 4, 8, 24 h",
    experimentalDesign: "Five time points (0, 1, 4, 8, 24 h) after LPS, three donors, each donor at each time.",
};

function profileSeed(profile: DataProfileResult, researchQuestion: string): string {
    return composePlannerSeed({
        priorPlanBlock: null,
        dataContextBlock: renderDataContext({ kind: "ready", result: profile }, ANALYSIS_ID),
        groundingBlock: [REFS_WITH_GENE_SETS, PACKAGES].join("\n\n"),
        input: { researchQuestion },
    });
}

/**
 * The service answers its two-group procedure for a design that it does not fit. The plan keeps no step on the
 * two-group template, and it names a model of the real design: a trend over the dose or the time, a likelihood ratio
 * test over the levels, or a curve.
 */
const NO_BLIND_SKELETON = acceptedPlan("a plan with no two-group template, and a model of the design", (steps, text) => {
    const twoGroup = steps.some((step) => step.grounding?.template === "tpl-deseq2-two-group@1.2.0");
    const modelsDesign =
        /LRT|likelihood.?ratio|reduced model|spline|trend|dose.?response|curve|continuous|time.?course|monoton|DRomics|ImpulseDE|maSigPro/i.test(text);
    return !twoGroup && modelsDesign;
});

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
        id: "plan-optional-reference-plans",
        set: "dev",
        source: "planner prompt: an optional reference that is absent is a plan with its fallback stated, not a clarification (counter-case of plan-missing-reference)",
        user: seed(
            "Which genes change between treated and control, and which hallmark pathways do they point to? If the data allows it, a TF activity estimate would be nice too, but it is optional.",
        ),
        ...PLANNER,
        grade: decides("submit_plan", ["request_clarification", "report_blocker"]),
    },
    {
        id: "plan-optional-reference-plans-held-out",
        set: "held-out",
        source: "paraphrase of plan-optional-reference-plans",
        user: seed("Give me the differential expression and a hallmark enrichment. Regulator activity is a bonus if you have what it needs, not a must."),
        ...PLANNER,
        grade: decides("submit_plan", ["request_clarification", "report_blocker"]),
    },
    {
        id: "plan-biomarker-selection-in-cv",
        set: "dev",
        source: "planner prompt: a biomarker model selects its features inside the cross-validation, or reports its estimate as optimistic",
        user: cohortSeed(
            "Find the genes that differ between responders and non-responders, then build a signature from those genes that predicts response. How accurate is it?",
        ),
        ...PLANNER,
        grade: SELECTS_INSIDE_CV,
    },
    {
        id: "plan-biomarker-selection-in-cv-held-out",
        set: "held-out",
        source: "paraphrase of plan-biomarker-selection-in-cv",
        user: cohortSeed("Use the DE genes of response to train a classifier of responders, and give me its accuracy."),
        ...PLANNER,
        grade: SELECTS_INSIDE_CV,
    },
    {
        id: "plan-routes-immune-profiling",
        set: "dev",
        source: "planner prompt: immune cell composition and the tumor microenvironment go to the immune-profiling agent",
        user: routingSeed(COHORT_PROFILE, "What is the immune cell composition of these tumors, and does it differ between responders and non-responders?"),
        ...PLANNER,
        pool: ROUTING_POOL,
        tools: ROUTING_TOOLS,
        grade: plans("an immune-profiling step", (steps) => steps.some((step) => step.agent === "immune-profiling-agent")),
    },
    {
        id: "plan-routes-immune-profiling-held-out",
        set: "held-out",
        source: "paraphrase of plan-routes-immune-profiling",
        user: routingSeed(
            COHORT_PROFILE,
            "Estimate the infiltrating immune cells of each biopsy, and compare the T cell signals of responders and non-responders.",
        ),
        ...PLANNER,
        pool: ROUTING_POOL,
        tools: ROUTING_TOOLS,
        grade: plans("an immune-profiling step", (steps) => steps.some((step) => step.agent === "immune-profiling-agent")),
    },
    {
        id: "plan-routes-drug-repurposing",
        set: "dev",
        source: "planner prompt: a question of which existing drugs could reverse a signature goes to the drug-repurposing agent, not to cheminformatics",
        user: routingSeed(PROFILE, "Which approved drugs could reverse the transcriptional signature of the treatment?"),
        ...PLANNER,
        pool: ROUTING_POOL,
        tools: ROUTING_TOOLS,
        grade: plans("a drug-repurposing step", (steps) => steps.some((step) => step.agent === "drug-repurposing-agent")),
    },
    {
        id: "plan-routes-drug-repurposing-held-out",
        set: "held-out",
        source: "paraphrase of plan-routes-drug-repurposing",
        user: routingSeed(
            PROFILE,
            "Find existing therapeutics whose expression profile is the opposite of the response to the treatment, as repositioning candidates.",
        ),
        ...PLANNER,
        pool: ROUTING_POOL,
        tools: ROUTING_TOOLS,
        grade: plans("a drug-repurposing step", (steps) => steps.some((step) => step.agent === "drug-repurposing-agent")),
    },
    {
        id: "plan-organism-matches",
        set: "dev",
        source: "planner prompt: match the organism to the dataset; a human resource on mouse data gives confident, meaningless numbers",
        user: organismSeed(BOTH_ORGANISM_REFS, "Which genes change between treated and control, and which hallmark pathways do they point to?"),
        ...PLANNER,
        tools: refsTools(BOTH_ORGANISM_REFS),
        grade: MATCHES_ORGANISM,
    },
    {
        id: "plan-organism-matches-held-out",
        set: "held-out",
        source: "paraphrase of plan-organism-matches",
        user: organismSeed(
            BOTH_ORGANISM_REFS,
            "Rank the genes by their response to the treatment, and run a GSEA of the ranking against the hallmark collection.",
        ),
        ...PLANNER,
        tools: refsTools(BOTH_ORGANISM_REFS),
        grade: MATCHES_ORGANISM,
    },
    {
        id: "plan-organism-absent-no-silent-human",
        set: "dev",
        source: "planner prompt: match the organism; with only human gene sets for mouse data, ask or state the ortholog mapping (counter-case of plan-organism-matches)",
        user: organismSeed(REFS_WITH_GENE_SETS, "Which genes change between treated and control, and which hallmark pathways do they point to?"),
        ...PLANNER,
        grade: NO_SILENT_HUMAN_SETS,
    },
    {
        id: "plan-organism-absent-no-silent-human-held-out",
        set: "held-out",
        source: "paraphrase of plan-organism-absent-no-silent-human",
        user: organismSeed(
            REFS_WITH_GENE_SETS,
            "Rank the genes by their response to the treatment, and run a GSEA of the ranking against the hallmark collection.",
        ),
        ...PLANNER,
        grade: NO_SILENT_HUMAN_SETS,
    },
    {
        id: "plan-dependencies-follow-data",
        set: "dev",
        source: "planner prompt: start a new step for work that needs the result of a step; validate-plan checks only that each dependency exists and that no cycle forms",
        user: routingSeed(
            COHORT_PROFILE,
            "Find the genes that differ between responders and non-responders and the hallmark pathways they enrich. Also estimate the immune cell composition of each biopsy.",
        ),
        ...PLANNER,
        pool: ROUTING_POOL,
        tools: ROUTING_TOOLS,
        grade: DEPENDENCIES_FOLLOW_DATA,
    },
    {
        id: "plan-dependencies-follow-data-held-out",
        set: "held-out",
        source: "paraphrase of plan-dependencies-follow-data",
        user: routingSeed(
            COHORT_PROFILE,
            "Two questions: how does the immune infiltrate of the tumors compare between the response groups, and which pathways do the differentially expressed genes of response enrich?",
        ),
        ...PLANNER,
        pool: ROUTING_POOL,
        tools: ROUTING_TOOLS,
        grade: DEPENDENCIES_FOLLOW_DATA,
    },
    {
        id: "plan-hypothesis-plain",
        set: "dev",
        source: "analogy experiment: the planner gets the hypothesis with no analogy",
        user: seed(FEEDBACK_QUESTION),
        ...PLANNER,
        grade: TESTS_HYPOTHESIS,
    },
    {
        id: "plan-hypothesis-with-analogy",
        set: "dev",
        source: "analogy experiment: the planner gets the hypothesis with the analogy that it came from, explained in biology",
        user: seed(FEEDBACK_WITH_ANALOGY),
        ...PLANNER,
        grade: TESTS_HYPOTHESIS,
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
        id: "plan-knowledge-keeps-skeleton",
        set: "dev",
        source: "knowledge_recommend description and the grounding schema: copy the skeleton step, its template, its settings, and its claim ids",
        user: seed("Which genes change between treated and control, and which pathways do they point to?"),
        ...KNOWLEDGE,
        grade: KEEPS_SKELETON,
    },
    {
        id: "plan-knowledge-keeps-skeleton-held-out",
        set: "held-out",
        source: "paraphrase of plan-knowledge-keeps-skeleton",
        user: seed("Give me the differentially expressed genes of the treatment, with the pathways that they enrich."),
        ...KNOWLEDGE,
        grade: KEEPS_SKELETON,
    },
    {
        id: "plan-knowledge-flag-descriptive",
        set: "dev",
        source: "knowledge_recommend description: obey the outcome of a flag; knowledge_check: the drafted step states the outcome",
        user: seed("Which genes change between treated and control?", {
            userConstraints: "C3 and T3 failed the library QC and are excluded, thus two samples in each group remain.",
        }),
        ...KNOWLEDGE,
        knowledge: FLAGGED_KNOWLEDGE,
        grade: STATES_FLAG,
    },
    {
        id: "plan-knowledge-flag-descriptive-held-out",
        set: "held-out",
        source: "paraphrase of plan-knowledge-flag-descriptive",
        user: seed("Find the genes that respond to the treatment.", {
            userConstraints: "Drop C3 and T3: their libraries failed. Two replicates per condition are left.",
        }),
        ...KNOWLEDGE,
        knowledge: FLAGGED_KNOWLEDGE,
        grade: STATES_FLAG,
    },
    {
        id: "plan-knowledge-check-revises",
        set: "dev",
        source: "knowledge_check description: revise a violation once, with the permitted method, then check again",
        user: ashrSeed("Which genes change between treated and control, and which pathways do they point to?"),
        ...KNOWLEDGE,
        pool: poolOf([...R_BASE, "ashr"], PYTHON_BASE),
        maxSteps: 14,
        knowledge: refusingFirstCheck,
        grade: REVISES_AFTER_VIOLATION,
    },
    {
        id: "plan-knowledge-check-revises-held-out",
        set: "held-out",
        source: "paraphrase of plan-knowledge-check-revises",
        user: ashrSeed("Plan the differential expression of the treatment and a hallmark enrichment of the result."),
        ...KNOWLEDGE,
        pool: poolOf([...R_BASE, "ashr"], PYTHON_BASE),
        maxSteps: 14,
        knowledge: refusingFirstCheck,
        grade: REVISES_AFTER_VIOLATION,
    },
    {
        id: "plan-knowledge-unavailable-plans",
        set: "dev",
        source: "knowledge client: an unavailable service is a normal state, and the plan states its steps as ungrounded",
        user: seed("Which genes change between treated and control, and which pathways do they point to?"),
        ...KNOWLEDGE,
        knowledge: UNAVAILABLE_KNOWLEDGE,
        grade: PLANS_UNGROUNDED,
    },
    {
        id: "plan-knowledge-unavailable-plans-held-out",
        set: "held-out",
        source: "paraphrase of plan-knowledge-unavailable-plans",
        user: seed("Find the differentially expressed genes, then test them for pathway enrichment."),
        ...KNOWLEDGE,
        knowledge: UNAVAILABLE_KNOWLEDGE,
        grade: PLANS_UNGROUNDED,
    },
    {
        id: "plan-knowledge-unfit-not-copied",
        set: "dev",
        source: "knowledge_recommend description: the service is a source, not an order; a procedure that does not fit the design is not copied",
        user: profileSeed(DOSE_PROFILE, "Which genes respond to compound X in a dose-dependent way, and at what dose does each response start?"),
        ...KNOWLEDGE,
        grade: NO_BLIND_SKELETON,
    },
    {
        id: "plan-knowledge-unfit-not-copied-held-out",
        set: "held-out",
        source: "paraphrase of plan-knowledge-unfit-not-copied: a time course in place of a dose series",
        user: profileSeed(
            TIME_PROFILE,
            "Find the genes whose expression changes over the time course after LPS, and group them by the shape of their response.",
        ),
        ...KNOWLEDGE,
        grade: NO_BLIND_SKELETON,
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
