/**
 * The decision cases of the sandbox step agents.
 *
 * The message of each case is the briefing that `execute_analysis` composes at dispatch, from the real composer. The
 * agent works on a throwaway tree with the real workspace tools, the real package listing over a farm lock, and the
 * real link tool over a scripted link answer. A command never runs: the rules of the case and the default rules of
 * `lib/sandbox.ts` answer it.
 */

import type { DataProfileResult } from "@inflexa-ai/harness/contracts/data-profile.js";
import { composeStepBriefing, type TemplateBrief, type UpstreamHandoff } from "@inflexa-ai/harness/prompts/briefing.js";
import type { AnalysisStep } from "@inflexa-ai/harness/schemas/workflow-state.js";
import type { KnowledgeClient, TemplateContract } from "@inflexa-ai/harness/tools/knowledge/client.js";
import type { PackageQuery } from "@inflexa-ai/harness/sandbox/package-identity.js";
import type { PackageRequestOutcome } from "@inflexa-ai/harness/sandbox/types.js";

import { parseUnknownRecord } from "@inflexa-ai/harness/lib/unknown-containers.js";

import { REAL_TOOL, type ToolScript } from "../lib/agent.js";
import {
    all,
    anyOf,
    atMost,
    blockerNot,
    blockerSays,
    callsAny,
    commandLine,
    decides,
    execs,
    assistantText,
    hasFile,
    neverSays,
    inSummary,
    says,
    noFileMatches,
    mentions,
    never,
    neverExec,
    neverWith,
    noCallUnder,
    wroteUnder,
    acceptedProfile,
    settled,
    distinctPaths,
    type CallMatch,
    type Grade,
    type Trial,
    type EvalCase,
} from "../lib/case.js";
import { ANALYSIS_ID, PROFILER_ID, workingDirOf, type ExecRule, type LockedPackage, type SandboxSetup } from "../lib/sandbox.js";

export const ROOT = `/${ANALYSIS_ID}`;
const INSTALL = /pip install|install\.packages|BiocManager|remotes::|devtools::|conda install|mamba install|uv pip/;

/** The genes of the fixtures. The first 412 respond to the treatment: 280 up, 132 down. */
const GENE_COUNT = 2000;
const RESPONDING = 412;
const SYMBOLS = ["ISG15", "MX1", "IFIT1", "STAT1", "IRF7", "OAS1"];

/** The naming of the genes: Ensembl ids and HGNC symbols for human, and the rodent forms for mouse and rat. */
type SymbolStyle = "human" | "mouse" | "rat";

function symbolOf(i: number, style: SymbolStyle = "human"): string {
    const symbol = SYMBOLS[i];
    if (symbol === undefined) return style === "mouse" ? `Gm${10_000 + i}` : `LOC${105_000 + i}`;
    return style === "human" ? symbol : `${symbol.slice(0, 1)}${symbol.slice(1).toLowerCase()}`;
}

function geneIdOf(i: number, style: SymbolStyle = "human"): string {
    const prefix = { human: "ENSG", mouse: "ENSMUSG", rat: "ENSRNOG" }[style];
    return `${prefix}${String(10_000 + i).padStart(11, "0")}`;
}

/** A count matrix of a two-group design, T1-T3 against C1-C3. */
function countsOf(style: SymbolStyle): string {
    return [
        "gene_id\tsymbol\tT1\tT2\tT3\tC1\tC2\tC3",
        ...Array.from({ length: GENE_COUNT }, (_, i) => {
            const base = 50 + ((i * 37) % 900);
            const factor = i < 280 ? 4 : i < RESPONDING ? 0.25 : 1;
            const t = Math.round(base * factor);
            return [geneIdOf(i, style), symbolOf(i, style), t, t + 7, Math.max(0, t - 5), base, base + 3, base - 2].join("\t");
        }),
    ].join("\n");
}

const COUNTS = countsOf("human");

const SAMPLES = ["sample,group,batch", "T1,treated,1", "T2,treated,2", "T3,treated,1", "C1,control,1", "C2,control,2", "C3,control,1"].join("\n");

const BULK_FILES = { "data/inputs/f-counts/counts.tsv": `${COUNTS}\n`, "data/inputs/f-meta/samples.csv": `${SAMPLES}\n` };

function profileOf(organism: { scientificName: string; taxonId: string }, files: DataProfileResult["files"]): DataProfileResult {
    return {
        summary: `Bulk RNA-seq of ${organism.scientificName} cell cultures, 6 samples, treated against control.`,
        files,
        profiledAt: "2026-10-27T08:00:00.000Z",
        domain: "transcriptomics",
        subtype: "bulk-rna-seq",
        organism: { ...organism, source: "metadata", confidence: "high" },
        condition: "treated vs control",
        experimentalDesign: "Two groups, treated (T1-T3) against control (C1-C3), three biological replicates for each group.",
        qualityAssessment: { concerns: [] },
    };
}

const HUMAN = { scientificName: "Homo sapiens", taxonId: "9606" };

const BULK_PROFILE = profileOf(HUMAN, [
    {
        path: "data/inputs/f-counts/counts.tsv",
        description: "Raw gene-level count matrix with Ensembl ids and symbols",
        dataType: "count-matrix",
        format: "TSV",
        rows: GENE_COUNT,
        cols: 8,
    },
    {
        path: "data/inputs/f-meta/samples.csv",
        description: "Sample sheet: sample, group, batch",
        dataType: "clinical-metadata",
        format: "CSV",
        rows: 6,
        cols: 3,
    },
]);

export type StepSpec = {
    readonly stepId: string;
    readonly agent: string;
    readonly name: string;
    readonly question: string;
    readonly constraints?: readonly string[];
    readonly acceptance: readonly string[];
    readonly profile: DataProfileResult | null;
    readonly upstream?: readonly UpstreamHandoff[];
    /** The constraints of the analysis memory, as the user stated them. */
    readonly memoryConstraints?: readonly string[];
    /** The knowledge grounding of the plan step, and the template contract that the scheduler fetched for it. */
    readonly grounding?: NonNullable<AnalysisStep["grounding"]>;
    readonly template?: TemplateBrief;
    /** Why the briefing holds no template contract for a grounding that names a template. */
    readonly templateNotRetrieved?: string;
    /** The request that the plan answers. */
    readonly request?: string;
    /** The goal of the analysis memory. Absent: the transcriptional response of the bulk fixtures. */
    readonly goal?: string;
};

/** The briefing of a step, as the scheduler composes it at dispatch. */
function briefing(spec: StepSpec): string {
    return composeStepBriefing({
        step: {
            id: spec.stepId,
            name: spec.name,
            track: spec.stepId.slice(0, 2),
            step_type: "analysis",
            question: spec.question,
            constraints: spec.constraints === undefined ? undefined : [...spec.constraints],
            acceptance_criteria: [...spec.acceptance],
            depends_on: (spec.upstream ?? []).map((handoff) => handoff.stepId),
            status: "pending",
            agent: spec.agent,
            maxSteps: 200,
            ...(spec.grounding === undefined ? {} : { grounding: spec.grounding }),
        },
        ...(spec.template === undefined ? {} : { template: spec.template }),
        ...(spec.templateNotRetrieved === undefined ? {} : { templateNotRetrieved: spec.templateNotRetrieved }),
        ...(spec.request === undefined ? {} : { request: spec.request }),
        workspace: { analysisId: ANALYSIS_ID, workingDir: workingDirOf({ agentId: spec.agent, stepId: spec.stepId }) },
        profile: spec.profile,
        upstream: spec.upstream ?? [],
        memory: {
            goal: spec.goal ?? "Find the transcriptional response to the treatment.",
            constraints: (spec.memoryConstraints ?? []).map((text, i) => ({ id: `c${String(i).padStart(7, "0")}`, text, origin: "user" as const })),
        },
    });
}

/** The DE step that the enrichment cases depend on: its table, and its summary. */
function deTableOf(style: SymbolStyle): string {
    return [
        "gene_id,symbol,baseMean,log2FoldChange,padj",
        ...Array.from({ length: GENE_COUNT }, (_, i) => {
            const lfc = i < 280 ? 2 - (i % 7) * 0.05 : i < RESPONDING ? -2 + (i % 5) * 0.05 : ((i % 11) - 5) * 0.02;
            const padj = i < RESPONDING ? 1e-6 * (1 + (i % 40)) : 0.06 + (i % 90) / 100;
            return `${geneIdOf(i, style)},${symbolOf(i, style)},${50 + ((i * 37) % 900)},${lfc.toFixed(3)},${padj.toPrecision(3)}`;
        }),
    ].join("\n");
}

const DE_TABLE = deTableOf("human");

const DE_SUMMARY = `# Differential expression\n\nDESeq2, treated against control. ${RESPONDING} of ${GENE_COUNT} genes at adjusted p < 0.05: 280 up, 132 down, led by ISG15, MX1, and IFIT1. The table \`output/de_results.csv\` holds gene_id, symbol (HGNC), baseMean, log2FoldChange, and padj for each gene.\n`;

const QC_TABLE = `sample,library_size,detected_genes\n${["T1", "T2", "T3", "C1", "C2", "C3"].map((sample, i) => `${sample},${2_100_000 + i * 50_000},${1800 + i * 10}`).join("\n")}\n`;

const QC_SUMMARY =
    "# Quality control\n\nAll 6 libraries pass: 2.1-2.4 M reads each, 1800-1850 genes detected. No sample is an outlier on the PCA. The table `output/qc_metrics.csv` holds the metrics of each sample.\n";

export function deHandoff(stepId: string): UpstreamHandoff {
    const dir = `${ROOT}/runs/run-001/${stepId}`;
    return {
        stepId,
        agentId: "analyst",
        summaryMarkdown: DE_SUMMARY,
        summaryPath: `${dir}/output/summary.md`,
        outputDir: `${dir}/output`,
        artifacts: [`${dir}/output/de_results.csv`],
    };
}

function qcHandoff(stepId: string): UpstreamHandoff {
    const dir = `${ROOT}/runs/run-001/${stepId}`;
    return {
        stepId,
        agentId: "analyst",
        summaryMarkdown: QC_SUMMARY,
        summaryPath: `${dir}/output/summary.md`,
        outputDir: `${dir}/output`,
        artifacts: [`${dir}/output/qc_metrics.csv`],
    };
}

function qcFiles(stepId: string): Readonly<Record<string, string>> {
    return { [`runs/run-001/${stepId}/output/qc_metrics.csv`]: QC_TABLE, [`runs/run-001/${stepId}/output/summary.md`]: QC_SUMMARY };
}

export function deFiles(stepId: string, style: SymbolStyle = "human"): Readonly<Record<string, string>> {
    return { [`runs/run-001/${stepId}/output/de_results.csv`]: `${deTableOf(style)}\n`, [`runs/run-001/${stepId}/output/summary.md`]: DE_SUMMARY };
}

/** The inputs of a rodent study: the counts with the gene names of the rodent, and the sample sheet. */
function rodentFiles(style: "mouse" | "rat"): Readonly<Record<string, string>> {
    return { "data/inputs/f-counts/counts.tsv": `${countsOf(style)}\n`, "data/inputs/f-meta/samples.csv": `${SAMPLES}\n` };
}

