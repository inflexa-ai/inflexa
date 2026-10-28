/**
 * The decision cases of the sandbox step agents.
 *
 * The message of each case is the briefing that `execute_analysis` composes at dispatch, from the real composer. The
 * agent works on a throwaway tree with the real workspace tools, the real package listing over a farm lock, and the
 * real link tool over a scripted link answer. A command never runs: the rules of the case and the default rules of
 * `lib/sandbox.ts` answer it.
 */

import type { DataProfileResult } from "@inflexa-ai/harness/contracts/data-profile.js";
import { composeStepBriefing, type UpstreamHandoff } from "@inflexa-ai/harness/prompts/briefing.js";
import type { PackageQuery } from "@inflexa-ai/harness/sandbox/package-identity.js";
import type { PackageRequestOutcome } from "@inflexa-ai/harness/sandbox/types.js";

import type { ToolScript } from "../lib/agent.js";
import {
    all,
    anyOf,
    atMost,
    before,
    blockerNot,
    blockerSays,
    callsAny,
    decides,
    execs,
    hasFile,
    mentions,
    never,
    neverExec,
    neverWith,
    noCallUnder,
    wroteUnder,
    acceptedProfile,
    distinctPaths,
    type CallMatch,
    type EvalCase,
} from "../lib/case.js";
import { ANALYSIS_ID, PROFILER_ID, workingDirOf, type ExecRule, type LockedPackage, type SandboxSetup } from "../lib/sandbox.js";

const ROOT = `/${ANALYSIS_ID}`;
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

type StepSpec = {
    readonly stepId: string;
    readonly agent: string;
    readonly name: string;
    readonly question: string;
    readonly constraints?: readonly string[];
    readonly acceptance: readonly string[];
    readonly profile: DataProfileResult | null;
    readonly upstream?: readonly UpstreamHandoff[];
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
            resources: { cpu: 4, memoryGb: 16 },
            agent: spec.agent,
            maxSteps: 200,
        },
        workspace: { analysisId: ANALYSIS_ID, workingDir: workingDirOf({ agentId: spec.agent, stepId: spec.stepId }) },
        profile: spec.profile,
        upstream: spec.upstream ?? [],
        memory: { goal: "Find the transcriptional response to the treatment.", constraints: [] },
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

function deHandoff(stepId: string): UpstreamHandoff {
    const dir = `${ROOT}/runs/run-001/${stepId}`;
    return {
        stepId,
        agentId: "bulk-transcriptomics-agent",
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
        agentId: "bulk-transcriptomics-agent",
        summaryMarkdown: QC_SUMMARY,
        summaryPath: `${dir}/output/summary.md`,
        outputDir: `${dir}/output`,
        artifacts: [`${dir}/output/qc_metrics.csv`],
    };
}

function qcFiles(stepId: string): Readonly<Record<string, string>> {
    return { [`runs/run-001/${stepId}/output/qc_metrics.csv`]: QC_TABLE, [`runs/run-001/${stepId}/output/summary.md`]: QC_SUMMARY };
}

function deFiles(stepId: string, style: SymbolStyle = "human"): Readonly<Record<string, string>> {
    return { [`runs/run-001/${stepId}/output/de_results.csv`]: `${deTableOf(style)}\n`, [`runs/run-001/${stepId}/output/summary.md`]: DE_SUMMARY };
}

/** The inputs of a rodent study: the counts with the gene names of the rodent, and the sample sheet. */
function rodentFiles(style: "mouse" | "rat"): Readonly<Record<string, string>> {
    return { "data/inputs/f-counts/counts.tsv": `${countsOf(style)}\n`, "data/inputs/f-meta/samples.csv": `${SAMPLES}\n` };
}

const PYTHON_BASE: readonly LockedPackage[] = [
    { name: "pandas", version: "2.2.3", track: "python" },
    { name: "numpy", version: "2.1.3", track: "python" },
    { name: "matplotlib", version: "3.9.2", track: "python" },
    { name: "seaborn", version: "0.13.2", track: "python" },
    { name: "scipy", version: "1.14.1", track: "python" },
];

/** PyDESeq2 with the distributions that it imports. */
const PYDESEQ2: readonly LockedPackage[] = [
    { name: "pydeseq2", version: "0.4.12", track: "python" },
    { name: "anndata", version: "0.11.1", track: "python" },
    { name: "scikit-learn", version: "1.5.2", track: "python" },
    { name: "formulaic", version: "1.1.0", track: "python" },
];

