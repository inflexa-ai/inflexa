/**
 * The decision cases of the conversation agent.
 *
 * Each case that requires an action has a counter-case where the same context
 * requires a different action, or none. Thus a prompt change that makes the
 * agent act on each request fails the counter-case. The `held-out` cases say
 * the same requests in other words. Keep them out of a hill-climb loop: a
 * candidate that passes `dev` and drops on `held-out` fits the words of the
 * cases, not the behavior.
 */

import { parseUnknownRecord } from "@inflexa-ai/harness/lib/unknown-containers.js";

import { renderWorkingMemory } from "@inflexa-ai/harness/memory/working-memory.js";

import {
    all,
    assistantText,
    atMost,
    inScripts,
    atMostCalls,
    atMostWith,
    callsAny,
    decides,
    inputLacks,
    mentions,
    never,
    neverSays,
    notAsked,
    notMentions,
    numbersGrounded,
    priorCall,
    says,
    submits,
    threadRecord,
    userMessage,
    type EvalCase,
    type TurnState,
} from "../lib/case.js";
import type { ScriptedResult } from "../lib/agent.js";

const LITERATURE_TOOLS = ["pubmed", "search_semantic_scholar", "search_arxiv"];
const RUN_TOOLS = ["execute_analysis", "generate_plan"];

const PROFILE = {
    state: "ready",
    profile: {
        organism: "Homo sapiens",
        domain: "bulk RNA-seq",
        design: "two-group comparison, treated against control, three biological replicates for each group",
        groups: [
            { name: "treated", samples: ["T1", "T2", "T3"] },
            { name: "control", samples: ["C1", "C2", "C3"] },
        ],
        files: {
            total: 2,
            hasMore: false,
            members: [
                { path: "/analysis-001/data/inputs/f-counts/counts.tsv", type: "gene count matrix", dimensions: { genes: 58_302, samples: 6 } },
                { path: "/analysis-001/data/inputs/f-meta/samples.csv", type: "sample sheet", columns: ["sample", "group", "batch"] },
            ],
        },
        qualityConcerns: ["sample C3 has a library size 40% below the median"],
    },
};

/** The user asked what the data holds, and the agent read the profile. */
const PROFILED = [
    userMessage("I uploaded my RNA-seq counts. What is in there?"),
    ...priorCall("inspect_data_profile", {}, PROFILE),
    assistantText(
        "Your data is a human bulk RNA-seq count matrix: 58,302 genes across 6 samples, treated (T1-T3) against control (C1-C3). " +
            "A sample sheet gives the group and the sequencing batch of each sample. One note: C3 has a library size about 40% below the median.",
    ),
];

const PROFILE_TOOLS = { inspect_data_profile: { ok: PROFILE } };

const RUN_STARTED = { ok: { runId: "0193f7a2-6c1e-7a00-9b1a-2f4c8d9e0a11", started: true } };

const RUN_IN_PROGRESS = {
    ok: {
        inspectionState: "in_progress",
        run: { runId: "0193f7a2-6c1e-7a00-9b1a-2f4c8d9e0a11", status: "running", steps: [{ stepId: "differential-expression", status: "running" }] },
    },
};

/** The differential expression run of {@link RUN_STARTED_HISTORY}, running at the turn. */
const DE_RUN_RUNNING: TurnState = { runningRuns: [{ runId: "0193f7a2-6c1e-7a00-9b1a-2f4c8d9e0a11", startedAt: "2026-10-27T09:12:04.000Z" }] };

/** The run of the approved plan of {@link PLAN_APPROVED_HISTORY}, running at the turn. */
const PLAN_RUN_RUNNING: TurnState = {
    runningRuns: [{ runId: "0193f7a2-7d2f-7b00-8c2b-3a5d9e0f1b22", planId: "pln-1a2b3c4d", startedAt: "2026-10-27T09:20:41.000Z" }],
};

/** A differential expression run that started on an earlier turn. */
const RUN_STARTED_HISTORY = [
    ...PROFILED,
    userMessage("Run a differential expression analysis, treated against control."),
    ...priorCall("execute_analysis", { mode: "adhoc", request: "Run a differential expression analysis, treated against control." }, RUN_STARTED.ok),
    assistantText("The differential expression run started. It runs in the background, and I can read its results when it completes."),
];

/** A plan that the user approved. The approval record says that its run started. */
const PLAN_APPROVED_HISTORY = [
    ...PROFILED,
    userMessage("Plan a full analysis: differential expression, then pathway enrichment of the significant genes."),
    ...priorCall(
        "generate_plan",
        { researchQuestion: "Which genes and pathways change between treated and control?" },
        { status: "plan_complete", planId: "pln-1a2b3c4d", steps: ["differential-expression", "pathway-enrichment"] },
    ),
    ...priorCall("show_plan", { planId: "pln-1a2b3c4d" }, { shown: true }),
    assistantText("Here is the plan: differential expression with DESeq2, then a pathway enrichment of the significant genes. Do you approve it?"),
    threadRecord("The person approved plan pln-1a2b3c4d. Run 0193f7a2-7d2f-7b00-8c2b-3a5d9e0f1b22 started."),
];

/** A run that completed, with a synthesis. */
const RUN_DONE = {
    ok: {
        inspectionState: "terminal",
        run: {
            runId: "0193f7a2-6c1e-7a00-9b1a-2f4c8d9e0a11",
            status: "completed",
            synthesisStatus: "produced",
            synthesisPath: "/analysis-001/runs/0193f7a2-6c1e-7a00-9b1a-2f4c8d9e0a11/synthesis.json",
        },
    },
};

const RUN_DONE_HISTORY = [
    ...RUN_STARTED_HISTORY,
    userMessage("Is the run done?"),
    ...priorCall("inspect_run", { runId: "0193f7a2-6c1e-7a00-9b1a-2f4c8d9e0a11" }, RUN_DONE.ok),
    assistantText("Yes. The differential expression run completed, and it produced a synthesis."),
];

const SYNTHESIS = {
    ok: {
        path: "/analysis-001/runs/0193f7a2-6c1e-7a00-9b1a-2f4c8d9e0a11/synthesis.json",
        content: JSON.stringify({
            conclusions: ["Treatment induces an interferon response: 412 genes up and 198 down at FDR 0.05."],
            keyFindings: [{ finding: "ISG15, MX1, and IFIT1 rank highest, log2 fold change 3.1 to 4.0", novelty: "established" }],
            limitations: ["Three replicates for each group", "C3 has a low library size"],
        }),
    },
};

const REPORT_TOOLS = {
    inspect_run: RUN_DONE,
    read_file: SYNTHESIS,
    start_report_session: { ok: { outcome: "started", threadId: "0193f7b0-1111-7c00-8d3c-4b6e0f1a2c33" } },
};

/** The tools of a file whose content comes from the results of a run that completed. */
const DE_RESULTS_PATH = "/analysis-001/runs/0193f7a2-6c1e-7a00-9b1a-2f4c8d9e0a11/differential-expression/output/de_results.csv";

/** The 610 significant genes that the synthesis counts: 412 up and 198 down, ranked by adjusted p-value. */
function deResultsCsv(): string {
    const named = [
        ["ENSG00000187608", "ISG15"],
        ["ENSG00000157601", "MX1"],
        ["ENSG00000185745", "IFIT1"],
        ["ENSG00000089127", "OAS1"],
        ["ENSG00000134321", "RSAD2"],
    ];
    const rows = ["gene_id,symbol,log2FoldChange,padj"];
    for (let i = 0; i < 610; i += 1) {
        const up = !(i % 3 === 2 && i >= 5 && i <= 596);
        const [geneId, symbol] = named[i] ?? [`ENSG${String(100_000 + i * 13).padStart(11, "0")}`, `LOC${105_000 + i * 7}`];
        const lfc = (up ? 1 : -1) * (i < 3 ? 4 - i * 0.45 : 1.1 + ((i * 37) % 200) / 100);
        rows.push(`${geneId},${symbol},${lfc.toFixed(2)},${(1e-38 * 1.12 ** i).toExponential(2)}`);
    }
    return rows.join("\n");
}