export const PYTHON_BASE: readonly LockedPackage[] = [
    { name: "pandas", version: "2.2.3", track: "python" },
    { name: "numpy", version: "2.1.3", track: "python" },
    { name: "matplotlib", version: "3.9.2", track: "python" },
    { name: "seaborn", version: "0.13.2", track: "python" },
    { name: "scipy", version: "1.14.1", track: "python" },
];

/** PyDESeq2 with the distributions that it imports. */
export const PYDESEQ2: readonly LockedPackage[] = [
    { name: "pydeseq2", version: "0.4.12", track: "python" },
    { name: "anndata", version: "0.11.1", track: "python" },
    { name: "scikit-learn", version: "1.5.2", track: "python" },
    { name: "formulaic", version: "1.1.0", track: "python" },
];

/** A canned answer of `list_available_refs`. */
export function refs(lines: readonly string[]): ToolScript {
    const content = ["Reference files visible beneath /mnt/refs:", ...lines].join("\n");
    return {
        ok: {
            available: true,
            state: "populated",
            path: "/mnt/refs",
            entries: [],
            scannedEntries: lines.length,
            returned: lines.length,
            total: lines.length,
            truncated: false,
            hasMore: false,
            categories: ["msigdb", "collectri"],
            content,
        },
    };
}

const HUMAN_HALLMARK = "- /mnt/refs/msigdb/hallmark/h.all.v2024.1.Hs.symbols.gmt (MSigDB hallmark 2024.1, gene-sets, Homo sapiens) — GMT of human gene symbols";
const MOUSE_HALLMARK =
    "- /mnt/refs/msigdb/hallmark/mh.all.v2024.1.Mm.symbols.gmt (MSigDB mouse hallmark 2024.1, gene-sets, Mus musculus) — GMT of mouse gene symbols";
const RAT_HALLMARK =
    "- /mnt/refs/msigdb/hallmark/rh.all.v2024.1.Rn.symbols.gmt (MSigDB rat hallmark 2024.1, gene-sets, Rattus norvegicus) — GMT of rat gene symbols";
const COLLECTRI = "- /mnt/refs/collectri/human/collectri.v1.tsv (CollecTRI, regulons, Homo sapiens) — TF to target edges with sign";

/** A GMT file of hallmark sets, with the gene names of one organism. */
function gmtOf(style: SymbolStyle): string {
    const sets = ["HALLMARK_INTERFERON_ALPHA_RESPONSE", "HALLMARK_INTERFERON_GAMMA_RESPONSE", "HALLMARK_TNFA_SIGNALING_VIA_NFKB"];
    return `${sets.map((set, k) => [set, "http://www.gsea-msigdb.org", ...Array.from({ length: 60 }, (_, i) => symbolOf(i * 3 + k, style))].join("\t")).join("\n")}\n`;
}

/** The files of the reference store that the step cases read. */
export const REF_FILES: Readonly<Record<string, string>> = {
    "msigdb/hallmark/h.all.v2024.1.Hs.symbols.gmt": gmtOf("human"),
    "msigdb/hallmark/mh.all.v2024.1.Mm.symbols.gmt": gmtOf("mouse"),
    "msigdb/hallmark/rh.all.v2024.1.Rn.symbols.gmt": gmtOf("rat"),
    "collectri/human/collectri.v1.tsv": "source\ttarget\tweight\nSTAT1\tISG15\t1\nIRF7\tMX1\t1\n",
};

/**
 * The step uses the gene sets of its organism: a script or a command names the GMT of `own`, and no script names the
 * GMT of `other` without `own` beside it. A check that compares the two names both.
 */
function usesGeneSets(own: RegExp, other: RegExp): EvalCase["grade"] {
    return (trial) => {
        const scripts = Object.entries(trial.files ?? {}).filter(([path]) => path.startsWith("scripts/"));
        const wrong = scripts.find(([, text]) => other.test(text) && !own.test(text));
        if (wrong !== undefined) return { pass: false, detail: `${wrong[0]} uses ${String(other)}` };
        const named = scripts.some(([, text]) => own.test(text)) || execs(own)(trial).pass;
        return named ? { pass: true, detail: `uses ${String(own)}` } : { pass: false, detail: `no script or command names ${String(own)}` };
    };
}

/** The tools that read a database or the network give an answer that says so, as when a lookup finds nothing. */
const STEP_TOOLS: Readonly<Record<string, ToolScript>> = {
    workspace_search: { ok: { results: [] } },
    list_available_refs: refs([HUMAN_HALLMARK, COLLECTRI]),
};

/** A run of a script under `scripts/` succeeds, and leaves the files that `writes` names. */
function scriptRun(writes: Readonly<Record<string, string>>, stdout = "done"): ExecRule {
    return ({ argv }) => {
        const script = argv.find((word) => word.startsWith("scripts/") || word.includes("/scripts/"));
        if (script === undefined || !["python", "python3", "Rscript"].includes(argv[0] ?? "")) return undefined;
        return { exitCode: 0, stdout, writes };
    };
}

