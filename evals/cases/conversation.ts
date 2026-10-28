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

import { all, assistantText, atMostWith, callsAny, decides, never, priorCall, threadRecord, userMessage, type EvalCase, type TurnState } from "../lib/case.js";

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
    const named = ["ISG15", "MX1", "IFIT1"];
    const rows = ["gene_id,symbol,log2FoldChange,padj"];
    for (let i = 0; i < 610; i += 1) {
        const up = i < 3 || i % 3 !== 2;
        const symbol = named[i] ?? `LOC${105_000 + i * 7}`;
        const lfc = (up ? 1 : -1) * (i < 3 ? 4 - i * 0.45 : 1.1 + ((i * 37) % 200) / 100);
        rows.push(`ENSG${String(100_000 + i * 13).padStart(11, "0")},${symbol},${lfc.toFixed(2)},${(1e-38 * 1.12 ** i).toExponential(2)}`);
    }
    return rows.join("\n");
}

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
        maxSteps: 5,
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
        user: "Put the genes that the run found into genes.txt, I want to send them to a collaborator.",
        maxSteps: 5,
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
];