/** The rows of the results table, as `read_table` gives them: a plain number reads as a number. */
const DE_ROWS = deResultsCsv()
    .split("\n")
    .slice(1)
    .map((line) => {
        const [geneId = "", symbol = "", lfc = "", padj = ""] = line.split(",");
        return { gene_id: geneId, symbol, log2FoldChange: Number(lfc), padj: Number(padj) };
    });

/** `read_table` of a script over the results table of the run. */
function readTable(input: unknown): { ok: unknown } | { error: string } {
    const path = String(parseUnknownRecord(input)?.path ?? "");
    if (!path.endsWith("de_results.csv")) return { error: `read_table: ${path} does not exist; find the path with workspace_search or list_files` };
    return {
        ok: {
            path: DE_RESULTS_PATH.slice("/analysis-001/".length),
            columns: ["gene_id", "symbol", "log2FoldChange", "padj"],
            rowCount: DE_ROWS.length,
            rows: DE_ROWS,
        },
    };
}

/** `write_derived` of a script: the file lands in the derived directory of the conversation. */
function writeDerived(input: unknown): { ok: unknown } {
    const record = parseUnknownRecord(input);
    const name = String(record?.name ?? "file");
    const text = typeof record?.content === "string" ? record.content : JSON.stringify(record?.rows ?? []);
    return { ok: { path: `conversation-sessions/thread-1/derived/${name}`, bytes: Buffer.byteLength(text) } };
}

/** The count of the genes with an adjusted p-value below 1e-30 and a log2 fold change above 2. */
const STRONG_UP = DE_ROWS.filter((row) => row.padj < 1e-30 && row.log2FoldChange > 2).length;

/** The count of the down-regulated genes with an adjusted p-value below 1e-30. */
const STRONG_DOWN = DE_ROWS.filter((row) => row.padj < 1e-30 && row.log2FoldChange < 0).length;

/** The tools of a file whose content comes from the results of a run that completed. */
const DERIVED_FILE_TOOLS = {
    inspect_run: RUN_DONE,
    read_file: (input: unknown) => {
        const path = String(parseUnknownRecord(input)?.path ?? "");
        if (path.endsWith("synthesis.json")) return SYNTHESIS;
        if (path.endsWith("de_results.csv")) return { ok: { path: DE_RESULTS_PATH, content: deResultsCsv(), totalLines: 611 } };
        return { error: `No file at ${path}.` };
    },
    list_files: {
        ok: {
            entries: [
                { path: "runs/0193f7a2-6c1e-7a00-9b1a-2f4c8d9e0a11/synthesis.json", type: "file" },
                { path: "runs/0193f7a2-6c1e-7a00-9b1a-2f4c8d9e0a11/differential-expression/output/de_results.csv", type: "file" },
                { path: "runs/0193f7a2-6c1e-7a00-9b1a-2f4c8d9e0a11/differential-expression/output/summary.md", type: "file" },
            ],
        },
    },
    workspace_search: {
        ok: {
            results: [
                {
                    path: DE_RESULTS_PATH,
                    type: "output",
                    description: "DESeq2 results of treated against control: the 610 genes at FDR 0.05, with log2 fold change and adjusted p-value",
                },
            ],
        },
    },
    write_file: (input: unknown) => ({ ok: { path: `/analysis-001/${String(parseUnknownRecord(input)?.path ?? "file")}`, bytes: 180 } }),
    read_table: readTable,
    write_derived: writeDerived,
};

/** The lookups of a script about the genes of the run. Each one gives a small answer. */
/** The AML association score of each of the 5 genes with the lowest adjusted p-value. Each score is distinct. */
const AML_SCORES = [0.437, 0.122, 0.385, 0.051, 0.268];
const TOP_GENES = DE_ROWS.slice(0, AML_SCORES.length).map((row, index) => ({ ...row, score: AML_SCORES[index] ?? 0 }));
const AML_ID = "EFO_0000222";

/** Open Targets over the genes of the results table: each action gives the data of the genes that it names. */
function openTargets(input: unknown): { ok: unknown } | { error: string } {
    const record = parseUnknownRecord(input);
    const action = String(record?.action ?? "");
    if (action === "resolve_disease") return { ok: { candidates: [{ id: AML_ID, name: "acute myeloid leukemia", score: 1 }] } };
    if (action === "disease") {
        return {
            ok: {
                disease: { id: AML_ID, name: "acute myeloid leukemia" },
                associatedTargets: TOP_GENES.map((gene) => ({ ensemblId: gene.gene_id, symbol: gene.symbol, score: gene.score })),
            },
        };
    }
    if (action === "target") {
        const id = String(record?.ensemblId ?? "");
        const gene = TOP_GENES.find((row) => row.gene_id === id);
        const associations =
            gene === undefined
                ? []
                : [
                      { diseaseId: AML_ID, disease: "acute myeloid leukemia", score: gene.score },
                      { diseaseId: "EFO_0000616", disease: "neoplasm", score: 0.2 },
                  ];
        return { ok: { target: { ensemblId: id, symbol: gene?.symbol ?? null }, associations } };
    }
    return { error: `opentargets: action ${action} has no data in this answer` };
}

/** Each of the 5 scores, thus the reply gives the score of each gene. */
const GIVES_AML_SCORES = all(...AML_SCORES.map((score) => mentions(String(score))));

const LOOKUP_TOOLS = {
    ...DERIVED_FILE_TOOLS,
    opentargets: openTargets,
    resolve_gene_ids: {
        ok: {
            genes: TOP_GENES.map((gene) => ({ query: gene.symbol, symbol: gene.symbol, name: null, entrez: null, ensembl: [gene.gene_id], uniprot: [] })),
            notFound: [],
            ambiguous: [],
            truncated: [],
        },
    },
    search_gene: {
        ok: {
            genes: TOP_GENES.map((gene, index) => ({
                symbol: gene.symbol,
                id: gene.gene_id,
                displayName: gene.symbol,
                description: `${gene.symbol}, an interferon-stimulated gene`,
                biotype: "protein_coding",
                start: 1_000_000 * (index + 1),
                end: 1_000_000 * (index + 1) + 20_000,
                strand: 1,
                assemblyName: "GRCh38",
                seqRegionName: String(index + 1),
            })),
            resolvedFrom: [],
            notFound: [],
        },
    },
    drug_gene_interactions: { ok: { gene: "ISG15", interactions: [] } },
    chembl: { ok: { results: [] } },
};

/** A single-cell profile: one AnnData file of 48,213 cells. */
const SC_PROFILE = {
    state: "ready",
    profile: {
        organism: "Homo sapiens",
        domain: "single-cell RNA-seq",
        design: "peripheral blood mononuclear cells of two donors",
        files: {
            total: 1,
            hasMore: false,
            members: [{ path: "/analysis-001/data/inputs/f-sc/pbmc.h5ad", type: "AnnData h5ad", dimensions: { cells: 48_213, genes: 33_538 } }],
        },
        qualityConcerns: [],
    },
};

const SC_PROFILED = [
    userMessage("I uploaded my single-cell data. What is in there?"),
    ...priorCall("inspect_data_profile", {}, SC_PROFILE),
    assistantText("Your data is one AnnData file of human PBMCs from two donors: 48,213 cells and 33,538 genes."),
];

const SC_TOOLS = {
    inspect_data_profile: { ok: SC_PROFILE },
    execute_analysis: RUN_STARTED,
    read_table: { error: "read_table: data/inputs/f-sc/pbmc.h5ad has no table format that a script reads (csv, tsv, json, parquet); an analysis run reads it" },
};

/** The tools of a request to put the results into a file. */
const SUMMARY_FILE_TOOLS = { ...REPORT_TOOLS, ...DERIVED_FILE_TOOLS };

const SUMMARY_PDF_TOOLS = {
    ...SUMMARY_FILE_TOOLS,
    render_chart: { ok: { path: "conversation-sessions/thread-1/derived/volcano.svg", bytes: 18_204 } },
    export_pdf: (input: unknown): ScriptedResult => ({
        ok: { path: `conversation-sessions/thread-1/derived/${String(parseUnknownRecord(input)?.name ?? "summary.pdf")}`, bytes: 48_310, missingImages: [] },
    }),
};