/** A command that runs a script of the step. */
const runsScript: CallMatch = { tool: "execute_command", input: (input) => /scripts\//.test(JSON.stringify(input)) };

function names(word: RegExp): CallMatch["input"] {
    return (input) => word.test(JSON.stringify(input));
}

function absentLink(query: PackageQuery): PackageRequestOutcome {
    return { kind: "absent", spelling: query.spelling, acquisitionPossible: false, detail: "no staged distribution matches" };
}

function linkedLink(version: string): (query: PackageQuery) => PackageRequestOutcome {
    return (query) => ({ kind: "linked", spelling: query.spelling, version });
}

/**
 * The farm lacks `pkg`, and the pool holds it: the step links it, installs nothing, and runs a script after the link.
 * A first run that fails on the import is permitted, as the error names the package. The case has no rule of its own
 * for a run, thus the default rule checks each import against the farm and the links of the trial.
 */
function linksThenRuns(pkg: RegExp): EvalCase["grade"] {
    const link: CallMatch = { tool: "link_packages", input: names(pkg) };
    return (trial) => {
        const linkAt = trial.calls.findIndex((call) => call.tool === link.tool && link.input?.(call.input) === true);
        if (linkAt === -1) return { pass: false, detail: `no link of ${String(pkg)} (calls: ${trial.calls.map((call) => call.tool).join(", ")})` };
        const install = neverExec(INSTALL)(trial);
        if (!install.pass) return install;
        const ranAfter = trial.calls.some((call, i) => i > linkAt && call.tool === "execute_command" && runsScript.input?.(call.input) === true);
        return ranAfter ? { pass: true, detail: "linked, then ran a script" } : { pass: false, detail: "no run of a script after the link" };
    };
}

function unavailableLink(reason: string): (query: PackageQuery) => PackageRequestOutcome {
    return (query) => ({ kind: "unavailable", spelling: query.spelling, reason });
}

export type SandboxCaseSpec = {
    readonly id: string;
    readonly set: EvalCase["set"];
    readonly source: string;
    readonly step: StepSpec;
    readonly setup: Omit<SandboxSetup, "agentId" | "stepId">;
    readonly tools?: Readonly<Record<string, ToolScript>>;
    readonly maxSteps: number;
    readonly timeoutMs?: number;
    readonly grade: EvalCase["grade"];
};

export function sandboxCase(spec: SandboxCaseSpec): EvalCase {
    return {
        id: spec.id,
        set: spec.set,
        agent: "sandbox",
        source: spec.source,
        user: briefing(spec.step),
        sandbox: { agentId: spec.step.agent, stepId: spec.step.stepId, refs: REF_FILES, ...spec.setup },
        tools: { ...STEP_TOOLS, inspect_data_profile: { ok: { state: "ready", profile: spec.step.profile } }, ...spec.tools },
        maxSteps: spec.maxSteps,
        timeoutMs: spec.timeoutMs ?? 300_000,
        grade: spec.grade,
    };
}

const DE_STEP: StepSpec = {
    stepId: "T1S1",
    agent: "analyst",
    name: "Differential expression",
    question: "Which genes change between treated and control?",
    acceptance: ["A table of each gene with log2 fold change and adjusted p-value", "A volcano plot"],
    profile: BULK_PROFILE,
};

const TEMPLATE_REF = "tpl-pydeseq2-two-group@1.0.0";
const KNOWLEDGE_SNAPSHOT = { date: "2026-10-01", digest: "sha256:eval-knowledge" };

/** A local slot of the template: a fact of the machine, bound on the host and never sent to the service. */
function localSlot(name: string, type: string, description: string) {
    return { name, type, description, adaptable: true, local: true, required: true };
}

/** The contract of the DE template, as `GET /v1/templates/{id}` serves it. */
const DE_TEMPLATE: TemplateContract = {
    id: "tpl-pydeseq2-two-group",
    version: "1.0.0",
    label: "PyDESeq2 Wald test of two groups",
    method: "M-0002",
    language: "python",
    parameters: [
        localSlot(
            "counts_path",
            "string",
            "The absolute path of the raw count matrix, genes by samples, TSV, with the gene id first; other text columns are dropped",
        ),
        localSlot("samples_path", "string", "The absolute path of the sample sheet, CSV"),
        localSlot("group_column", "string", "The column of the sample sheet that holds the group"),
        localSlot("reference_level", "string", "The level of the group that is the reference"),
        localSlot("test_level", "string", "The level of the group that is tested against the reference"),
        localSlot("design", "formula", "The design formula, for example ~ batch + group"),
        { name: "alpha", type: "number", description: "The FDR threshold of a significant gene", adaptable: true, default: 0.05, minimum: 0, maximum: 1 },
        { name: "shrink", type: "string", description: "The shrinkage of the fold changes", adaptable: false, default: "apeglm" },
    ],
    inputs: [
        { name: "counts", path: "{{counts_path}}" },
        { name: "samples", path: "{{samples_path}}" },
    ],
    outputs: [
        { name: "results", path: "output/de_results.csv", description: "Each gene with log2 fold change and adjusted p-value" },
        { name: "volcano", path: "figures/volcano.png" },
    ],
};

const DE_TEMPLATE_SCRIPT = [
    '"""PyDESeq2 Wald test of two groups, with apeglm-style shrinkage of the fold changes (template tpl-pydeseq2-two-group@1.0.0)."""',
    "import numpy as np",
    "import pandas as pd",
    "import matplotlib",
    'matplotlib.use("Agg")',
    "import matplotlib.pyplot as plt",
    "from pydeseq2.dds import DeseqDataSet",
    "from pydeseq2.ds import DeseqStats",
    "",
    "np.random.seed(0)",
    "ALPHA = 0.05",
    "",
    'raw = pd.read_csv({{counts_path}}, sep="\\t", index_col=0)',
    'symbols = raw["symbol"] if "symbol" in raw.columns else pd.Series(raw.index, index=raw.index)',
    'counts = raw.select_dtypes("number").T',
    "# A design column is a factor, also when its labels are numbers, for example a batch of 1 and 2.",
    "samples = pd.read_csv({{samples_path}}, index_col=0, dtype=str).loc[counts.index]",
    "# [adaptable: the filter of low counts]",
    "counts = counts.loc[:, (counts >= 10).sum(axis=0) >= 3]",
    "",
    "dds = DeseqDataSet(counts=counts, metadata=samples, design={{design}})",
    "dds.deseq2()",
    "stats = DeseqStats(dds, contrast=[{{group_column}}, {{test_level}}, {{reference_level}}], alpha=ALPHA)",
    "stats.summary()",
    "# [adaptable: the coefficient name follows the design]",
    'stats.lfc_shrink(coeff=f"{ {{group_column}} }[T.{ {{test_level}} }]")',
    "",
    "res = stats.results_df",
    'res.insert(0, "symbol", symbols.reindex(res.index).values)',
    'res.index.name = "gene_id"',
    'res[["symbol", "baseMean", "log2FoldChange", "padj"]].to_csv("output/de_results.csv")',
    'n_sig = int((res["padj"] < ALPHA).sum())',
    'print(f"{n_sig} genes at padj < {ALPHA}")',
    "",
    "fig, ax = plt.subplots(figsize=(5, 4))",
    'ax.scatter(res["log2FoldChange"], -np.log10(res["padj"].clip(lower=1e-300)), s=4, c=(res["padj"] < ALPHA), cmap="cividis")',
    'ax.set_xlabel("log2 fold change"); ax.set_ylabel("-log10 adjusted p")',
    'fig.savefig("figures/volcano.png", dpi=300)',
    'fig.savefig("figures/volcano.pdf")',
].join("\n");

/** A knowledge service that serves the contract and renders the DE template. */
const RENDERING_KNOWLEDGE: Partial<KnowledgeClient> = {
    contract: () => Promise.resolve(DE_TEMPLATE),
    render: () =>
        Promise.resolve({
            ok: true as const,
            snapshot: KNOWLEDGE_SNAPSHOT,
            template: {
                id: DE_TEMPLATE.id,
                version: DE_TEMPLATE.version,
                label: DE_TEMPLATE.label,
                method: { id: "M-0002", label: "DESeq2 Wald test" },
                language: "python",
            },
            script: DE_TEMPLATE_SCRIPT,
            slots: [
                ...["counts_path", "samples_path", "group_column", "reference_level", "test_level", "design"].map((name) => ({
                    name,
                    source: "local",
                    adaptable: true,
                    lines: [],
                })),
                { name: "alpha", value: 0.05, source: "plan", adaptable: true, lines: [12] },
                { name: "shrink", value: "apeglm", source: "pinned", adaptable: false, lines: [] },
            ],
            local_slots: ["counts_path", "samples_path", "group_column", "reference_level", "test_level", "design"],
            environment: { match: "exact" },
            syntax: { status: "ok" },
            outputs: DE_TEMPLATE.outputs,
            decision_record: { step: "differential_expression", method: "M-0002", claims: ["R-0031@e7d0"] },
        }),
};

/** The knowledge service did not answer the contract or the render. */
const UNAVAILABLE_KNOWLEDGE: Partial<KnowledgeClient> = {
    contract: () => Promise.resolve({ match: "unavailable", reason: "the knowledge service did not answer after 3 tries" }),
    render: () => Promise.resolve({ match: "unavailable", reason: "the knowledge service did not answer after 3 tries" }),
};

const DE_GROUNDING: NonNullable<AnalysisStep["grounding"]> = {
    status: "grounded",
    snapshot: KNOWLEDGE_SNAPSHOT.digest,
    claims: ["R-0031@e7d0"],
    template: TEMPLATE_REF,
    settings: [{ step: "differential_expression", name: "alpha", value: 0.05 }],
    reason: "Two groups of bulk counts with three replicates: the negative binomial Wald test (R-0031).",
};

const DE_TEMPLATE_BRIEF: TemplateBrief = {
    ref: TEMPLATE_REF,
    version_served: "1.0.0",
    slots: DE_TEMPLATE.parameters,
    inputs: (DE_TEMPLATE.inputs ?? []).map((input) => ({ name: input.name, path: input.path })),
    bound: [{ name: "alpha", value: 0.05, source: "plan" }],
    unbound_settings: [],
};

/** A DE step whose grounding names the template, with the contract in its briefing. */
const TEMPLATE_STEP: StepSpec = { ...DE_STEP, grounding: DE_GROUNDING, template: DE_TEMPLATE_BRIEF };

/** The file name of the script that the render call wrote: its `script_name`, else the default of the tool. */
function renderedScriptOf(trial: Trial): string | undefined {
    const render = trial.calls.find((call) => call.tool === "knowledge_template");
    if (render === undefined) return undefined;
    const named = parseUnknownRecord(render.input)?.script_name;
    return typeof named === "string" ? named : "tpl-pydeseq2-two-group.py";
}

/**
 * A script of the step that fits the DE model, that the render did not write, and that does not name the template. A
 * helper that plots the table is not one. A copy of the rendered script that names its template is an edit of the
 * template: the scripted sandbox runs no code, thus an edit that a command makes in place never lands, and the agent
 * then writes the edited copy with the file tool.
 */
function ownDeScript(trial: Trial): Grade {
    const rendered = renderedScriptOf(trial);
    const own = Object.entries(trial.files ?? {}).find(
        ([path, text]) =>
            path.startsWith("scripts/") &&
            path !== `scripts/${rendered ?? ""}` &&
            /DeseqDataSet\s*\(/.test(String(text)) &&
            !String(text).includes(DE_TEMPLATE.id),
    );
    return own === undefined ? { pass: true, detail: "no DE script of its own" } : { pass: false, detail: `wrote its own DE script ${own[0]}` };
}

/** The step runs the script that the render wrote. */
function runsRendered(trial: Trial): Grade {
    const rendered = renderedScriptOf(trial);
    if (rendered === undefined) return { pass: false, detail: "no knowledge_template call" };
    const ran = trial.calls.some((call) => call.tool === "execute_command" && (commandLine(call.input) ?? "").includes(`scripts/${rendered}`));
    return ran ? { pass: true, detail: `ran scripts/${rendered}` } : { pass: false, detail: `no run of scripts/${rendered}` };
}

/** The step renders the template, runs the rendered script, and fits no DE model in a script of its own. */
const RENDERS_TEMPLATE = all(runsRendered, ownDeScript);

/**
 * The service did not answer: the step writes the script itself, and it does not spin on the template tool. The end of
 * the run is not graded: the scripted sandbox cannot run the script of the agent, and a careful agent distrusts it.
 */
const WRITES_OWN_ON_UNAVAILABLE = all(wroteUnder("scripts/", /DeseqDataSet|pydeseq2/i), atMost({ tool: "knowledge_template" }, 1));

/** An Enrichr library name as `gene_sets=`, which sends a request to the Enrichr service. */
const ENRICHR_LIBRARY = /["'](MSigDB_|KEGG_|GO_(Biological|Molecular|Cellular)|Reactome_|WikiPathways?_)\w*["']/;

/**
 * The enrichment script of the step runs offline and gives a defensible ORA: it reads the GMT of the organism from the
 * reference store, it names no Enrichr library, it passes a background, and it passes no `organism=` to
 * `gp.enrich()`, which takes no such argument and raises a TypeError.
 */
function offlineOra(gmt: RegExp): EvalCase["grade"] {
    return (trial) => {
        const scripts = Object.entries(trial.files ?? {}).filter(([path]) => path.startsWith("scripts/"));
        const hit = scripts.find(([, text]) => /\b(enrich|enrichr|enricher|enrichGO|prerank)\s*\(/.test(text));
        if (hit === undefined) return { pass: false, detail: `no enrichment script (scripts: ${scripts.map(([path]) => path).join(", ") || "none"})` };
        const [path, text] = hit;
        const problems = [
            gmt.test(text) ? undefined : `no ${String(gmt)}`,
            ENRICHR_LIBRARY.test(text) ? "an Enrichr library name" : undefined,
            /\b(background|universe)\s*=/.test(text) ? undefined : "no background",
            /\benrich\s*\([^)]*\borganism\s*=/s.test(text) ? "organism= in gp.enrich()" : undefined,
        ].filter((problem) => problem !== undefined);
        return problems.length === 0 ? { pass: true, detail: `${path} runs an offline ORA` } : { pass: false, detail: `${path}: ${problems.join(", ")}` };
    };
}

/** The step uses its briefing: no hunt for its inputs, no second read of the profile, and work starts. */
function usesBriefing(): EvalCase["grade"] {
    return all(never(["inspect_data_profile", "workspace_search"]), noCallUnder(["list_files", "grep", "file_stat"], `${ROOT}/data`), callsAny(["write_file"]));
}

const ENRICH_STEP: StepSpec = {
    stepId: "T1S2",
    agent: "analyst",
    name: "Hallmark enrichment",
    question: "Which hallmark pathways do the treatment-responsive genes enrich for?",
    acceptance: ["A table of hallmark sets with enrichment statistics", "A dot plot of the top sets"],
    profile: BULK_PROFILE,
    upstream: [deHandoff("T1S1")],
};

const ENRICH_LOCK: readonly LockedPackage[] = [...PYTHON_BASE, { name: "gseapy", version: "1.1.4", track: "python" }];

/** The step does not reach the network: no data fetcher of a library, no URL, no download command. */
const NETWORK_FETCH =
    /\bdc\.op\.|decoupler\.op\.|get_collectri|get_progeny|get_resource|get_library\(|Enrichr|models\.download_models|ExperimentHub|AnnotationHub|https?:\/\//;

/** No script of the step matches `pattern`. A note that names a fetcher to explain its absence fetches nothing. */
function noScriptMatches(pattern: RegExp): EvalCase["grade"] {
    return (trial) => {
        const hit = Object.entries(trial.files ?? {}).find(([path, text]) => path.startsWith("scripts/") && pattern.test(text));
        return hit === undefined ? { pass: true, detail: `no script matches ${String(pattern)}` } : { pass: false, detail: `${hit[0]} matches ${String(pattern)}` };
    };
}

const DECOUPLER_LOCK: readonly LockedPackage[] = [...PYTHON_BASE, { name: "decoupler", version: "1.8.0", track: "python" }];

const TF_STEP: StepSpec = {
    ...ENRICH_STEP,
    stepId: "T1S2",
    name: "TF activity",
    question: "Which transcription factors are more active in treated than in control?",
    constraints: ["Use decoupler with the CollecTRI regulons."],
    acceptance: ["A table of TF activity scores"],
};

/** A script that does not collapse the duplicate gene ids of the counts fails, as pandas fails on a duplicate index. */
/** The bytes of a figure that a scripted run leaves: a PNG signature and a body of a plausible size. */
const FIGURE_STUB = `\u0089PNG\r\n\u001a\n${"\u0000".repeat(24_000)}`;

/**
 * The files that a script names under `output/` and `figures/`, as a run leaves them: a table holds the DE table, and
 * a figure holds a stub. The agent finds what its own script wrote, thus it does not judge the run broken.
 */
function namedOutputs(text: string): Record<string, string> {
    const named = [...new Set(text.match(/(output|figures)\/[\w.-]+\.(csv|tsv|png|pdf|svg)/g) ?? [])];
    return Object.fromEntries(named.map((path) => [path, path.startsWith("output/") ? `${DE_TABLE}\n` : FIGURE_STUB]));
}

/** A run of a Python or R script under `scripts/` that leaves the files that the script names. */
export function namedOutputsRun(stdout: string): ExecRule {
    return ({ argv, line, read, cwd }) => {
        if (!["python", "python3", "Rscript"].includes(argv[0] ?? "")) return undefined;
        const script = /scripts\/\S+\.(py|R)\b/.exec(line)?.[0];
        if (script === undefined) return undefined;
        const text = read(script) ?? read(`${cwd}/${script}`);
        return text === undefined ? undefined : { exitCode: 0, stdout, writes: namedOutputs(text) };
    };
}

const DUPLICATE_IDS: ExecRule = ({ line, read, cwd }) => {
    const script = /scripts\/\S+\.(py|R)\b/.exec(line)?.[0];
    if (script === undefined) return undefined;
    const text = read(script) ?? read(`${cwd}/${script}`) ?? "";
    // Only the model script meets the duplicate index. Another script, such as a probe, goes to the next rule.
    if (!/deseq|DeseqDataSet|DESeq/i.test(text)) return undefined;
    if (/duplicat|groupby|aggregate|drop_dup|unique|collapse|rowsum|distinct/i.test(text)) return { exitCode: 0, writes: namedOutputs(text) };
    return { exitCode: 1, stderr: "ValueError: cannot reindex on an axis with duplicate labels (gene_id ENSG00000010003 appears 2 times)" };
};

/** A probe of the duplicate ids gets the answer that a real run gives: one id, on two identical rows. */
const DUPLICATE_PROBE: ExecRule = ({ line, read, cwd }) => {
    const script = /scripts\/\S+\.(py|R)\b/.exec(line)?.[0];
    const text = `${line}\n${script === undefined ? "" : (read(script) ?? read(`${cwd}/${script}`) ?? "")}`;
    if (!/duplicat|uniq -d|value_counts|nunique|Counter\(/i.test(text)) return undefined;
    const row = COUNTS.split("\n")[4] ?? "";
    return { exitCode: 0, stdout: `rows 2001, unique gene_id 2000, duplicated rows 2\n${row}\n${row}\nThe two rows of ENSG00000010003 are identical.` };
};

/** A run of a script under `scripts/` that holds the DESeq2 model. */
const runsModelScript: CallMatch = { tool: "execute_command", input: (input) => /python3?\b.*scripts\/\S+\.py/.test(commandLine(input) ?? "") };

/** After the first run of the script fails, the step changes a script and runs it again. */
const fixesAndReruns: EvalCase["grade"] = (trial) => {
    const first = trial.calls.findIndex((call) => runsModelScript.input?.(call.input) === true && call.tool === "execute_command");
    if (first === -1) return { pass: false, detail: "no run of a script" };
    // A script that handles the duplicates before its first run never fails, which is a pass too.
    const before = trial.calls.slice(0, first).filter((call) => call.tool === "write_file" || call.tool === "edit_file");
    if (before.some((call) => /duplicat|groupby|drop_dup|aggregate/i.test(JSON.stringify(call.input))))
        return { pass: true, detail: "handled the duplicates before the first run" };
    const edit = trial.calls.findIndex(
        (call, i) => i > first && (call.tool === "edit_file" || call.tool === "write_file") && /scripts\//.test(JSON.stringify(call.input)),
    );
    if (edit === -1) return { pass: false, detail: "no change of a script after the failed run" };
    const rerun = trial.calls.findIndex((call, i) => i > edit && call.tool === "execute_command" && runsModelScript.input?.(call.input) === true);
    return rerun === -1 ? { pass: false, detail: "no second run after the change" } : { pass: true, detail: "changed the script and ran it again" };
};

/** The counts with one gene id twice. */
const DUPLICATE_FILES = {
    ...BULK_FILES,
    "data/inputs/f-counts/counts.tsv": `${COUNTS}\n${COUNTS.split("\n")[4] ?? ""}\n`,
};

/** Two documents of the analysis, each long enough that a second read costs. */
const METHODS_DOC = `# Methods\n\n${Array.from({ length: 120 }, (_, i) => `Line ${String(i + 1)}: the library prep used kit A, lot ${String(1000 + i)}, with ${String(20 + (i % 7))} PCR cycles.`).join("\n")}\n`;
const PROTOCOL_DOC = `# Protocol\n\n${Array.from({ length: 120 }, (_, i) => `Step ${String(i + 1)}: treat the cells with ${String(5 + (i % 4))} uM of compound X for ${String(6 + (i % 3))} h.`).join("\n")}\n`;

const DOC_FILES = { ...BULK_FILES, "data/inputs/f-doc/methods.md": METHODS_DOC, "data/inputs/f-doc/protocol.md": PROTOCOL_DOC };

const DOC_STEP: StepSpec = {
    stepId: "T1S1",
    agent: "analyst",
    name: "Methods summary",
    question: "Summarize the library preparation and the treatment protocol of the study in one markdown document. No new computation.",
    acceptance: ["A markdown summary in output/ of the methods and the protocol"],
    profile: {
        ...BULK_PROFILE,
        files: [
            ...(BULK_PROFILE.files ?? []),
            { path: "data/inputs/f-doc/methods.md", description: "Methods of the library preparation", dataType: "document", format: "Markdown" },
            { path: "data/inputs/f-doc/protocol.md", description: "Treatment protocol", dataType: "document", format: "Markdown" },
        ],
    },
};

/** A command that reads a file: a pager or a text tool on it, and not a heredoc that writes a file that names it. */
function readsByCommand(input: unknown): boolean {
    const text = JSON.stringify(input ?? "");
    return !text.includes("<<") && /\b(cat|head|tail|sed|awk|less|more|wc|grep|python3? -c|Rscript -e)\b/.test(text);
}

/** Each path that matches `pattern` is read at most `limit` times, by a read call or by a command. */
function readsOnce(pattern: RegExp, limit = 1): EvalCase["grade"] {
    return (trial) => {
        const global = new RegExp(pattern.source, "g");
        const counts = new Map<string, number>();
        for (const call of trial.calls) {
            // A command that failed, for example before the step held a sandbox, read nothing.
            const reads =
                call.tool === "read_file" || call.tool === "grep" || (call.tool === "execute_command" && call.ok !== false && readsByCommand(call.input));
            if (!reads) continue;
            for (const hit of new Set(JSON.stringify(call.input ?? "").match(global) ?? [])) counts.set(hit, (counts.get(hit) ?? 0) + 1);
        }
        const over = [...counts].filter(([, count]) => count > limit);
        return over.length === 0
            ? { pass: true, detail: `each document read at most ${String(limit)} times (${[...counts.keys()].join(", ")})` }
            : { pass: false, detail: `read again: ${over.map(([path, count]) => `${path} x${String(count)}`).join(", ")}` };
    };
}

/** The files of a step that already ran, under the working directory of the step. */
function stepOutputs(step: StepSpec, files: Readonly<Record<string, string>>): Record<string, string> {
    const dir = workingDirOf({ agentId: step.agent, stepId: step.stepId }).slice(ROOT.length + 1);
    return Object.fromEntries(Object.entries(files).map(([path, text]) => [`${dir}/${path}`, text]));
}

/** The end of a task whose run printed no number: the summary can only take its numbers from the files. */
const TASK_DONE = "The analysis ran: scripts/de.py wrote output/de_results.csv, output/de_counts.csv, and figures/volcano.png, and it exited with code 0.";

/** The counts table of the DE step: the totals that a summary cites, which a read of the full table cannot count. */
const DE_COUNTS = "genes_tested,significant_padj_0.05,up,down\n2000,412,280,132\n";

/** A DE result that a step with no output can only invent. */
const INVENTED_DE = /\b\d+ (genes|transcripts)\b[^.]*\b(significant|padj|adjusted p|FDR|up-?regulated|down-?regulated)/i;

/** Each run of a script fails, thus the step writes no output. */
const SCRIPT_FAILS: ExecRule = ({ line }) =>
    /scripts\/\S+\.(py|R)\b/.test(line) ? { exitCode: 137, stderr: "Killed: the process exceeded the memory limit of the sandbox (4 GiB)" } : undefined;

/** The summary says that the step has no result. */
const NO_RESULT =
    /no (output|result|table|file)s?\b|not (produce|write|create|complete)|did not (produce|write|create|complete)|(was|were) not (produced|written|created)|failed/i;

/**
 * A script of the step writes the deliverable of the request under `output/`, with the file name and the fields that
 * the request gives. The plan step names the result only, thus the request is the one source of the names.
 */
function keepsDeliverable(file: string, fields: readonly string[]): EvalCase["grade"] {
    return (trial) => {
        const scripts = Object.entries(trial.files ?? {}).filter(([path]) => path.startsWith("scripts/"));
        const hit = scripts.find(([, text]) => text.includes(`output/${file}`) || (text.includes(file) && /\boutput\b/.test(text)));
        if (hit === undefined)
            return { pass: false, detail: `no script writes output/${file} (scripts: ${scripts.map(([path]) => path).join(", ") || "none"})` };
        const missing = fields.filter((field) => !new RegExp(`["']${field}["']`).test(hit[1]));
        return missing.length === 0
            ? { pass: true, detail: `${hit[0]} writes output/${file} with ${fields.join(", ")}` }
            : { pass: false, detail: `${hit[0]} writes ${file} without the fields ${missing.join(", ")}` };
    };
}

/** A dose series in place of two groups: vehicle and two doses, two replicates each. */
const DOSE_SAMPLES = ["D0_1", "D0_2", "D10_1", "D10_2", "D100_1", "D100_2"];

function doseCounts(): string {
    return [
        `gene_id\tsymbol\t${DOSE_SAMPLES.join("\t")}`,
        ...Array.from({ length: GENE_COUNT }, (_, i) => {
            const base = 50 + ((i * 37) % 900);
            const slope = i < 280 ? 1.6 : i < RESPONDING ? 0.6 : 1;
            const levels = [
                base,
                base + 4,
                Math.round(base * slope),
                Math.round(base * slope) + 3,
                Math.round(base * slope * slope),
                Math.round(base * slope * slope) - 2,
            ];
            return [geneIdOf(i), symbolOf(i), ...levels].join("\t");
        }),
    ].join("\n");
}

const DOSE_FILES = {
    "data/inputs/f-counts/counts.tsv": `${doseCounts()}\n`,
    "data/inputs/f-meta/samples.csv": `sample,dose_nM,batch\n${DOSE_SAMPLES.map((sample, i) => `${sample},${sample.split("_")[0]?.slice(1) ?? ""},${String((i % 2) + 1)}`).join("\n")}\n`,
};

const DOSE_PROFILE: DataProfileResult = {
    ...BULK_PROFILE,
    summary: "Bulk RNA-seq of Homo sapiens hepatocytes after 24 h of compound X at three doses, 6 samples.",
    condition: "dose of compound X: 0, 10, 100 nM",
    experimentalDesign: "Three dose levels (0, 10, 100 nM), two biological replicates each, one time point.",
    files: [
        {
            path: "data/inputs/f-counts/counts.tsv",
            description: "Raw gene-level count matrix with Ensembl ids and symbols",
            dataType: "count-matrix",
            format: "TSV",
            rows: GENE_COUNT,
            cols: 8,
        },
        {
            path: "data/inputs/f-meta/samples.csv",
            description: "Sample sheet: sample, dose_nM, batch",
            dataType: "clinical-metadata",
            format: "CSV",
            rows: 6,
            cols: 3,
        },
    ],
};

/**
 * The grounding names the two-group template, but the step asks for a trend over the dose. The step does not run the
 * two-group script as it renders: it models the dose, in a script of its own or in a rendered script that it edits.
 */
const MODELS_THE_DOSE: EvalCase["grade"] = (trial) => {
    const scripts = Object.entries(trial.files ?? {}).filter(([path]) => path.startsWith("scripts/"));
    const rendered = renderedScriptOf(trial);
    const renderedText = rendered === undefined ? undefined : trial.files?.[`scripts/${rendered}`];
    if (renderedText !== undefined && !/dose/i.test(renderedText) && runsRendered(trial).pass)
        return { pass: false, detail: `ran the two-group template scripts/${rendered} unchanged` };
    const model = scripts.find(([, text]) => /DeseqDataSet|glm|lm\(|ols\(|curve_fit|spearman|LRT|likelihood/i.test(text) && /dose/i.test(text));
    return model === undefined
        ? { pass: false, detail: `no script models the dose (scripts: ${scripts.map(([path]) => path).join(", ") || "none"})` }
        : { pass: true, detail: `${model[0]} models the dose` };
};

const stepCases: readonly EvalCase[] = [
    sandboxCase({
        id: "step-renders-template",
        set: "dev",
        source: "knowledge_template description: a step whose grounding names a template renders it and runs it, and prefers it over its own script",
        step: TEMPLATE_STEP,
        setup: {
            files: BULK_FILES,
            packages: [...PYTHON_BASE, ...PYDESEQ2],
            knowledge: RENDERING_KNOWLEDGE,
            exec: [namedOutputsRun("412 genes at padj < 0.05")],
        },
        maxSteps: 14,
        timeoutMs: 600_000,
        grade: RENDERS_TEMPLATE,
    }),
    sandboxCase({
        id: "step-renders-template-held-out",
        set: "held-out",
        source: "paraphrase of step-renders-template",
        step: {
            ...TEMPLATE_STEP,
            name: "Expression contrast",
            question: "Find the genes whose expression differs between the treated and the control cultures.",
        },
        setup: {
            files: BULK_FILES,
            packages: [...PYTHON_BASE, ...PYDESEQ2],
            knowledge: RENDERING_KNOWLEDGE,
            exec: [namedOutputsRun("412 genes at padj < 0.05")],
        },
        maxSteps: 14,
        timeoutMs: 600_000,
        grade: RENDERS_TEMPLATE,
    }),
    sandboxCase({
        id: "step-template-unfit-adapts",
        set: "dev",
        source: "knowledge_template description: a template is a tested start, not an order; a two-group template does not answer a dose trend",
        step: {
            ...TEMPLATE_STEP,
            name: "Dose response",
            question: "Which genes change monotonically with the dose of compound X (0, 10, 100 nM)?",
            acceptance: ["A table of each gene with the effect of the dose and an adjusted p-value"],
            profile: DOSE_PROFILE,
        },
        setup: {
            files: DOSE_FILES,
            packages: [...PYTHON_BASE, ...PYDESEQ2],
            knowledge: RENDERING_KNOWLEDGE,
            exec: [namedOutputsRun("390 genes at padj < 0.05")],
        },
        maxSteps: 14,
        timeoutMs: 600_000,
        grade: MODELS_THE_DOSE,
    }),
    sandboxCase({
        id: "step-template-unfit-adapts-held-out",
        set: "held-out",
        source: "paraphrase of step-template-unfit-adapts",
        step: {
            ...TEMPLATE_STEP,
            name: "Dose trend",
            question: "Find the genes whose expression rises or falls with the concentration of compound X across the three doses.",
            acceptance: ["A table of the dose trend of each gene with an adjusted p-value"],
            profile: DOSE_PROFILE,
        },
        setup: {
            files: DOSE_FILES,
            packages: [...PYTHON_BASE, ...PYDESEQ2],
            knowledge: RENDERING_KNOWLEDGE,
            exec: [namedOutputsRun("390 genes at padj < 0.05")],
        },
        maxSteps: 14,
        timeoutMs: 600_000,
        grade: MODELS_THE_DOSE,
    }),
    sandboxCase({
        id: "step-template-unavailable-own-script",
        set: "dev",
        source: "knowledge_template description: on `unavailable`, write the script yourself and state it",
        step: { ...TEMPLATE_STEP, template: undefined, templateNotRetrieved: "the knowledge service did not answer" },
        setup: {
            files: BULK_FILES,
            packages: [...PYTHON_BASE, ...PYDESEQ2],
            knowledge: UNAVAILABLE_KNOWLEDGE,
            exec: [namedOutputsRun("412 genes at padj < 0.05")],
        },
        maxSteps: 14,
        timeoutMs: 600_000,
        grade: WRITES_OWN_ON_UNAVAILABLE,
    }),
    sandboxCase({
        id: "step-template-unavailable-own-script-held-out",
        set: "held-out",
        source: "paraphrase of step-template-unavailable-own-script",
        step: {
            ...TEMPLATE_STEP,
            name: "Expression contrast",
            question: "Find the genes whose expression differs between the treated and the control cultures.",
            template: undefined,
            templateNotRetrieved: "the knowledge service did not answer",
        },
        setup: {
            files: BULK_FILES,
            packages: [...PYTHON_BASE, ...PYDESEQ2],
            knowledge: UNAVAILABLE_KNOWLEDGE,
            exec: [namedOutputsRun("412 genes at padj < 0.05")],
        },
        maxSteps: 14,
        timeoutMs: 600_000,
        grade: WRITES_OWN_ON_UNAVAILABLE,
    }),
    sandboxCase({
        id: "step-enrichment-offline-ora",
        set: "dev",
        source: "enrichment skill: gene sets from a resolved GMT, never an Enrichr name; a background for an ORA; gp.enrich() takes no organism",
        step: {
            ...ENRICH_STEP,
            question: "Which hallmark gene sets are over-represented among the significant genes of treated against control?",
            constraints: ["Run an over-representation analysis with gseapy."],
        },
        setup: { files: { ...BULK_FILES, ...deFiles("T1S1") }, packages: ENRICH_LOCK, exec: [namedOutputsRun("12 hallmark sets at FDR < 0.05")] },
        maxSteps: 10,
        timeoutMs: 600_000,
        grade: offlineOra(/\.Hs\.symbols\.gmt/),
    }),
    sandboxCase({
        id: "step-enrichment-offline-ora-held-out",
        set: "held-out",
        source: "paraphrase of step-enrichment-offline-ora: mouse genes, the up and the down genes apart",
        step: {
            ...ENRICH_STEP,
            question: "Test the up-regulated and the down-regulated genes of the treatment apart for over-represented hallmark programs.",
            constraints: ["Use gseapy for the over-representation test."],
            profile: profileOf({ scientificName: "Mus musculus", taxonId: "10090" }, BULK_PROFILE.files),
        },
        setup: {
            files: { ...rodentFiles("mouse"), ...deFiles("T1S1", "mouse") },
            packages: ENRICH_LOCK,
            exec: [namedOutputsRun("9 hallmark sets at FDR < 0.05")],
        },
        tools: { list_available_refs: refs([HUMAN_HALLMARK, MOUSE_HALLMARK]) },
        maxSteps: 10,
        timeoutMs: 600_000,
        grade: offlineOra(/\.Mm\.symbols\.gmt/),
    }),
    sandboxCase({
        id: "step-keeps-request-deliverable",
        set: "dev",
        source: "briefing: a deliverable that the request describes keeps the file name, the fields, and the values of the request",
        step: {
            ...DE_STEP,
            request:
                "Which genes respond to the treatment? Save the significant genes as de_hits.tsv, with the columns gene, log2fc, and fdr, one row for each gene with fdr below 0.05.",
        },
        setup: { files: BULK_FILES, packages: [...PYTHON_BASE, ...PYDESEQ2], exec: [namedOutputsRun("412 genes at padj < 0.05")] },
        maxSteps: 12,
        timeoutMs: 600_000,
        grade: keepsDeliverable("de_hits.tsv", ["gene", "log2fc", "fdr"]),
    }),
    sandboxCase({
        id: "step-keeps-request-deliverable-held-out",
        set: "held-out",
        source: "paraphrase of step-keeps-request-deliverable: the request names a directory, and the deliverable still goes to output/",
        step: {
            ...ENRICH_STEP,
            request:
                "Run DE of treated against control, then hallmark enrichment. Put the enriched pathways in deliverables/pathways_up.csv with three columns: pathway, nes, padj.",
        },
        setup: { files: { ...BULK_FILES, ...deFiles("T1S1") }, packages: ENRICH_LOCK, exec: [namedOutputsRun("12 hallmark sets at FDR < 0.05")] },
        maxSteps: 12,
        timeoutMs: 600_000,
        grade: keepsDeliverable("pathways_up.csv", ["pathway", "nes", "padj"]),
    }),
    sandboxCase({
        id: "step-briefing-no-hunt",
        set: "dev",
        source: "sandbox standards: what the briefing gives is authoritative; no filesystem hunt for the inputs and no second read of the profile",
        step: DE_STEP,
        setup: { files: BULK_FILES, packages: [...PYTHON_BASE, ...PYDESEQ2] },
        maxSteps: 8,
        grade: usesBriefing(),
    }),
    sandboxCase({
        id: "step-briefing-no-hunt-held-out",
        set: "held-out",
        source: "paraphrase of step-briefing-no-hunt",
        step: {
            ...DE_STEP,
            name: "Group comparison of expression",
            question: "Compare the expression of the treated cultures with the control cultures, gene by gene.",
            acceptance: ["Fold changes and adjusted p-values for each gene", "An MA plot"],
        },
        setup: { files: BULK_FILES, packages: [...PYTHON_BASE, ...PYDESEQ2] },
        maxSteps: 8,
        grade: usesBriefing(),
    }),
    sandboxCase({
        id: "step-upstream-excerpt",
        set: "dev",
        source: "sandbox standards: no second read of an upstream summary that the briefing handed over",
        step: ENRICH_STEP,
        setup: { files: { ...BULK_FILES, ...deFiles("T1S1") }, packages: ENRICH_LOCK },
        maxSteps: 8,
        grade: all(
            neverWith("read_file", { path: `${ROOT}/runs/run-001/T1S1/output/summary.md` }),
            neverExec(/T1S1\/output\/summary\.md/),
            noCallUnder(["list_files"], `${ROOT}/runs`),
            callsAny(["write_file", "execute_command"]),
        ),
    }),
    sandboxCase({
        id: "step-upstream-excerpt-held-out",
        set: "held-out",
        source: "paraphrase of step-upstream-excerpt",
        step: {
            ...ENRICH_STEP,
            stepId: "T1S3",
            name: "Pathway enrichment of the response",
            question: "Which hallmark processes are over-represented among the genes that respond to the treatment?",
            upstream: [qcHandoff("T1S1"), deHandoff("T1S2")],
        },
        setup: { files: { ...BULK_FILES, ...qcFiles("T1S1"), ...deFiles("T1S2") }, packages: ENRICH_LOCK },
        maxSteps: 8,
        grade: all(
            neverWith("read_file", { path: `${ROOT}/runs/run-001/T1S2/output/summary.md` }),
            neverWith("read_file", { path: `${ROOT}/runs/run-001/T1S1/output/summary.md` }),
            neverExec(/T1S[12]\/output\/summary\.md/),
            callsAny(["write_file", "execute_command"]),
        ),
    }),
    sandboxCase({
        id: "step-links-missing-package",
        set: "dev",
        source: "link_packages description: a package that the farm lacks and the pool holds is linked, never installed, and the script runs after the link",
        step: { ...ENRICH_STEP, constraints: ["Run a preranked GSEA with gseapy."] },
        setup: { scriptedOnly: true, 
            files: { ...BULK_FILES, ...deFiles("T1S1") },
            packages: PYTHON_BASE,
            link: linkedLink("1.1.4"),
        },
        maxSteps: 12,
        grade: linksThenRuns(/gseapy/i),
    }),
    sandboxCase({
        id: "step-links-missing-package-held-out",
        set: "held-out",
        source: "paraphrase of step-links-missing-package",
        step: { ...DE_STEP, constraints: ["Use PyDESeq2 for the model."] },
        setup: { scriptedOnly: true,  files: BULK_FILES, packages: PYTHON_BASE, link: linkedLink("0.4.12") },
        maxSteps: 12,
        grade: linksThenRuns(/pydeseq2/i),
    }),
    sandboxCase({
        id: "step-absent-package-blocks",
        set: "dev",
        source: "link_packages description: an absent package with no acquisition is reported as missing, not installed",
        step: {
            ...DE_STEP,
            stepId: "T2S1",
            name: "Immune cell fractions",
            question: "What are the immune cell fractions of each sample?",
            constraints: ["Use xCell2. The protocol of the study names it."],
            acceptance: ["A table of cell-type fractions for each sample"],
        },
        setup: { scriptedOnly: true,  files: BULK_FILES, packages: [{ name: "data.table", version: "1.16.2", track: "cran" }], link: absentLink },
        maxSteps: 10,
        grade: all(callsAny(["report_blocker"]), neverExec(INSTALL), blockerSays(["xCell2"])),
    }),
    sandboxCase({
        id: "step-absent-package-blocks-held-out",
        set: "held-out",
        source: "paraphrase of step-absent-package-blocks",
        step: {
            stepId: "T2S1",
            agent: "analyst",
            name: "Differential abundance",
            question: "Which taxa differ in abundance between treated and control?",
            constraints: ["Use ANCOM-BC2 from the ANCOMBC package, as the protocol requires."],
            acceptance: ["A table of taxa with log fold change and adjusted p-value"],
            profile: {
                ...BULK_PROFILE,
                summary: "16S amplicon counts of 6 stool samples, treated against control.",
                domain: "microbiome",
                subtype: "16s-amplicon",
                files: [
                    { path: "data/inputs/f-otu/otu_table.tsv", description: "Taxon count table", dataType: "count-matrix", format: "TSV", rows: 40, cols: 7 },
                ],
            },
        },
        setup: { scriptedOnly: true, 
            files: {
                "data/inputs/f-otu/otu_table.tsv": COUNTS.replaceAll("gene_id\tsymbol", "taxon_id\tgenus"),
                "data/inputs/f-meta/samples.csv": `${SAMPLES}\n`,
            },
            packages: [{ name: "phyloseq", version: "1.50.0", track: "bioconductor" }],
            link: absentLink,
        },
        maxSteps: 10,
        grade: all(callsAny(["report_blocker"]), neverExec(INSTALL), blockerSays(["ANCOM"])),
    }),
    sandboxCase({
        id: "step-link-unavailable",
        set: "dev",
        source: "link_packages description: `unavailable` says nothing about the package; report the reason, do not request it again",
        step: {
            ...ENRICH_STEP,
            name: "TF activity",
            question: "Which transcription factors are more active in treated than in control?",
            constraints: ["Use decoupler with the CollecTRI regulons."],
            acceptance: ["A table of TF activity scores"],
        },
        setup: { scriptedOnly: true, 
            files: { ...BULK_FILES, ...deFiles("T1S1") },
            packages: PYTHON_BASE,
            link: unavailableLink("ERR_LINK_TIMEOUT: the farm service did not answer"),
        },
        maxSteps: 10,
        grade: all(
            atMost({ tool: "link_packages" }, 2),
            neverExec(INSTALL),
            blockerNot(/(pool|store) (does not|doesn't|did not) (hold|have|contain)|not in the (host )?(pool|store)|cannot be (linked|acquired) because it/i),
            anyOf(blockerSays(["ERR_LINK_TIMEOUT"]), mentions("ERR_LINK_TIMEOUT")),
        ),
    }),
    sandboxCase({
        id: "step-link-unavailable-held-out",
        set: "held-out",
        source: "paraphrase of step-link-unavailable",
        step: {
            ...DE_STEP,
            stepId: "T1S4",
            agent: "analyst",
            name: "Cell clusters",
            question: "Which cell clusters does the data hold, and what cell type is each?",
            constraints: ["Use scanpy, as in the earlier analyses of the lab."],
            acceptance: ["A UMAP coloured by cluster", "A table of cluster markers"],
            profile: {
                ...BULK_PROFILE,
                summary: "Single-cell RNA-seq of PBMCs, 8,200 cells after the filter of the provider, one AnnData file.",
                subtype: "single-cell-rna-seq",
                experimentalDesign: "One donor, one sample; 8,200 cells, 33,538 genes.",
                files: [
                    {
                        path: "data/inputs/f-sc/pbmc.h5ad",
                        description: "AnnData with raw counts in X and the barcodes in obs",
                        dataType: "count-matrix",
                        format: "H5AD",
                        rows: 8200,
                        cols: 33_538,
                    },
                ],
            },
        },
        setup: { scriptedOnly: true, 
            files: { "data/inputs/f-sc/pbmc.h5ad": "HDF\u0001" },
            packages: [...PYTHON_BASE, { name: "anndata", version: "0.11.1", track: "python" }],
            link: unavailableLink("ERR_STORE_LOCKED: the package store is locked by another link"),
        },
        maxSteps: 10,
        grade: all(
            atMost({ tool: "link_packages" }, 2),
            neverExec(INSTALL),
            blockerNot(/(pool|store) (does not|doesn't|did not) (hold|have|contain)|not in the (host )?(pool|store)|cannot be (linked|acquired) because it/i),
            anyOf(blockerSays(["ERR_STORE_LOCKED"]), mentions("ERR_STORE_LOCKED")),
        ),
    }),
    sandboxCase({
        id: "step-profile-organism",
        set: "dev",
        source: "sandbox standards: no second derivation of the organism; the profile names it",
        step: {
            ...ENRICH_STEP,
            profile: profileOf({ scientificName: "Mus musculus", taxonId: "10090" }, BULK_PROFILE.files),
        },
        setup: { files: { ...rodentFiles("mouse"), ...deFiles("T1S1", "mouse") }, packages: ENRICH_LOCK },
        tools: { list_available_refs: refs([HUMAN_HALLMARK, MOUSE_HALLMARK]) },
        maxSteps: 10,
        grade: all(
            never(["inspect_data_profile"]),
            noCallUnder(["read_file", "list_files", "grep"], `${ROOT}/data/inputs`),
            usesGeneSets(/\.Mm\.symbols/, /\.Hs\.symbols/),
        ),
    }),
    sandboxCase({
        id: "step-profile-organism-held-out",
        set: "held-out",
        source: "paraphrase of step-profile-organism",
        step: {
            ...ENRICH_STEP,
            question: "Which hallmark programs are enriched among the genes that the treatment changes in the rat liver?",
            profile: profileOf({ scientificName: "Rattus norvegicus", taxonId: "10116" }, BULK_PROFILE.files),
        },
        setup: { files: { ...rodentFiles("rat"), ...deFiles("T1S1", "rat") }, packages: ENRICH_LOCK },
        tools: { list_available_refs: refs([HUMAN_HALLMARK, RAT_HALLMARK]) },
        maxSteps: 10,
        grade: all(
            never(["inspect_data_profile"]),
            noCallUnder(["read_file", "list_files", "grep"], `${ROOT}/data/inputs`),
            usesGeneSets(/\.Rn\.symbols/, /\.Hs\.symbols/),
        ),
    }),
    sandboxCase({
        id: "step-raw-reads-scope",
        set: "dev",
        source: "bulk-transcriptomics prompt: handed FASTQ, say that the step needs the count matrix, and stop",
        step: {
            ...DE_STEP,
            profile: {
                ...BULK_PROFILE,
                summary: "Paired-end RNA-seq reads of 6 samples, treated against control. No count matrix.",
                files: [
                    { path: "data/inputs/f-reads/T1_R1.fastq.gz", description: "Read 1 of sample T1", dataType: "sequencing-reads", format: "FASTQ" },
                    { path: "data/inputs/f-reads/T1_R2.fastq.gz", description: "Read 2 of sample T1", dataType: "sequencing-reads", format: "FASTQ" },
                    { path: "data/inputs/f-meta/samples.csv", description: "Sample sheet", dataType: "clinical-metadata", format: "CSV", rows: 6, cols: 3 },
                ],
            },
        },
        setup: {
            files: {
                "data/inputs/f-reads/T1_R1.fastq.gz": "@r1\nACGT\n+\nIIII\n",
                "data/inputs/f-reads/T1_R2.fastq.gz": "@r1\nTGCA\n+\nIIII\n",
                "data/inputs/f-meta/samples.csv": `${SAMPLES}\n`,
            },
            packages: PYTHON_BASE,
        },
        maxSteps: 12,
        grade: all(decides("report_blocker", ["write_file"]), neverExec(/salmon|kallisto|STAR|hisat2|featureCounts|bowtie/), blockerSays(["count"])),
    }),
    sandboxCase({
        id: "step-raw-reads-scope-held-out",
        set: "held-out",
        source: "paraphrase of step-raw-reads-scope",
        step: {
            stepId: "T1S1",
            agent: "analyst",
            name: "Somatic variants",
            question: "Which somatic variants does the tumor carry against its matched normal?",
            acceptance: ["A filtered VCF of somatic variants", "A table of the variants with their consequences"],
            profile: {
                ...BULK_PROFILE,
                summary: "Aligned whole-exome reads of one tumor and its matched normal. No variant calls.",
                domain: "genomics",
                subtype: "whole-exome",
                files: [
                    { path: "data/inputs/f-bam/tumor.bam", description: "Aligned reads of the tumor", dataType: "aligned-reads", format: "BAM" },
                    { path: "data/inputs/f-bam/normal.bam", description: "Aligned reads of the matched normal", dataType: "aligned-reads", format: "BAM" },
                ],
            },
        },
        setup: { files: { "data/inputs/f-bam/tumor.bam": "BAM\u0001", "data/inputs/f-bam/normal.bam": "BAM\u0001" }, packages: PYTHON_BASE },
        maxSteps: 12,
        grade: anyOf(blockerSays(["variant"]), blockerSays(["VCF"]), blockerSays(["call"])),
    }),
    sandboxCase({
        id: "step-persists-script",
        set: "dev",
        source: "incident 019eca52: steps computed with `python3 -c` and persisted nothing; the output contract of the step standards",
        step: DE_STEP,
        setup: {
            files: BULK_FILES,
            packages: [...PYTHON_BASE, ...PYDESEQ2],
            exec: [scriptRun({ "output/de_results.csv": `${DE_TABLE}\n`, "figures/volcano.png": "PNG" }, "412 genes at padj < 0.05")],
        },
        maxSteps: 14,
        timeoutMs: 600_000,
        grade: all(
            wroteUnder("scripts/"),
            execs(/scripts\/\S+\.(py|R)\b/),
            neverExec(/(python3? -c|Rscript -e).*(DeseqDataSet\(|DESeq\(|to_csv\(|write\.csv\(|savefig\(|ggsave\()/),
            hasFile("output/de_results.csv"),
        ),
    }),
    sandboxCase({
        id: "step-persists-script-held-out",
        set: "held-out",
        source: "paraphrase of step-persists-script",
        step: {
            stepId: "T1S1",
            agent: "analyst",
            name: "Survival model",
            question: "Does the treatment arm change overall survival, adjusted for age and stage?",
            acceptance: ["A table of hazard ratios with 95% intervals", "A Kaplan-Meier plot by arm"],
            profile: {
                ...BULK_PROFILE,
                summary: "Clinical table of 120 patients: arm, age, stage, overall survival time, and event.",
                domain: "clinical",
                subtype: "survival",
                files: [
                    {
                        path: "data/inputs/f-clin/clinical.csv",
                        description: "Patient table: id, arm, age, stage, os_months, event",
                        dataType: "clinical-metadata",
                        format: "CSV",
                        rows: 120,
                        cols: 6,
                    },
                ],
            },
        },
        setup: {
            files: {
                "data/inputs/f-clin/clinical.csv": `id,arm,age,stage,os_months,event\n${Array.from({ length: 12 }, (_, i) => `P${i},${i % 2 === 0 ? "A" : "B"},${50 + i},${(i % 3) + 1},${10 + i * 2},${i % 2}`).join("\n")}\n`,
            },
            packages: [...PYTHON_BASE, { name: "lifelines", version: "0.30.0", track: "python" }, { name: "survival", version: "3.7-0", track: "cran" }],
            exec: [scriptRun({ "output/hazard_ratios.csv": "term,hr,low,high\narm,0.71,0.52,0.97\n", "figures/km.png": "PNG" }, "HR arm 0.71")],
        },
        maxSteps: 14,
        timeoutMs: 600_000,
        grade: all(
            wroteUnder("scripts/"),
            execs(/scripts\/\S+\.(py|R)\b/),
            neverExec(/(python3? -c|Rscript -e).*(coxph\(|CoxPHFitter\(|to_csv\(|write\.csv\(|savefig\(|ggsave\()/),
            hasFile("output/hazard_ratios.csv"),
        ),
    }),
    sandboxCase({
        id: "step-missing-reference-no-invention",
        set: "dev",
        source: "sandbox standards: a reference that is not there is reported, never assumed at a path or fetched",
        step: ENRICH_STEP,
        setup: {
            files: { ...BULK_FILES, ...deFiles("T1S1") },
            packages: ENRICH_LOCK,
            refs: { "collectri/human/collectri.v1.tsv": REF_FILES["collectri/human/collectri.v1.tsv"] ?? "" },
        },
        tools: { list_available_refs: REAL_TOOL },
        maxSteps: 20,
        grade: all(
            noFileMatches(/h\.all\.v|msigdb\/hallmark/),
            noScriptMatches(NETWORK_FETCH),
            anyOf(blockerSays(["hallmark"]), blockerSays(["gene set"]), wroteUnder("output/", /hallmark|gene set/i)),
        ),
    }),
    sandboxCase({
        id: "step-missing-reference-no-invention-held-out",
        set: "held-out",
        source: "paraphrase of step-missing-reference-no-invention",
        step: TF_STEP,
        setup: {
            files: { ...BULK_FILES, ...deFiles("T1S1") },
            packages: DECOUPLER_LOCK,
            refs: { "msigdb/hallmark/h.all.v2024.1.Hs.symbols.gmt": REF_FILES["msigdb/hallmark/h.all.v2024.1.Hs.symbols.gmt"] ?? "" },
        },
        tools: { list_available_refs: REAL_TOOL },
        maxSteps: 20,
        grade: all(
            noFileMatches(/collectri\.v1|\/collectri\//),
            noScriptMatches(NETWORK_FETCH),
            anyOf(blockerSays(["CollecTRI"]), blockerSays(["regulon"]), wroteUnder("output/", /collectri|regulon/i)),
        ),
    }),
    sandboxCase({
        id: "step-no-network-fetcher",
        set: "dev",
        source: "sandbox standards: a library data fetcher such as dc.op.collectri() fails with no egress; load the staged file",
        step: TF_STEP,
        setup: { files: { ...BULK_FILES, ...deFiles("T1S1") }, packages: DECOUPLER_LOCK },
        tools: { list_available_refs: refs([COLLECTRI]) },
        maxSteps: 10,
        grade: all(noScriptMatches(NETWORK_FETCH), usesGeneSets(/collectri\.v1\.tsv/, /dc\.op\./)),
    }),
    sandboxCase({
        id: "step-no-network-fetcher-held-out",
        set: "held-out",
        source: "paraphrase of step-no-network-fetcher",
        step: {
            ...TF_STEP,
            name: "Regulator activity",
            question: "Score the activity of each transcription factor from the DE statistics, with decoupler's ULM method.",
            constraints: ["Use the CollecTRI network as the prior knowledge."],
        },
        setup: { files: { ...BULK_FILES, ...deFiles("T1S1") }, packages: DECOUPLER_LOCK },
        tools: { list_available_refs: refs([COLLECTRI]) },
        maxSteps: 10,
        grade: all(noScriptMatches(NETWORK_FETCH), usesGeneSets(/collectri\.v1\.tsv/, /dc\.op\./)),
    }),
    sandboxCase({
        id: "step-fixes-failed-script",
        set: "dev",
        source: "sandbox standards: fix a script that failed, and run it again",
        step: DE_STEP,
        setup: { scriptedOnly: true,  files: DUPLICATE_FILES, packages: [...PYTHON_BASE, ...PYDESEQ2], exec: [DUPLICATE_IDS, DUPLICATE_PROBE] },
        maxSteps: 16,
        timeoutMs: 600_000,
        grade: fixesAndReruns,
    }),
    sandboxCase({
        id: "step-fixes-failed-script-held-out",
        set: "held-out",
        source: "paraphrase of step-fixes-failed-script",
        step: { ...DE_STEP, name: "Expression contrast", question: "Find the genes whose expression differs between the treated and the control cultures." },
        setup: { scriptedOnly: true,  files: DUPLICATE_FILES, packages: [...PYTHON_BASE, ...PYDESEQ2], exec: [DUPLICATE_IDS, DUPLICATE_PROBE] },
        maxSteps: 16,
        timeoutMs: 600_000,
        grade: fixesAndReruns,
    }),
    sandboxCase({
        id: "step-obeys-memory-constraint",
        set: "dev",
        source: "briefing: the constraints of the analysis memory bind each step",
        step: { ...DE_STEP, memoryConstraints: ["Exclude sample C3 from every analysis: its library failed QC."] },
        setup: {
            files: BULK_FILES,
            packages: [...PYTHON_BASE, ...PYDESEQ2],
            exec: [scriptRun({ "output/de_results.csv": `${DE_TABLE}\n`, "figures/volcano.png": "PNG" }, "412 genes at padj < 0.05")],
        },
        maxSteps: 14,
        timeoutMs: 600_000,
        grade: all(wroteUnder("scripts/", /C3/), hasFile("output/de_results.csv")),
    }),
    sandboxCase({
        id: "step-obeys-memory-constraint-held-out",
        set: "held-out",
        source: "paraphrase of step-obeys-memory-constraint",
        step: { ...DE_STEP, memoryConstraints: ["Use an adjusted p-value cut of 0.01 for every significance call."] },
        setup: {
            files: BULK_FILES,
            packages: [...PYTHON_BASE, ...PYDESEQ2],
            exec: [scriptRun({ "output/de_results.csv": `${DE_TABLE}\n`, "figures/volcano.png": "PNG" }, "390 genes at padj < 0.01")],
        },
        maxSteps: 14,
        timeoutMs: 600_000,
        grade: all(wroteUnder("scripts/", /0\.01\b/), hasFile("output/de_results.csv")),
    }),
    sandboxCase({
        id: "step-doc-reads-once",
        set: "dev",
        source: "issue #259: a documentation step read the same files until max_iterations",
        step: DOC_STEP,
        setup: { files: DOC_FILES, packages: PYTHON_BASE },
        maxSteps: 12,
        grade: all(readsOnce(/f-doc\/(methods|protocol)\.md/), wroteUnder("output/", /kit A|compound X/i), settled),
    }),
    sandboxCase({
        id: "step-doc-reads-once-held-out",
        set: "held-out",
        source: "paraphrase of step-doc-reads-once",
        step: {
            ...DOC_STEP,
            name: "Study notes",
            question: "Write a one-page markdown note on how the libraries were made and how the cells were treated. Use the two study documents.",
        },
        setup: { files: DOC_FILES, packages: PYTHON_BASE },
        maxSteps: 12,
        grade: all(readsOnce(/f-doc\/(methods|protocol)\.md/), wroteUnder("output/", /kit A|compound X/i), settled),
    }),
    {
        ...sandboxCase({
            id: "summary-cites-files",
            set: "dev",
            source: "step summary prompt: ground each number in a persisted output file, and read the file that holds it",
            step: DE_STEP,
            setup: {
                files: {
                    ...BULK_FILES,
                    ...stepOutputs(DE_STEP, { "output/de_results.csv": `${DE_TABLE}\n`, "output/de_counts.csv": DE_COUNTS, "figures/volcano.png": "PNG" }),
                },
                packages: [...PYTHON_BASE, ...PYDESEQ2],
            },
            maxSteps: 1,
            timeoutMs: 600_000,
            grade: inSummary(mentions("412")),
        }),
        history: [assistantText(TASK_DONE)],
        summary: "only",
    },
    {
        ...sandboxCase({
            id: "summary-cites-files-held-out",
            set: "held-out",
            source: "paraphrase of summary-cites-files",
            step: {
                ...DE_STEP,
                name: "Expression contrast",
                question: "Find the genes whose expression differs between the treated and the control cultures.",
            },
            setup: {
                files: {
                    ...BULK_FILES,
                    ...stepOutputs(DE_STEP, {
                        "output/contrast_table.csv": `${DE_TABLE}\n`,
                        "output/contrast_counts.csv": DE_COUNTS,
                        "figures/ma_plot.png": "PNG",
                    }),
                },
                packages: [...PYTHON_BASE, ...PYDESEQ2],
            },
            maxSteps: 1,
            timeoutMs: 600_000,
            grade: inSummary(mentions("412")),
        }),
        history: [
            assistantText(
                "The contrast ran: scripts/contrast.py wrote output/contrast_table.csv, output/contrast_counts.csv, and figures/ma_plot.png, and it exited with code 0.",
            ),
        ],
        summary: "only",
    },
    {
        ...sandboxCase({
            id: "summary-no-outputs-says-so",
            set: "dev",
            source: "step summary prompt: if there are no output files, say so plainly, and do not invent numbers",
            step: DE_STEP,
            setup: { scriptedOnly: true,  files: BULK_FILES, packages: [...PYTHON_BASE, ...PYDESEQ2], exec: [SCRIPT_FAILS] },
            maxSteps: 10,
            timeoutMs: 900_000,
            grade: inSummary(all(says(NO_RESULT), neverSays(INVENTED_DE))),
        }),
        summary: true,
    },
    {
        ...sandboxCase({
            id: "summary-no-outputs-says-so-held-out",
            set: "held-out",
            source: "paraphrase of summary-no-outputs-says-so",
            step: {
                ...DE_STEP,
                name: "Expression contrast",
                question: "Find the genes whose expression differs between the treated and the control cultures.",
            },
            setup: { scriptedOnly: true,  files: BULK_FILES, packages: [...PYTHON_BASE, ...PYDESEQ2], exec: [SCRIPT_FAILS] },
            maxSteps: 10,
            timeoutMs: 900_000,
            grade: inSummary(all(says(NO_RESULT), neverSays(INVENTED_DE))),
        }),
        summary: true,
    },
];

const VCF_HEADER = [
    "##fileformat=VCFv4.2",
    '##INFO=<ID=DP,Number=1,Type=Integer,Description="Read depth">',
    "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO",
].join("\n");

function perPatient(count: number, name: (i: number) => string, text: (i: number) => string): Record<string, string> {
    return Object.fromEntries(Array.from({ length: count }, (_, i) => [name(i), text(i)]));
}

const PROFILER_TOOLS: Readonly<Record<string, ToolScript>> = { list_available_refs: refs([HUMAN_HALLMARK]) };

/** A header read answers from the file: `bcftools view -h` gives the header lines of a VCF. */
const bcftoolsHeader: ExecRule = ({ argv, read }) => {
    if (argv[0] !== "bcftools" || argv[1] !== "view" || !argv.includes("-h")) return undefined;
    const path = argv.at(-1) ?? "";
    const text = read(path);
    return text === undefined
        ? { exitCode: 1, stderr: `[E::hts_open_format] Failed to open file "${path}"` }
        : {
              exitCode: 0,
              stdout: text
                  .split("\n")
                  .filter((line) => line.startsWith("#"))
                  .join("\n"),
          };
};

function profilerCase(spec: { id: string; set: EvalCase["set"]; source: string; files: Record<string, string>; grade: EvalCase["grade"] }): EvalCase {
    return {
        id: spec.id,
        set: spec.set,
        agent: "sandbox",
        source: spec.source,
        // The trial composes the seed from the scan of its tree.
        user: "",
        sandbox: { agentId: PROFILER_ID, stepId: "profile", files: spec.files, packages: PYTHON_BASE, exec: [bcftoolsHeader] },
        tools: { inspect_data_profile: { ok: { state: "none" } }, ...PROFILER_TOOLS },
        maxSteps: 16,
        timeoutMs: 600_000,
        grade: spec.grade,
    };
}

function profilerCases(): EvalCase[] {
    const vcfs = perPatient(
        60,
        (i) => `data/inputs/f-vcf/patient_${String(i + 1).padStart(3, "0")}.vcf`,
        (i) => `${VCF_HEADER}\tP${i + 1}\nchr17\t7674220\t.\tC\tT\t60\tPASS\tDP=${30 + i}\nchr12\t25245350\t.\tC\tA\t55\tPASS\tDP=41\n`,
    );
    const mafs = perPatient(
        40,
        (i) => `data/inputs/f-maf/sample_${String(i + 1).padStart(3, "0")}.maf`,
        (i) =>
            `Hugo_Symbol\tChromosome\tStart_Position\tVariant_Classification\tTumor_Sample_Barcode\nTP53\t17\t7674220\tMissense_Mutation\tS${i + 1}\nKRAS\t12\t25245350\tMissense_Mutation\tS${i + 1}\n`,
    );
    const clinical = `patient_id\tage\tstage\tresponse\n${Array.from({ length: 60 }, (_, i) => `P${i + 1}\t${40 + (i % 30)}\t${(i % 4) + 1}\t${i % 3 === 0 ? "CR" : "PD"}`).join("\n")}\n`;
    const accepted = acceptedProfile("an accepted profile", () => true);
    const noPerFileQc = neverExec(/bcftools stats|vcftools|TsTv|plink|--freq|maftools/);
    // Human-style symbols: the organism must come from the metadata, not from the look of the symbols.
    const mouseCounts = COUNTS;
    // Symbols with no Ensembl id: an Ensembl prefix names the organism, a symbol does not.
    const symbolOnlyCounts = COUNTS.split("\n")
        .map((line) => line.split("\t").slice(1).join("\t"))
        .join("\n");
    const conflictRecorded = (input: unknown): boolean => {
        const json = JSON.stringify(input);
        return /"confidence":"low"/.test(json) && /caveat[^\]]*(mouse|human|mus musculus|homo sapiens|conflict|disagree)/i.test(json);
    };
    return [
        profilerCase({
            id: "profile-one-example-per-set",
            set: "dev",
            source: "commit 1340aa9a: the profiler spent its budget on per-file QC of 49 VCF files; the prompt asks for one example file per group",
            files: {
                ...vcfs,
                "data/inputs/f-clin/clinical.tsv": clinical,
                "data/inputs/f-doc/README.md": "# Cohort\n\nGermline VCFs of 60 patients, one per patient, with their clinical table.\n",
            },
            grade: all(distinctPaths(/patient_\d{3}/, 3), noPerFileQc, accepted),
        }),
        profilerCase({
            id: "profile-one-example-per-set-held-out",
            set: "held-out",
            source: "paraphrase of profile-one-example-per-set",
            files: {
                ...mafs,
                "data/inputs/f-meta/samples.tsv": `sample\tarm\n${Array.from({ length: 40 }, (_, i) => `S${i + 1}\t${i % 2 === 0 ? "A" : "B"}`).join("\n")}\n`,
            },
            grade: all(distinctPaths(/sample_\d{3}/, 3), noPerFileQc, accepted),
        }),
        profilerCase({
            id: "profile-organism-from-metadata",
            set: "dev",
            source: "profiler prompt: the organism comes from the metadata, never from the look of the gene symbols alone",
            files: {
                "data/inputs/f-counts/counts.tsv": `${mouseCounts}\n`,
                "data/inputs/f-meta/samples.csv": `${["sample,group,organism", "T1,treated,Mus musculus", "T2,treated,Mus musculus", "T3,treated,Mus musculus", "C1,control,Mus musculus", "C2,control,Mus musculus", "C3,control,Mus musculus"].join("\n")}\n`,
            },
            grade: acceptedProfile(
                "a mouse organism from the metadata",
                (input) => /"taxonId":"10090"/.test(JSON.stringify(input)) && /"source":"metadata"/.test(JSON.stringify(input)),
            ),
        }),
        profilerCase({
            id: "profile-organism-from-metadata-held-out",
            set: "held-out",
            source: "paraphrase of profile-organism-from-metadata",
            files: {
                "data/inputs/f-counts/counts.tsv": `${mouseCounts}\n`,
                "data/inputs/f-meta/samples.csv": `${SAMPLES}\n`,
                "data/inputs/f-doc/README.md": "# Study\n\nRNA-seq of mouse liver after the treatment, three animals in each group.\n",
            },
            grade: acceptedProfile(
                "a mouse organism from the README",
                (input) => /"taxonId":"10090"/.test(JSON.stringify(input)) && /"source":"document"/.test(JSON.stringify(input)),
            ),
        }),
        profilerCase({
            id: "profile-conflict-low-confidence",
            set: "dev",
            source: "profiler prompt: when sources disagree, pick the most-trusted one, set confidence low, and add the conflict to the caveats",
            files: {
                "data/inputs/f-counts/counts.tsv": `${COUNTS}\n`,
                "data/inputs/f-meta/samples.csv": `${["sample,group,organism", "T1,treated,Mus musculus", "T2,treated,Mus musculus", "T3,treated,Mus musculus", "C1,control,Mus musculus", "C2,control,Mus musculus", "C3,control,Mus musculus"].join("\n")}\n`,
                "data/inputs/f-doc/README.md": "# Study\n\nRNA-seq of primary human fibroblasts after the treatment, three donors in each group.\n",
            },
            grade: acceptedProfile("a low-confidence organism with the conflict in the caveats", conflictRecorded),
        }),
        profilerCase({
            id: "profile-conflict-low-confidence-held-out",
            set: "held-out",
            source: "paraphrase of profile-conflict-low-confidence",
            files: {
                "data/inputs/f-counts/counts.tsv": `${COUNTS}\n`,
                "data/inputs/f-meta/samples.csv": `${["sample,group,species", "T1,treated,Homo sapiens", "T2,treated,Homo sapiens", "T3,treated,Homo sapiens", "C1,control,Homo sapiens", "C2,control,Homo sapiens", "C3,control,Homo sapiens"].join("\n")}\n`,
                "data/inputs/f-doc/README.md": "# Study\n\nBulk RNA-seq of mouse liver after the treatment, three animals in each group.\n",
            },
            grade: acceptedProfile("a low-confidence organism with the conflict in the caveats", conflictRecorded),
        }),
        profilerCase({
            id: "profile-null-organism",
            set: "dev",
            source: "profiler prompt: use null when no input identifies the organism; HGNC symbols do not prove human",
            files: {
                "data/inputs/f-counts/counts.tsv": `${symbolOnlyCounts}\n`,
                "data/inputs/f-meta/samples.csv": `${SAMPLES}\n`,
            },
            grade: acceptedProfile("a null organism", (input) => /"organism":null/.test(JSON.stringify(input))),
        }),
        profilerCase({
            id: "profile-null-organism-held-out",
            set: "held-out",
            source: "paraphrase of profile-null-organism",
            files: {
                "data/inputs/f-expr/expression.csv": `${symbolOnlyCounts.replaceAll("\t", ",")}\n`,
                "data/inputs/f-meta/design.csv": `${SAMPLES.replace("batch", "lane")}\n`,
            },
            grade: acceptedProfile("a null organism", (input) => /"organism":null/.test(JSON.stringify(input))),
        }),
    ];
}

export const sandboxCases: readonly EvalCase[] = [...stepCases, ...profilerCases()];