/** A canned answer of `list_available_refs`. */
function refs(lines: readonly string[]): ToolScript {
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
const REF_FILES: Readonly<Record<string, string>> = {
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

/**
 * The step makes sure that `pkg` is present before a script of the step runs: a package listing or a link that names
 * it, or an inline import of it, which fails when the package is absent.
 */
function checksBeforeUse(pkg: RegExp): EvalCase["grade"] {
    const importProbe: CallMatch = {
        tool: "execute_command",
        input: (input) => /python3? -c/.test(JSON.stringify(input)) && new RegExp(`import ${pkg.source}`, "i").test(JSON.stringify(input)),
    };
    return anyOf(
        before({ tool: "list_available_packages", input: names(pkg) }, runsScript),
        before({ tool: "link_packages", input: names(pkg) }, runsScript),
        before(importProbe, runsScript),
    );
}

function names(word: RegExp): CallMatch["input"] {
    return (input) => word.test(JSON.stringify(input));
}

function absentLink(query: PackageQuery): PackageRequestOutcome {
    return { kind: "absent", spelling: query.spelling, acquisitionPossible: false, detail: "no staged distribution matches" };
}

function unavailableLink(reason: string): (query: PackageQuery) => PackageRequestOutcome {
    return (query) => ({ kind: "unavailable", spelling: query.spelling, reason });
}

type SandboxCaseSpec = {
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

function sandboxCase(spec: SandboxCaseSpec): EvalCase {
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
    agent: "bulk-transcriptomics-agent",
    name: "Differential expression",
    question: "Which genes change between treated and control?",
    acceptance: ["A table of each gene with log2 fold change and adjusted p-value", "A volcano plot"],
    profile: BULK_PROFILE,
};

/** The step uses its briefing: no hunt for its inputs, no second read of the profile, and work starts. */
function usesBriefing(): EvalCase["grade"] {
    return all(never(["inspect_data_profile", "workspace_search"]), noCallUnder(["list_files", "grep", "file_stat"], `${ROOT}/data`), callsAny(["write_file"]));
}

const ENRICH_STEP: StepSpec = {
    stepId: "T1S2",
    agent: "enrichment-agent",
    name: "Hallmark enrichment",
    question: "Which hallmark pathways do the treatment-responsive genes enrich for?",
    acceptance: ["A table of hallmark sets with enrichment statistics", "A dot plot of the top sets"],
    profile: BULK_PROFILE,
    upstream: [deHandoff("T1S1")],
};

const ENRICH_LOCK: readonly LockedPackage[] = [...PYTHON_BASE, { name: "gseapy", version: "1.1.4", track: "python" }];

const stepCases: readonly EvalCase[] = [
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
            callsAny(["write_file"]),
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
            neverExec(/output\/summary\.md/),
            callsAny(["write_file"]),
        ),
    }),
    sandboxCase({
        id: "step-package-lookup",
        set: "dev",
        source: "sandbox standards: look a package up before an import of a package that is not certain to be present",
        step: { ...ENRICH_STEP, constraints: ["Run a preranked GSEA with gseapy."] },
        setup: { files: { ...BULK_FILES, ...deFiles("T1S1") }, packages: ENRICH_LOCK },
        maxSteps: 10,
        grade: checksBeforeUse(/gseapy/i),
    }),
    sandboxCase({
        id: "step-package-lookup-held-out",
        set: "held-out",
        source: "paraphrase of step-package-lookup",
        step: { ...DE_STEP, constraints: ["Use PyDESeq2 for the model."] },
        setup: { files: BULK_FILES, packages: [...PYTHON_BASE, ...PYDESEQ2] },
        maxSteps: 10,
        grade: checksBeforeUse(/pydeseq2/i),
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
        setup: { files: BULK_FILES, packages: [{ name: "data.table", version: "1.16.2", track: "cran" }], link: absentLink },
        maxSteps: 10,
        grade: all(callsAny(["report_blocker"]), neverExec(INSTALL), blockerSays(["xCell2"])),
    }),
    sandboxCase({
        id: "step-absent-package-blocks-held-out",
        set: "held-out",
        source: "paraphrase of step-absent-package-blocks",
        step: {
            stepId: "T2S1",
            agent: "microbiome-agent",
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
        setup: {
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
        setup: {
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
            agent: "single-cell-agent",
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
        setup: {
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
        maxSteps: 6,
        grade: all(decides("report_blocker", ["write_file"]), neverExec(/salmon|kallisto|STAR|hisat2|featureCounts|bowtie/), blockerSays(["count"])),
    }),
    sandboxCase({
        id: "step-raw-reads-scope-held-out",
        set: "held-out",
        source: "paraphrase of step-raw-reads-scope",
        step: {
            stepId: "T1S1",
            agent: "genomic-variant-agent",
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
        maxSteps: 8,
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
            agent: "statistical-modeling-agent",
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
    ];
}

export const sandboxCases: readonly EvalCase[] = [...stepCases, ...profilerCases()];