const PLAN_TOOLS = {
    ...PROFILE_TOOLS,
    generate_plan: { ok: { status: "plan_complete", planId: "pln-5e6f7a8b", steps: ["quality-control", "differential-expression", "pathway-enrichment"] } },
    show_plan: { ok: { shown: true } },
};

/** The agent offered a computation and asked for consent. The user message of the case gives the consent. */
function offered(question: string, offer: string): EvalCase["history"] {
    return [...PROFILED, userMessage(question), assistantText(offer)];
}

/** A plan that the agent showed, and that the user has not approved yet. */
const PLAN_SHOWN_HISTORY = [
    ...PROFILED,
    userMessage("Plan a full analysis: differential expression, then pathway enrichment of the significant genes."),
    ...priorCall(
        "generate_plan",
        { researchQuestion: "Which genes and pathways change between treated and control?" },
        {
            event: "plan_complete",
            planId: "pln-1a2b3c4d",
            plan: { title: "Treated vs control DE + pathways", steps: ["differential-expression", "pathway-enrichment"] },
        },
    ),
    assistantText("Here is the plan: differential expression with DESeq2, then a pathway enrichment of the significant genes. Do you approve it?"),
];

/** The numbers that the profile, the run, and the synthesis give. A reply that cites another one invented it. */
// 600 is 610 rounded, which a reply can give for the total.
const RUN_DONE_NUMBERS = ["58302", "40", "412", "198", "610", "600", "0.05", "3.1", "4.0", "15", "16"];

/** A completed run of two steps with no synthesis. Each step has its summary. */
const RUN_NO_SYNTHESIS = {
    ok: {
        inspectionState: "terminal",
        run: {
            runId: "0193f7a2-6c1e-7a00-9b1a-2f4c8d9e0a11",
            status: "completed",
            synthesisStatus: "skipped",
            synthesisReason: "the run had no plan narrative",
            steps: [
                { stepId: "T1S1", status: "completed", summaryPath: "/analysis-001/runs/0193f7a2-6c1e-7a00-9b1a-2f4c8d9e0a11/T1S1/output/summary.md" },
                { stepId: "T1S2", status: "completed", summaryPath: "/analysis-001/runs/0193f7a2-6c1e-7a00-9b1a-2f4c8d9e0a11/T1S2/output/summary.md" },
            ],
        },
    },
};

const STEP_SUMMARIES: Readonly<Record<string, string>> = {
    "T1S1/output/summary.md":
        "## Differential expression\n\nDESeq2, treated against control, 3 replicates for each group. 287 genes at padj < 0.05: 164 up and 123 down. C3 stayed in the model.",
    "T1S2/output/summary.md":
        "## Pathway enrichment\n\nfgsea over the hallmark sets. 7 sets at padj < 0.05. Up: TNFA_SIGNALING_VIA_NFKB (NES 2.12), HYPOXIA (NES 1.74). Down: E2F_TARGETS (NES -2.03).",
};

// The hallmark collection holds 50 sets, a fact of the collection and not a result.
const STEP_SUMMARY_NUMBERS = ["58302", "40", "287", "164", "123", "0.05", "2.12", "1.74", "2.03", "-2.03", "50"];

const NO_SYNTHESIS_TOOLS = {
    inspect_run: RUN_NO_SYNTHESIS,
    read_file: (input: unknown): ScriptedResult => {
        const path = String(parseUnknownRecord(input)?.path ?? "");
        const hit = Object.entries(STEP_SUMMARIES).find(([name]) => path.endsWith(name));
        return hit === undefined ? { error: `No file at ${path}.` } : { ok: { path, content: hit[1] } };
    },
};

/** A run that the agent started on this turn. Nothing tells the agent when it ends. */
const LAUNCH_TOOLS = { ...PROFILE_TOOLS, execute_analysis: RUN_STARTED };

/** A promise to come back on its own, which the agent cannot keep: no event wakes it when a run ends (issue #248). */
const LATER_CHECK =
    /\b(I'll|I will|I'm going to|I am going to) (let you know|notify you|ping you|update you|report back|follow up|come back|keep an eye|monitor|check (back|in|on (it|the run|its progress)))|\bwhen it (finishes|completes|is done)[^.]*\b(I'll|I will)\b/i;

/** A reply that tells the user that a file does not exist. */
const NOT_FOUND =
    /not (been )?(found|exist|there|present|available)|(couldn't|could not|can't|cannot|unable to|did not|didn't) (find|locate|open)|no (such )?file|doesn't exist|does not exist|no file/i;

/** The sample sheet of {@link PROFILE}, as `read_file` gives it. */
const SAMPLE_SHEET = {
    ok: {
        path: "/analysis-001/data/inputs/f-meta/samples.csv",
        content: "sample,group,batch\nT1,treated,1\nT2,treated,2\nT3,treated,1\nC1,control,1\nC2,control,2\nC3,control,1\n",
    },
};

const MISSING_FILE_TOOLS = {
    read_file: { ok: { status: "not_found", path: "/analysis-001/results/old_run/de_results.csv" } },
    list_files: { ok: { entries: [{ path: "data/inputs/f-counts/counts.tsv", type: "file" }] } },
    workspace_search: { ok: { results: [] } },
};

const ANALOGY_REPORT = {
    ok: {
        schemaVersion: "1",
        report: {
            problem: "An interferon response that the treatment induces in fibroblasts, and its escape.",
            analogies: [
                { analogyTitle: "Viral latency and interferon escape", targetDomain: "virology", rationale: "Latent viruses mute the same ISG program." },
                {
                    analogyTitle: "Tachyphylaxis of receptor signaling",
                    targetDomain: "pharmacology",
                    rationale: "Repeated stimulation desensitizes the pathway.",
                },
            ],
        },
    },
};

const ANALOGY_HISTORY = [
    ...RUN_DONE_HISTORY,
    userMessage("What other fields deal with a system that switches on its own brakes? I want fresh angles on this response."),
    ...priorCall("generate_analogy_report", { problem: "A strong interferon response and the brakes that the cells put on it" }, ANALOGY_REPORT.ok),
    assistantText(
        "Two analogies stand out. Thermostat negative feedback: the signal that switches a controller on also switches on its damper, " +
            "which here means that the treatment would also raise the negative regulators of interferon signaling, such as SOCS1, USP18, and ISG15 itself. " +
            "Circuit breaker load shedding: past a limit, the downstream programs shut off. Which one do you want to pursue?",
    ),
];

/** The words of the analogy report that must not reach a workflow input. */
const ANALOGY_WORDS = ["analog", "thermostat", "circuit breaker", "load shedding", "control engineering", "power systems"];

/** A report session that started on an earlier turn. */
const REPORT_STARTED_HISTORY = [
    ...RUN_DONE_HISTORY,
    userMessage("Make a report of this run for my lab meeting."),
    ...priorCall(
        "start_report_session",
        { brief: "A report of the treatment response for a lab meeting." },
        { outcome: "started", threadId: "0193f7b0-1111-7c00-8d3c-4b6e0f1a2c33", title: "Treatment response" },
    ),
    assistantText("The report session started. The report takes shape in that chat."),
];

const REPORT_EXISTING_TOOLS = {
    ...REPORT_TOOLS,
    start_report_session: { ok: { outcome: "existing-session", threadId: "0193f7b0-1111-7c00-8d3c-4b6e0f1a2c33", title: "Treatment response" } },
};

const REFS_LIST = {
    ok: {
        collections: [
            {
                collection: "genomes",
                datasets: [
                    { id: "GRCh38", installed: true },
                    { id: "GRCm39", installed: false },
                ],
            },
            { collection: "gene-sets", datasets: [{ id: "MSigDB hallmark 2024.1", installed: true }] },
        ],
    },
};

const REFS_TOOLS = {
    list_available_refs: REFS_LIST,
    run_inflexa: {
        ok: {
            status: "ran",
            exitCode: 0,
            stdout: "genomes:\n  GRCh38   installed\n  GRCm39   available\ngene-sets:\n  msigdb-hallmark   installed",
            stderr: "",
        },
    },
};

const FDR_MEMORY: TurnState = {
    workingMemory: renderWorkingMemory({
        goal: "Find the transcriptional response to the treatment.",
        constraints: [{ id: "c0a1b2c3", text: "Use FDR 0.01 for every significance cut.", origin: "user" }],
        hypotheses: [],
        findings: {},
    }),
};

const HYPOTHESIS_MEMORY: TurnState = {
    workingMemory: renderWorkingMemory({
        goal: "Find the transcriptional response to the treatment.",
        constraints: [],
        hypotheses: [
            { id: "9f3e2d1c", text: "The treatment acts through NF-kB signaling." },
            { id: "4b5a6c7d", text: "The interferon response comes from a paracrine loop." },
        ],
        findings: {},
    }),
};

/** `update_working_memory` answers as the real tool: ok, with the section of the input. */
const MEMORY_UPDATED = (input: unknown): ScriptedResult => ({ ok: { ok: true, section: String(parseUnknownRecord(input)?.section ?? "goal") } });

const MEMORY_TOOLS = { ...PROFILE_TOOLS, update_working_memory: MEMORY_UPDATED };

/** A long conversation whose lasting facts are not in the working memory yet: a constraint of the user and a finding of a run. */
const LONG_HISTORY = [
    ...RUN_DONE_HISTORY,
    userMessage("What did it find?"),
    ...priorCall("read_file", { path: SYNTHESIS.ok.path }, SYNTHESIS.ok),
    assistantText("The treatment induces an interferon response: 412 genes up and 198 down at FDR 0.05, led by ISG15, MX1, and IFIT1."),
    userMessage("C3 worries me. From now on, leave C3 out of every analysis."),
    assistantText("Understood: C3 stays out of each analysis from now on."),
    userMessage("And what is ISG15 known for?"),
    ...priorCall(
        "pubmed",
        { query: "ISG15 interferon" },
        { totalFound: 1, results: [{ pmid: "31501552", title: "ISG15 in antiviral immunity", year: "2019" }] },
    ),
    assistantText("ISG15 is a ubiquitin-like protein that interferon induces. It conjugates to proteins in the antiviral response."),
];

/** The same facts, already in the working memory. */
const LONG_MEMORY: TurnState = {
    workingMemory: renderWorkingMemory({
        goal: "Find the transcriptional response to the treatment.",
        constraints: [{ id: "a1b2c3d4", text: "Leave sample C3 out of every analysis.", origin: "user" }],
        hypotheses: [],
        findings: {
            "0193f7a2-6c1e-7a00-9b1a-2f4c8d9e0a11": [{ id: "e5f6a7b8", text: "The treatment induces an interferon response (412 up, 198 down at FDR 0.05)." }],
        },
    }),
};

const COMPACT_TOOLS = { ...REPORT_TOOLS, update_working_memory: MEMORY_UPDATED };

/** The C3 rule of the memory, in other words. A new rule that names C3, such as a rerun of a run with C3, is new. */
const RESTATES_C3 = /(leave|exclud|drop|remov|omit|without)\w*[^.]*\bC3\b|\bC3\b[^.]*\b(out|exclud)/i;

/** No call adds the C3 constraint, which the memory holds already. A revise of the entry is free. */
const noSecondC3: EvalCase["grade"] = (trial) => {
    const hit = trial.calls.find((call) => {
        const input = parseUnknownRecord(call.input);
        return (
            call.tool === "update_working_memory" &&
            input?.section === "constraint" &&
            (input.operation ?? "add") === "add" &&
            RESTATES_C3.test(String(input.text ?? "")) &&
            !/\brun\b|recompute|rerun|re-run/i.test(String(input.text ?? ""))
        );
    });
    return hit === undefined ? { pass: true, detail: "no second C3 constraint" } : { pass: false, detail: `added again: ${JSON.stringify(hit.input)}` };
};

/** The exchange ends with a summary: a reply with text and no call. */
const SUMMARIZES = says(/\w{20,}|\w+ \w+ \w+ \w+ \w+/);

export const conversationCases: readonly EvalCase[] = [
    {
        id: "literature-search",
        set: "dev",
        source: "brief: a literature question gets a literature tool call, not an answer from memory",
        user: "What papers exist on TP53 in AML?",
        maxSteps: 2,
        grade: callsAny(LITERATURE_TOOLS),
    },
    {
        id: "write-file",
        set: "dev",
        source: "brief: a file with given content is a write_file call, never an analysis run",
        user: "Create a file notes/primers.md with this content:\n\n# Primers\n\nGAPDH-F: GGAGCGAGATCCCTCCAAAAT\nGAPDH-R: GGCTGTTGTCATACTTCTCATGG",
        maxSteps: 3,
        tools: { write_file: { ok: { path: "/analysis-001/notes/primers.md", bytes: 92 } }, list_files: { ok: { entries: [] } } },
        grade: all(decides("write_file", ["execute_analysis", "edit_file"]), never(["execute_analysis"])),
    },
    {
        id: "adhoc-differential-expression",
        set: "dev",
        source: "brief: an explicit computation on profiled data is execute_analysis mode=adhoc",
        history: PROFILED,
        user: "Run a differential expression analysis on my data, treated against control.",
        maxSteps: 3,
        tools: { ...PROFILE_TOOLS, execute_analysis: RUN_STARTED },
        grade: decides("execute_analysis", ["generate_plan"], { mode: "adhoc" }),
    },
    {
        id: "trivial-question-no-run",
        set: "dev",
        source: "complaint: an ad hoc analysis for a trivial request that the profile answers",
        history: PROFILED,
        user: "How many samples are in each group?",
        maxSteps: 3,
        tools: PROFILE_TOOLS,
        grade: never(RUN_TOOLS),
    },
    {
        id: "conceptual-question-no-run",
        set: "dev",
        source: "conversation prompt: a computation that only the agent suggests needs consent first",
        history: PROFILED,
        user: "Would shrinking the log fold changes matter for a design this small?",
        maxSteps: 3,
        tools: PROFILE_TOOLS,
        grade: never(RUN_TOOLS),
    },
    {
        id: "consent-given-runs",
        set: "dev",
        source: "complaint: the agent asks for approval a second time after the user agreed",
        history: offered(
            "Is there a batch effect in my data?",
            "I can check with a PCA of the six samples, colored by sequencing batch. That runs an ad hoc analysis in the sandbox. Shall I run it?",
        ),
        user: "Yes, go ahead.",
        maxSteps: 2,
        tools: { ...PROFILE_TOOLS, execute_analysis: RUN_STARTED },
        grade: decides("execute_analysis", ["generate_plan"], { mode: "adhoc" }),
    },
    {
        id: "run-in-progress-one-wait",
        set: "dev",
        source: "issue #520: the agent polls inspect_run for the life of a run",
        history: RUN_STARTED_HISTORY,
        state: DE_RUN_RUNNING,
        user: "Wait for it to finish and tell me the result.",
        maxSteps: 5,
        tools: { ...PROFILE_TOOLS, inspect_run: RUN_IN_PROGRESS },
        grade: all(atMostWith("inspect_run", "waitForTerminalSeconds", 1), never(RUN_TOOLS)),
    },
    {
        id: "approved-plan-no-relaunch",
        set: "dev",
        source: "conversation prompt: an approval record means that the run of the plan started",
        history: PLAN_APPROVED_HISTORY,
        state: PLAN_RUN_RUNNING,
        user: "Great. What happens now?",
        maxSteps: 2,
        tools: { ...PROFILE_TOOLS, inspect_run: RUN_IN_PROGRESS },
        grade: never(RUN_TOOLS),
    },
    {
        id: "report-on-request",
        set: "dev",
        source: "conversation prompt: a clear request for a report starts a report session with no confirmation",
        history: RUN_DONE_HISTORY,
        user: "Create a report of this run for my lab meeting on Friday.",
        maxSteps: 3,
        tools: REPORT_TOOLS,
        grade: decides("start_report_session", ["execute_analysis", "generate_plan", "write_file", "show_user"]),
    },
    {
        id: "summary-no-report",
        set: "dev",
        source: "conversation prompt: a summary request gets an answer, and a report session only on request",
        history: RUN_DONE_HISTORY,
        user: "What did the run find, in two sentences?",
        maxSteps: 3,
        tools: REPORT_TOOLS,
        grade: never(["start_report_session", ...RUN_TOOLS]),
    },
    {
        id: "write-derived-file",
        set: "dev",
        source: "complaint: the agent starts an analysis run to write a file whose content it can read",
        history: RUN_DONE_HISTORY,
        user: "Save the top genes of this run to notes/top-genes.md.",
        maxSteps: 8,
        tools: DERIVED_FILE_TOOLS,
        grade: all(decides("write_file", RUN_TOOLS), never(RUN_TOOLS)),
    },
    {
        id: "plan-request-no-run",
        set: "dev",
        source: "conversation prompt: a plan request gets a plan, and its run waits for the approval of the user",
        history: PROFILED,
        user: "Plan a full analysis of this data: quality control, differential expression, then pathway enrichment.",
        maxSteps: 3,
        tools: PLAN_TOOLS,
        grade: all(decides("generate_plan", ["execute_analysis"]), never(["execute_analysis"])),
    },
    {
        id: "filter-result-table",
        set: "dev",
        source: "research: a filter of a result table is light work, not an analysis run",
        history: RUN_DONE_HISTORY,
        user: "How many genes have an adjusted p-value below 1e-30 and a log2 fold change above 2?",
        maxSteps: 5,
        tools: DERIVED_FILE_TOOLS,
        grade: all(never(RUN_TOOLS), callsAny(["read_table", "read_file"]), mentions(String(STRONG_UP))),
    },
    {
        id: "lookup-batch",
        set: "dev",
        source: "research: a batch of lookups over the genes of a run runs in one script, not in a run",
        history: RUN_DONE_HISTORY,
        user: "Get the Open Targets association score with acute myeloid leukemia for the top 5 genes by adjusted p-value.",
        maxSteps: 8,
        tools: LOOKUP_TOOLS,
        grade: all(never(RUN_TOOLS), inScripts("opentargets", 2), GIVES_AML_SCORES),
    },
    {
        id: "enrichment-stays-adhoc",
        set: "dev",
        source: "counter-case of filter-result-table: an enrichment is a method of the sandbox",
        history: RUN_DONE_HISTORY,
        user: "Run a hallmark gene set enrichment of the significant genes.",
        maxSteps: 4,
        tools: { ...DERIVED_FILE_TOOLS, execute_analysis: RUN_STARTED },
        grade: decides("execute_analysis", ["generate_plan"], { mode: "adhoc" }),
    },
    {
        id: "large-file-stays-adhoc",
        set: "dev",
        source: "counter-case of filter-result-table: a table that a script cannot read is work for a run",
        history: SC_PROFILED,
        user: "Compute the QC metrics of each cell: the genes detected, the total counts, and the mitochondrial fraction.",
        maxSteps: 4,
        tools: SC_TOOLS,
        grade: decides("execute_analysis", ["generate_plan"], { mode: "adhoc" }),
    },
    {
        id: "summary-to-markdown-file",
        set: "dev",
        source: "complaint: a request to put the results into a markdown file started a report session",
        history: RUN_DONE_HISTORY,
        user: "Summarize the findings of this run into a markdown file that I can share with my PI.",
        maxSteps: 8,
        tools: SUMMARY_FILE_TOOLS,
        grade: all(never(["start_report_session", ...RUN_TOOLS]), callsAny(["write_file", "write_derived"])),
    },
    {
        id: "literature-search-held-out",
        set: "held-out",
        source: "paraphrase of literature-search",
        user: "Is there any recent research on FLT3 inhibitor resistance?",
        maxSteps: 2,
        grade: callsAny(LITERATURE_TOOLS),
    },
    {
        id: "write-file-held-out",
        set: "held-out",
        source: "paraphrase of write-file",
        user: "Save these notes as meeting/2026-10-27.md:\n\n- rerun QC without C3\n- ask Dana for the batch dates",
        maxSteps: 3,
        tools: { write_file: { ok: { path: "/analysis-001/meeting/2026-10-27.md", bytes: 64 } }, list_files: { ok: { entries: [] } } },
        grade: all(decides("write_file", ["execute_analysis", "edit_file"]), never(["execute_analysis"])),
    },
    {
        id: "adhoc-differential-expression-held-out",
        set: "held-out",
        source: "paraphrase of adhoc-differential-expression",
        history: PROFILED,
        user: "Compare gene expression between the treated and the control samples and give me the significant genes.",
        maxSteps: 3,
        tools: { ...PROFILE_TOOLS, execute_analysis: RUN_STARTED },
        grade: decides("execute_analysis", ["generate_plan"], { mode: "adhoc" }),
    },
    {
        id: "trivial-question-no-run-held-out",
        set: "held-out",
        source: "paraphrase of trivial-question-no-run",
        history: PROFILED,
        user: "Which organism is this data from, and how many genes does the matrix have?",
        maxSteps: 3,
        tools: PROFILE_TOOLS,
        grade: never(RUN_TOOLS),
    },
    {
        id: "conceptual-question-no-run-held-out",
        set: "held-out",
        source: "paraphrase of conceptual-question-no-run",
        history: PROFILED,
        user: "With only three replicates for each group, should I worry about the statistical power?",
        maxSteps: 3,
        tools: PROFILE_TOOLS,
        grade: never(RUN_TOOLS),
    },
    {
        id: "consent-given-runs-held-out",
        set: "held-out",
        source: "paraphrase of consent-given-runs",
        history: offered(
            "Does C3 look like an outlier?",
            "I can compute a sample-to-sample distance heatmap and a PCA to check C3. That is an ad hoc analysis in the sandbox. Do you want me to run it?",
        ),
        user: "Sure, do it.",
        maxSteps: 2,
        tools: { ...PROFILE_TOOLS, execute_analysis: RUN_STARTED },
        grade: decides("execute_analysis", ["generate_plan"], { mode: "adhoc" }),
    },
    {
        id: "run-in-progress-one-wait-held-out",
        set: "held-out",
        source: "paraphrase of run-in-progress-one-wait",
        history: RUN_STARTED_HISTORY,
        state: DE_RUN_RUNNING,
        user: "Is it done yet? Keep checking until it is.",
        maxSteps: 5,
        tools: { ...PROFILE_TOOLS, inspect_run: RUN_IN_PROGRESS },
        grade: all(atMostWith("inspect_run", "waitForTerminalSeconds", 1), never(RUN_TOOLS)),
    },
    {
        id: "approved-plan-no-relaunch-held-out",
        set: "held-out",
        source: "paraphrase of approved-plan-no-relaunch",
        history: PLAN_APPROVED_HISTORY,
        state: PLAN_RUN_RUNNING,
        user: "Thanks. Anything I need to do now?",
        maxSteps: 2,
        tools: { ...PROFILE_TOOLS, inspect_run: RUN_IN_PROGRESS },
        grade: never(RUN_TOOLS),
    },
    {
        id: "report-on-request-held-out",
        set: "held-out",
        source: "paraphrase of report-on-request",
        history: RUN_DONE_HISTORY,
        user: "Turn these results into a report that I can send to my collaborators.",
        maxSteps: 3,
        tools: REPORT_TOOLS,
        grade: decides("start_report_session", ["execute_analysis", "generate_plan", "write_file", "show_user"]),
    },
    {
        id: "summary-no-report-held-out",
        set: "held-out",
        source: "paraphrase of summary-no-report",
        history: RUN_DONE_HISTORY,
        user: "Give me the short version: what changed with the treatment?",
        maxSteps: 3,
        tools: REPORT_TOOLS,
        grade: never(["start_report_session", ...RUN_TOOLS]),
    },
    {
        id: "write-derived-file-held-out",
        set: "held-out",
        source: "paraphrase of write-derived-file",
        history: RUN_DONE_HISTORY,
        user: "Put the genes that the run found into shared/genes.txt, I want to send them to a collaborator.",
        maxSteps: 8,
        tools: DERIVED_FILE_TOOLS,
        grade: all(decides("write_file", RUN_TOOLS), never(RUN_TOOLS)),
    },
    {
        id: "plan-request-no-run-held-out",
        set: "held-out",
        source: "paraphrase of plan-request-no-run",
        history: PROFILED,
        user: "Design a multi-step analysis for my data, from QC through to pathways.",
        maxSteps: 3,
        tools: PLAN_TOOLS,
        grade: all(decides("generate_plan", ["execute_analysis"]), never(["execute_analysis"])),
    },
    {
        id: "filter-result-table-held-out",
        set: "held-out",
        source: "paraphrase of filter-result-table",
        history: RUN_DONE_HISTORY,
        user: "Count the down-regulated genes whose adjusted p-value is under 1e-30.",
        maxSteps: 5,
        tools: DERIVED_FILE_TOOLS,
        grade: all(never(RUN_TOOLS), callsAny(["read_table", "read_file"]), mentions(String(STRONG_DOWN))),
    },
    {
        id: "lookup-batch-held-out",
        set: "held-out",
        source: "paraphrase of lookup-batch",
        history: RUN_DONE_HISTORY,
        user: "For the five most significant genes, what does Open Targets say about their link to AML?",
        maxSteps: 8,
        tools: LOOKUP_TOOLS,
        grade: all(never(RUN_TOOLS), inScripts("opentargets", 2), GIVES_AML_SCORES),
    },
    {
        id: "enrichment-stays-adhoc-held-out",
        set: "held-out",
        source: "paraphrase of enrichment-stays-adhoc",
        history: RUN_DONE_HISTORY,
        user: "Test the significant genes for enrichment in the KEGG pathways.",
        maxSteps: 4,
        tools: { ...DERIVED_FILE_TOOLS, execute_analysis: RUN_STARTED },
        grade: decides("execute_analysis", ["generate_plan"], { mode: "adhoc" }),
    },
    {
        id: "large-file-stays-adhoc-held-out",
        set: "held-out",
        source: "paraphrase of large-file-stays-adhoc",
        history: SC_PROFILED,
        user: "Find the cells with fewer than 200 detected genes or more than 10% mitochondrial reads, and tell me how many there are.",
        maxSteps: 4,
        tools: SC_TOOLS,
        grade: decides("execute_analysis", ["generate_plan"], { mode: "adhoc" }),
    },
    {
        id: "summary-to-pdf",
        set: "dev",
        source: "complaint: a request to summarize the results into a PDF started a report session",
        history: RUN_DONE_HISTORY,
        user: "Can you summarize this run into a PDF for my PI?",
        maxSteps: 8,
        tools: SUMMARY_PDF_TOOLS,
        grade: all(never(["start_report_session", ...RUN_TOOLS]), callsAny(["export_pdf"])),
    },
    {
        id: "summary-to-pdf-held-out",
        set: "held-out",
        source: "paraphrase of summary-to-pdf",
        history: RUN_DONE_HISTORY,
        user: "I need the main results as a PDF I can attach to an email.",
        maxSteps: 8,
        tools: SUMMARY_PDF_TOOLS,
        grade: all(never(["start_report_session", ...RUN_TOOLS]), callsAny(["export_pdf"])),
    },
    {
        id: "summary-to-markdown-file-held-out",
        set: "held-out",
        source: "paraphrase of summary-to-markdown-file",
        history: RUN_DONE_HISTORY,
        user: "Write up the key results as a short markdown document.",
        maxSteps: 8,
        tools: SUMMARY_FILE_TOOLS,
        grade: all(never(["start_report_session", ...RUN_TOOLS]), callsAny(["write_file", "write_derived"])),
    },
    {
        id: "plan-approval-launches-plan",
        set: "dev",
        source: "conversation prompt: on approval of a plan, call execute_analysis in plan mode",
        history: PLAN_SHOWN_HISTORY,
        user: "Looks good. Run it.",
        maxSteps: 3,
        tools: { ...PROFILE_TOOLS, execute_analysis: RUN_STARTED },
        grade: decides("execute_analysis", ["generate_plan"], { mode: "plan", planId: "pln-1a2b3c4d" }),
    },
    {
        id: "plan-approval-launches-plan-held-out",
        set: "held-out",
        source: "paraphrase of plan-approval-launches-plan",
        history: PLAN_SHOWN_HISTORY,
        user: "Approved, go ahead with that plan.",
        maxSteps: 3,
        tools: { ...PROFILE_TOOLS, execute_analysis: RUN_STARTED },
        grade: decides("execute_analysis", ["generate_plan"], { mode: "plan", planId: "pln-1a2b3c4d" }),
    },
    {
        id: "interpret-from-synthesis",
        set: "dev",
        source: "conversation prompt: start from the synthesis, and cite a value only from what was read",
        history: RUN_DONE_HISTORY,
        user: "What are the main findings of this run?",
        maxSteps: 4,
        tools: REPORT_TOOLS,
        grade: all(callsAny(["read_file"]), mentions("412"), numbersGrounded(RUN_DONE_NUMBERS), never(["start_report_session", ...RUN_TOOLS])),
    },
    {
        id: "interpret-from-synthesis-held-out",
        set: "held-out",
        source: "paraphrase of interpret-from-synthesis",
        history: RUN_DONE_HISTORY,
        user: "Walk me through what the analysis found.",
        maxSteps: 4,
        tools: REPORT_TOOLS,
        grade: all(callsAny(["read_file"]), mentions("412"), numbersGrounded(RUN_DONE_NUMBERS), never(["start_report_session", ...RUN_TOOLS])),
    },
    {
        id: "interpret-from-step-summaries",
        set: "dev",
        source: "conversation prompt: without a synthesis, integrate the step summaries",
        history: RUN_STARTED_HISTORY,
        user: "The run should be done now. What did it find?",
        maxSteps: 5,
        tools: NO_SYNTHESIS_TOOLS,
        grade: all(mentions("287"), says(/NFKB|NF-?kB|TNF/i), numbersGrounded(STEP_SUMMARY_NUMBERS), never(RUN_TOOLS)),
    },
    {
        id: "interpret-from-step-summaries-held-out",
        set: "held-out",
        source: "paraphrase of interpret-from-step-summaries",
        history: RUN_STARTED_HISTORY,
        user: "Is it finished? If so, give me the results.",
        maxSteps: 5,
        tools: NO_SYNTHESIS_TOOLS,
        grade: all(mentions("287"), says(/NFKB|NF-?kB|TNF/i), numbersGrounded(STEP_SUMMARY_NUMBERS), never(RUN_TOOLS)),
    },
    {
        id: "plan-input-carries-user-facts",
        set: "dev",
        source: "generate_plan description: pass the facts and the constraints of the user, and do not retype the profile",
        history: PROFILED,
        user:
            "Plan the full analysis: differential expression, then pathway enrichment. Use FDR 0.01, not 0.05. " +
            "And note that T2 and C2 were sequenced on a different lane, so lane must be a covariate.",
        maxSteps: 3,
        tools: PLAN_TOOLS,
        grade: all(
            decides("generate_plan", ["execute_analysis"]),
            submits("generate_plan", ["0.01"]),
            submits("generate_plan", ["lane"]),
            inputLacks("generate_plan", ["58,302", "58302", "Homo sapiens"]),
        ),
    },
    {
        id: "plan-input-carries-user-facts-held-out",
        set: "held-out",
        source: "paraphrase of plan-input-carries-user-facts",
        history: PROFILED,
        user:
            "Set up a multi-step analysis from DE to pathways. Two things you can't see in the files: C1 and T1 come from " +
            "the same donor, so pair the samples by donor, and keep the adjusted p-value cut at 0.01.",
        maxSteps: 3,
        tools: PLAN_TOOLS,
        grade: all(
            decides("generate_plan", ["execute_analysis"]),
            submits("generate_plan", ["0.01"]),
            submits("generate_plan", ["donor"]),
            inputLacks("generate_plan", ["58,302", "58302", "Homo sapiens"]),
        ),
    },
    {
        id: "plan-clarification-relayed",
        set: "dev",
        source: "generate_plan description: clarification_needed means the planner misses a fact that only the user has",
        history: PROFILED,
        user: "Plan a paired differential expression analysis of my samples.",
        maxSteps: 6,
        tools: {
            ...PROFILE_TOOLS,
            read_file: SAMPLE_SHEET,
            generate_plan: { ok: { event: "clarification_needed", question: "Which column of the sample sheet pairs each treated sample with its control?" } },
        },
        grade: all(atMost({ tool: "generate_plan" }, 1), never(["execute_analysis"]), says(/pair/i), says(/\?/)),
    },
    {
        id: "plan-clarification-relayed-held-out",
        set: "held-out",
        source: "paraphrase of plan-clarification-relayed",
        history: PROFILED,
        user: "Design an analysis that compares the treatment response between the two batches.",
        maxSteps: 6,
        tools: {
            ...PROFILE_TOOLS,
            read_file: SAMPLE_SHEET,
            generate_plan: {
                ok: { event: "clarification_needed", question: "Is the batch column of the sample sheet the sequencing batch or the treatment batch?" },
            },
        },
        grade: all(atMost({ tool: "generate_plan" }, 1), never(["execute_analysis"]), says(/batch/i), says(/\?/)),
    },
    {
        id: "exploration-gets-analogies",
        set: "dev",
        source: "conversation prompt: analogies are candidate seeds; issue #632: the reply names a card that no UI shows",
        history: RUN_DONE_HISTORY,
        user: "What other fields have dealt with a response like this that fades over time? I want fresh angles.",
        maxSteps: 3,
        tools: { ...REPORT_TOOLS, generate_analogy_report: ANALOGY_REPORT },
        grade: all(callsAny(["generate_analogy_report"]), neverSays(/\bcard\b/i), never(RUN_TOOLS)),
    },
    {
        id: "exploration-gets-analogies-held-out",
        set: "held-out",
        source: "paraphrase of exploration-gets-analogies",
        history: RUN_DONE_HISTORY,
        user: "Think outside biology for a moment: where else does one alarm set off a broad wave of responses like this?",
        maxSteps: 3,
        tools: { ...REPORT_TOOLS, generate_analogy_report: ANALOGY_REPORT },
        grade: all(callsAny(["generate_analogy_report"]), neverSays(/\bcard\b/i), never(RUN_TOOLS)),
    },
    {
        id: "analogy-stays-out-of-plan",
        set: "dev",
        source: "conversation prompt: keep analogies out of generate_plan and each workflow input",
        history: ANALOGY_HISTORY,
        user: "Let's go with the first one. Plan an analysis that tests whether the negative regulators go up with the treatment.",
        maxSteps: 4,
        tools: { ...PLAN_TOOLS, ...REPORT_TOOLS },
        grade: all(callsAny(["generate_plan"]), inputLacks("generate_plan", ANALOGY_WORDS), inputLacks("execute_analysis", ANALOGY_WORDS)),
    },
    {
        id: "analogy-stays-out-of-plan-held-out",
        set: "held-out",
        source: "paraphrase of analogy-stays-out-of-plan",
        history: ANALOGY_HISTORY,
        user: "The feedback idea is interesting. Set up the analysis to check it on my data.",
        maxSteps: 4,
        tools: { ...PLAN_TOOLS, ...REPORT_TOOLS },
        grade: all(callsAny(["generate_plan"]), inputLacks("generate_plan", ANALOGY_WORDS), inputLacks("execute_analysis", ANALOGY_WORDS)),
    },
    {
        id: "report-session-exists",
        set: "dev",
        source: "start_report_session description: an existing session gets the user back to that chat",
        history: REPORT_STARTED_HISTORY,
        user: "Start the report for this run, please.",
        maxSteps: 4,
        tools: REPORT_EXISTING_TOOLS,
        grade: all(
            atMost({ tool: "start_report_session" }, 1),
            never(["write_file", "export_pdf", ...RUN_TOOLS]),
            says(/report (chat|session)|that (chat|session)/i),
        ),
    },
    {
        id: "report-session-exists-held-out",
        set: "held-out",
        source: "paraphrase of report-session-exists",
        history: REPORT_STARTED_HISTORY,
        user: "Make me a report of these results.",
        maxSteps: 4,
        tools: REPORT_EXISTING_TOOLS,
        grade: all(
            atMost({ tool: "start_report_session" }, 1),
            never(["write_file", "export_pdf", ...RUN_TOOLS]),
            says(/report (chat|session)|that (chat|session)/i),
        ),
    },
    {
        id: "refs-question-lists-refs",
        set: "dev",
        source: 'issue #172: "what refs are available" made 6 wrong calls and a question about git refs',
        user: "what refs are available?",
        maxSteps: 4,
        tools: REFS_TOOLS,
        grade: all(callsAny(["list_available_refs", "run_inflexa"]), atMostCalls(4), notAsked("run_inflexa"), neverSays(/\bgit\b/i), mentions("GRCh38")),
    },
    {
        id: "refs-question-lists-refs-held-out",
        set: "held-out",
        source: "paraphrase of refs-question-lists-refs",
        user: "which reference data do I have?",
        maxSteps: 4,
        tools: REFS_TOOLS,
        grade: all(callsAny(["list_available_refs", "run_inflexa"]), atMostCalls(4), notAsked("run_inflexa"), neverSays(/\bgit\b/i), mentions("GRCh38")),
    },
    {
        id: "launch-no-later-check-promise",
        set: "dev",
        source: "issue #248: after a launch the agent promises a check that nothing wakes it for",
        history: PROFILED,
        user: "Run a differential expression analysis, treated against control.",
        maxSteps: 3,
        tools: LAUNCH_TOOLS,
        grade: all(decides("execute_analysis", ["generate_plan"], { mode: "adhoc" }), neverSays(LATER_CHECK)),
    },
    {
        id: "launch-no-later-check-promise-held-out",
        set: "held-out",
        source: "paraphrase of launch-no-later-check-promise",
        history: PROFILED,
        user: "Go ahead and compute the differential expression between the two groups.",
        maxSteps: 3,
        tools: LAUNCH_TOOLS,
        grade: all(decides("execute_analysis", ["generate_plan"], { mode: "adhoc" }), neverSays(LATER_CHECK)),
    },
    {
        id: "missing-file-reported",
        set: "dev",
        source: "issue #281: a not_found result reads as a success",
        history: PROFILED,
        user: "Open results/old_run/de_results.csv and tell me the top gene in it.",
        maxSteps: 6,
        tools: MISSING_FILE_TOOLS,
        grade: all(says(NOT_FOUND), notMentions("ISG15"), never(RUN_TOOLS)),
    },
    {
        id: "missing-file-reported-held-out",
        set: "held-out",
        source: "paraphrase of missing-file-reported",
        history: PROFILED,
        user: "What is the first row of results/old_run/de_results.csv?",
        maxSteps: 6,
        tools: MISSING_FILE_TOOLS,
        grade: all(says(NOT_FOUND), notMentions("ISG15"), never(RUN_TOOLS)),
    },
    {
        id: "memory-conflict-raised",
        set: "dev",
        source: "conversation prompt: a request that breaks a constraint of the working memory raises the conflict",
        history: PROFILED,
        state: FDR_MEMORY,
        user: "Run the differential expression with an FDR cut of 0.05.",
        maxSteps: 3,
        tools: { ...LAUNCH_TOOLS, update_working_memory: MEMORY_UPDATED },
        grade: all(never([...RUN_TOOLS, "update_working_memory"]), mentions("0.01"), says(/\?/)),
    },
    {
        id: "memory-conflict-raised-held-out",
        set: "held-out",
        source: "paraphrase of memory-conflict-raised",
        history: PROFILED,
        state: FDR_MEMORY,
        user: "Find the significant genes, treated against control, at adjusted p below 0.1.",
        maxSteps: 3,
        tools: { ...LAUNCH_TOOLS, update_working_memory: MEMORY_UPDATED },
        grade: all(never([...RUN_TOOLS, "update_working_memory"]), mentions("0.01"), says(/\?/)),
    },
    {
        id: "memory-compatible-runs",
        set: "dev",
        source: "counter-case of memory-conflict-raised: a request that keeps the constraint runs",
        history: PROFILED,
        state: FDR_MEMORY,
        user: "Run the differential expression, treated against control.",
        maxSteps: 3,
        tools: LAUNCH_TOOLS,
        grade: decides("execute_analysis", ["generate_plan"], { mode: "adhoc" }),
    },
    {
        id: "memory-compatible-runs-held-out",
        set: "held-out",
        source: "paraphrase of memory-compatible-runs",
        history: PROFILED,
        state: FDR_MEMORY,
        user: "Compare the treated and the control samples and get me the significant genes.",
        maxSteps: 3,
        tools: LAUNCH_TOOLS,
        grade: decides("execute_analysis", ["generate_plan"], { mode: "adhoc" }),
    },
    {
        id: "memory-records-constraint",
        set: "dev",
        source: "update_working_memory description: promote a binding rule that the user states",
        history: PROFILED,
        user: "From now on, leave sample C3 out of every analysis. Its library is too small.",
        maxSteps: 3,
        tools: MEMORY_TOOLS,
        grade: all(submits("update_working_memory", ["constraint", "C3"]), never(RUN_TOOLS)),
    },
    {
        id: "memory-records-constraint-held-out",
        set: "held-out",
        source: "paraphrase of memory-records-constraint",
        history: PROFILED,
        user: "For this whole project, every test must use a significance cut of FDR 0.01.",
        maxSteps: 3,
        tools: MEMORY_TOOLS,
        grade: all(submits("update_working_memory", ["constraint", "0.01"]), never(RUN_TOOLS)),
    },
    {
        id: "memory-records-constraint-in-passing",
        set: "dev",
        source: "update_working_memory description: a binding rule that the user states inside another request is promoted too",
        history: PROFILED,
        user: "Run the differential expression of treated against control without C3. That sample failed QC, so it stays out of everything from here on.",
        maxSteps: 4,
        tools: { ...LAUNCH_TOOLS, ...MEMORY_TOOLS },
        grade: all(submits("update_working_memory", ["constraint", "C3"]), callsAny(["execute_analysis"]), never(["generate_plan"])),
    },
    {
        id: "memory-records-constraint-in-passing-held-out",
        set: "held-out",
        source: "paraphrase of memory-records-constraint-in-passing",
        history: PROFILED,
        user: "Find the significant genes of treated against control at FDR 0.01. The reviewers want that cut for every test in this project.",
        maxSteps: 4,
        tools: { ...LAUNCH_TOOLS, ...MEMORY_TOOLS },
        grade: all(submits("update_working_memory", ["constraint", "0.01"]), callsAny(["execute_analysis"]), never(["generate_plan"])),
    },
    {
        id: "memory-skips-transient-ask",
        set: "dev",
        source: "counter-case of memory-records-constraint: a transient ask is not promoted",
        history: RUN_DONE_HISTORY,
        user: "Show me the three top genes again.",
        maxSteps: 4,
        tools: { ...REPORT_TOOLS, ...MEMORY_TOOLS },
        grade: never(["update_working_memory"]),
    },
    {
        id: "memory-skips-transient-ask-held-out",
        set: "held-out",
        source: "paraphrase of memory-skips-transient-ask",
        history: RUN_DONE_HISTORY,
        user: "Remind me how many genes went down.",
        maxSteps: 4,
        tools: { ...REPORT_TOOLS, ...MEMORY_TOOLS },
        grade: never(["update_working_memory"]),
    },
    {
        id: "memory-records-finding",
        set: "dev",
        source: "update_working_memory description: a durable conclusion is a finding, cited to its run",
        history: [
            ...RUN_DONE_HISTORY,
            userMessage("What did it find?"),
            ...priorCall("read_file", { path: SYNTHESIS.ok.path }, SYNTHESIS.ok),
            assistantText("The treatment induces an interferon response: 412 genes up and 198 down at FDR 0.05, led by ISG15, MX1, and IFIT1."),
        ],
        user: "That interferon response is our key result. Keep it in mind for the rest of the project.",
        maxSteps: 3,
        tools: { ...REPORT_TOOLS, ...MEMORY_TOOLS },
        grade: submits("update_working_memory", ["finding", "0193f7a2-6c1e-7a00-9b1a-2f4c8d9e0a11"]),
    },
    {
        id: "memory-records-finding-held-out",
        set: "held-out",
        source: "paraphrase of memory-records-finding",
        history: [
            ...RUN_DONE_HISTORY,
            userMessage("What did it find?"),
            ...priorCall("read_file", { path: SYNTHESIS.ok.path }, SYNTHESIS.ok),
            assistantText("The treatment induces an interferon response: 412 genes up and 198 down at FDR 0.05, led by ISG15, MX1, and IFIT1."),
        ],
        user: "Good, the interferon induction is settled then. Record it as a conclusion.",
        maxSteps: 3,
        tools: { ...REPORT_TOOLS, ...MEMORY_TOOLS },
        grade: submits("update_working_memory", ["finding", "0193f7a2-6c1e-7a00-9b1a-2f4c8d9e0a11"]),
    },
    {
        id: "memory-retires-hypothesis",
        set: "dev",
        source: "update_working_memory description: retire a hypothesis once it is resolved or abandoned",
        history: PROFILED,
        state: HYPOTHESIS_MEMORY,
        user: "Drop the NF-kB idea, the enrichment ruled it out.",
        maxSteps: 3,
        tools: MEMORY_TOOLS,
        grade: submits("update_working_memory", ["retire", "9f3e2d1c"]),
    },
    {
        id: "memory-retires-hypothesis-held-out",
        set: "held-out",
        source: "paraphrase of memory-retires-hypothesis",
        history: PROFILED,
        state: HYPOTHESIS_MEMORY,
        user: "We tested the paracrine loop and it's not that. Take it off the list.",
        maxSteps: 3,
        tools: MEMORY_TOOLS,
        grade: submits("update_working_memory", ["retire", "4b5a6c7d"]),
    },
    {
        id: "compaction-promotes-lasting-facts",
        set: "dev",
        source: "compaction prompt: move the lasting facts into the working memory, then reply with the summary",
        history: LONG_HISTORY,
        user: "Next I want to look at the down-regulated genes.",
        compact: true,
        maxSteps: 4,
        tools: COMPACT_TOOLS,
        grade: all(submits("update_working_memory", ["C3"]), submits("update_working_memory", ["0193f7a2-6c1e-7a00-9b1a-2f4c8d9e0a11"]), SUMMARIZES),
    },
    {
        id: "compaction-promotes-lasting-facts-held-out",
        set: "held-out",
        source: "paraphrase of compaction-promotes-lasting-facts",
        history: LONG_HISTORY,
        user: "Can we compare this with the batch 2 samples later?",
        compact: true,
        maxSteps: 4,
        tools: COMPACT_TOOLS,
        grade: all(submits("update_working_memory", ["C3"]), submits("update_working_memory", ["0193f7a2-6c1e-7a00-9b1a-2f4c8d9e0a11"]), SUMMARIZES),
    },
    {
        id: "compaction-no-duplicate-memory",
        set: "dev",
        source: "counter-case of compaction-promotes-lasting-facts: facts that the memory holds are not added again",
        history: LONG_HISTORY,
        state: LONG_MEMORY,
        user: "Next I want to look at the down-regulated genes.",
        compact: true,
        maxSteps: 4,
        tools: COMPACT_TOOLS,
        grade: all(noSecondC3, SUMMARIZES),
    },
    {
        id: "compaction-no-duplicate-memory-held-out",
        set: "held-out",
        source: "paraphrase of compaction-no-duplicate-memory",
        history: LONG_HISTORY,
        state: LONG_MEMORY,
        user: "Can we compare this with the batch 2 samples later?",
        compact: true,
        maxSteps: 4,
        tools: COMPACT_TOOLS,
        grade: all(noSecondC3, SUMMARIZES),
    },
];
