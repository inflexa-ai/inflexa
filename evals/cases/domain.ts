/**
 * The domain cases of the sandbox step agents: one case for each method choice that the stance of a step agent drives.
 *
 * Each case grades the scripts that the step writes, not a call. The scripted sandbox runs no code, thus a script that
 * runs leaves the files that it names, and the grade reads the decision in the text of the script. A case names the
 * current specialist of its domain. `--sandbox-arm` runs the same case on a variant of the step agents.
 */

import type { DataProfileResult } from "@inflexa-ai/harness/contracts/data-profile.js";
import type { UpstreamHandoff } from "@inflexa-ai/harness/prompts/briefing.js";

import { all, anyOf, says, type EvalCase, type Grade, type Trial } from "../lib/case.js";
import { ANALYSIS_ID, type ExecRule, type LockedPackage, type SandboxSetup } from "../lib/sandbox.js";
import {
    PYDESEQ2,
    PYTHON_BASE,
    REF_FILES,
    ROOT,
    deFiles,
    deHandoff,
    namedOutputsRun,
    refs,
    sandboxCase,
    type SandboxCaseSpec,
    type StepSpec,
} from "./sandbox.js";

const HUMAN = { scientificName: "Homo sapiens", taxonId: "9606" };
const MOUSE = { scientificName: "Mus musculus", taxonId: "10090" };

type ProfileFile = NonNullable<DataProfileResult["files"]>[number];

function profile(spec: {
    readonly summary: string;
    readonly domain: string;
    readonly subtype: string;
    readonly organism: { scientificName: string; taxonId: string };
    readonly condition: string;
    readonly design: string;
    readonly files: readonly ProfileFile[];
}): DataProfileResult {
    return {
        summary: spec.summary,
        files: [...spec.files],
        profiledAt: "2026-11-09T08:00:00.000Z",
        domain: spec.domain,
        subtype: spec.subtype,
        organism: { ...spec.organism, source: "metadata", confidence: "high" },
        condition: spec.condition,
        experimentalDesign: spec.design,
        qualityAssessment: { concerns: [] },
    };
}

function file(path: string, description: string, dataType: string, format: string, rows: number, cols: number): ProfileFile {
    return { path, description, dataType, format, rows, cols };
}

/** A deterministic value in [0, 1) for a position, thus each fixture is the same in each trial. */
function unit(i: number, j: number): number {
    return (((i + 1) * 7919 + (j + 1) * 104_729) % 9973) / 9973;
}

function table(header: readonly string[], rows: readonly (readonly (string | number)[])[], sep = ","): string {
    return `${[header.join(sep), ...rows.map((row) => row.join(sep))].join("\n")}\n`;
}

const R_TRACK = (names: readonly string[], track: "cran" | "bioconductor"): LockedPackage[] => names.map((name) => ({ name, version: "1.0.0", track }));
const PY = (names: readonly string[]): LockedPackage[] => names.map((name) => ({ name, version: "1.0.0", track: "python" }));

/** A farm that holds the count models and the linear models, thus a wrong choice is not a missing package. */
const MATRIX_LOCK: readonly LockedPackage[] = [
    ...PYTHON_BASE,
    ...PYDESEQ2,
    ...PY(["statsmodels", "rpy2"]),
    ...R_TRACK(["limma", "edgeR", "DESeq2", "sva", "DEP", "vsn", "minfi", "missMethyl", "IlluminaHumanMethylationEPICanno.ilm10b4.hg19"], "bioconductor"),
];

const CELL_LOCK: readonly LockedPackage[] = [
    ...PYTHON_BASE,
    ...PYDESEQ2,
    ...PY(["scanpy", "decoupler", "rpy2"]),
    ...R_TRACK(["CATALYST", "flowCore", "diffcyt", "FlowSOM", "SingleCellExperiment", "edgeR", "limma"], "bioconductor"),
];

const ENRICH_LOCK: readonly LockedPackage[] = [...PYTHON_BASE, ...PY(["gseapy", "rpy2"]), ...R_TRACK(["missMethyl", "fgsea", "limma"], "bioconductor")];

const MODEL_LOCK: readonly LockedPackage[] = [...PYTHON_BASE, ...PY(["scikit-learn", "statsmodels", "lifelines", "scikit-survival", "xgboost"])];

const GENETICS_LOCK: readonly LockedPackage[] = [...PYTHON_BASE, ...PY(["cyvcf2", "pyranges", "pyliftover", "statsmodels"])];

/** The working-directory scripts of a trial. */
function scriptsOf(trial: Trial): (readonly [string, string])[] {
    return Object.entries(trial.files ?? {}).filter(([path]) => path.startsWith("scripts/"));
}

function scriptNames(trial: Trial): string {
    return (
        scriptsOf(trial)
            .map(([path]) => path)
            .join(", ") || "none"
    );
}

/** The first script that does the work of the step: it matches `work`. */
function workScript(trial: Trial, work: RegExp): readonly [string, string] | undefined {
    return scriptsOf(trial).find(([, text]) => work.test(text));
}

/** The command lines of the trial and the text of each script, for a fact that a command or a script can carry. */
function commandsAndScripts(trial: Trial): string {
    const commands = trial.calls.flatMap((call) => (call.tool === "execute_command" ? [JSON.stringify(call.input)] : []));
    return [...commands, ...scriptsOf(trial).map(([, text]) => text)].join("\n");
}

const COUNT_MODEL = /DeseqDataSet|DeseqStats|\bDESeq\s*\(|DESeqDataSet|DGEList|glmQLFit|glmFit|exactTest|\bvoom\s*\(/;
const LINEAR_MODEL = /lmFit|eBayes|test_diff|groupComparison|ttest_ind|ttest_rel|\bt\.test\s*\(|\bols\s*\(|\bOLS\s*\(|\blm\s*\(|mixedlm|wilcox|mannwhitneyu/;
// A hand-written test reads its p-value from a t distribution, for example `stats.t.sf` or `pt()`.
const ANY_TEST = new RegExp(`${COUNT_MODEL.source}|${LINEAR_MODEL.source}|f_oneway|kruskal|ttest_1samp|\\bt\\.(sf|cdf)\\s*\\(|\\bpt\\s*\\(`);

/** The differential script of continuous values uses a linear model or a test of means, and no count model. */
function linearNotCount(): EvalCase["grade"] {
    return (trial) => {
        const counting = workScript(trial, COUNT_MODEL);
        if (counting !== undefined) return { pass: false, detail: `${counting[0]} fits a count model on continuous values` };
        const linear = workScript(trial, LINEAR_MODEL);
        return linear === undefined
            ? { pass: false, detail: `no differential script (scripts: ${scriptNames(trial)})` }
            : { pass: true, detail: `${linear[0]} fits a linear model` };
    };
}

/** With one sample in each group, no script runs a test, a script computes the fold change, and the reply says why. */
function descriptiveOnly(): EvalCase["grade"] {
    const noTest = (trial: Trial): Grade => {
        const tested = workScript(trial, ANY_TEST);
        if (tested !== undefined) return { pass: false, detail: `${tested[0]} runs a test with one sample in each group` };
        const fold = workScript(trial, /log2|log\s*\(|fold/i);
        return fold === undefined
            ? { pass: false, detail: `no script computes a fold change (scripts: ${scriptNames(trial)})` }
            : { pass: true, detail: `${fold[0]} gives effect sizes only` };
    };
    return all(noTest, says(/replicat|pool(ed|ing)?\b|one sample (in|for|of) each|single sample|n\s*=\s*1\b/i));
}

/** A test on proportions runs on the logit (M-value) scale. */
function testsOnLogit(): EvalCase["grade"] {
    const logit = /beta2m|B2M\b|getM\s*\(|logit|log2\s*\(\s*\w+(\[[^\]]*\])?\s*\/\s*\(\s*1\s*-|np\.log2\s*\(\s*\w+\s*\/\s*\(\s*1\s*-|m_?values?/i;
    return (trial) => {
        const test = workScript(trial, ANY_TEST);
        if (test === undefined) return { pass: false, detail: `no differential script (scripts: ${scriptNames(trial)})` };
        return logit.test(test[1]) ? { pass: true, detail: `${test[0]} tests M-values` } : { pass: false, detail: `${test[0]} tests beta values` };
    };
}

/** The differential model holds the batch column as a term, or a batch correction keeps the group in its model. */
function batchInModel(column: string): EvalCase["grade"] {
    const term = new RegExp(
        `~[^"'\\n]*\\b${column}\\b|design_factors\\s*=\\s*\\[[^\\]]*["']${column}["']|model\\.matrix\\s*\\([^)]*\\b${column}\\b|\\b${column}\\b[^\\n]*\\+[^\\n]*group|ComBat(_seq)?\\s*\\([^)]*(group|covar)`,
    );
    // A variable that the script builds from the column, for example `day <- factor(m$run_day)`, then names in a formula.
    const alias = new RegExp(`(\\w+)\\s*(<-|=)\\s*[^\\n]*\\b${column}\\b`, "g");
    return (trial) => {
        const model = workScript(trial, ANY_TEST);
        if (model === undefined) return { pass: false, detail: `no differential script (scripts: ${scriptNames(trial)})` };
        if (term.test(model[1])) return { pass: true, detail: `${model[0]} models ${column}` };
        const aliases = [...model[1].matchAll(alias)].map((match) => match[1]).filter((name) => name !== undefined && name !== column);
        const inFormula = aliases.find((name) => new RegExp(`~[^"'\\n]*\\b${name}\\b`).test(model[1]));
        return inFormula === undefined
            ? { pass: false, detail: `${model[0]} ignores ${column}` }
            : { pass: true, detail: `${model[0]} models ${column} as ${inFormula}` };
    };
}

/** A matrix that arrives normalized gets no second normalization, and `logged` values get no log transform. */
function noSecondNormalization(valueColumn: string, logged: boolean): EvalCase["grade"] {
    const normalize =
        /normalizeBetweenArrays|justvsn|vsn2|\bvsn\s*\(|quantile_?normali|median_?normali|medianNorm|normalize_?median|normalizeQuantiles|ComBat/i;
    const relog = new RegExp(`log2?1?p?\\s*\\([^)]*${valueColumn}`, "i");
    return (trial) => {
        const scripts = scriptsOf(trial);
        if (workScript(trial, ANY_TEST) === undefined) return { pass: false, detail: `no differential script (scripts: ${scriptNames(trial)})` };
        const normalized = scripts.find(([, text]) => normalize.test(text));
        if (normalized !== undefined) return { pass: false, detail: `${normalized[0]} normalizes the values again` };
        const logs = logged ? scripts.find(([, text]) => relog.test(text)) : undefined;
        return logs === undefined ? { pass: true, detail: "no second normalization" } : { pass: false, detail: `${logs[0]} takes the log of ${valueColumn}` };
    };
}

/** A contrast between conditions aggregates the cells of each `replicate` before the test, and no test runs on cells. */
function pseudobulk(replicate: string, condition: string): EvalCase["grade"] {
    const perCell = new RegExp(`rank_genes_groups\\s*\\([^)]*groupby\\s*=\\s*["']${condition}["']|FindMarkers\\s*\\([^)]*${condition}`);
    const aggregate = /pseudobulk|pseudo_bulk|sc\.get\.aggregate|aggregateAcrossCells|\.groupby\s*\(|aggregate\s*\(|rowsum\s*\(|\.sum\s*\(/i;
    return (trial) => {
        const cellTest = scriptsOf(trial).find(([, text]) => perCell.test(text));
        if (cellTest !== undefined) return { pass: false, detail: `${cellTest[0]} tests ${condition} across cells` };
        const pooled = scriptsOf(trial).find(([, text]) => aggregate.test(text) && new RegExp(`\\b${replicate}\\b`).test(text));
        return pooled === undefined
            ? { pass: false, detail: `no script aggregates by ${replicate} (scripts: ${scriptNames(trial)})` }
            : { pass: true, detail: `${pooled[0]} aggregates by ${replicate}` };
    };
}

/** The clustering script selects the lineage markers of the panel. */
function clustersOnLineage(lineage: string): EvalCase["grade"] {
    // CATALYST names the lineage class `type` in `prepData`, thus `features = "type"` selects the lineage markers.
    const select = new RegExp(`features\\s*=\\s*["'](${lineage}|type)["']|["']${lineage}["']`);
    return (trial) => {
        const clustering = workScript(trial, /\bcluster\s*\(|FlowSOM|BuildSOM|leiden|louvain|phenograph|KMeans|kmeans/i);
        if (clustering === undefined) return { pass: false, detail: `no clustering script (scripts: ${scriptNames(trial)})` };
        return select.test(clustering[1])
            ? { pass: true, detail: `${clustering[0]} clusters on the ${lineage} markers` }
            : { pass: false, detail: `${clustering[0]} does not select the ${lineage} markers` };
    };
}

/** The pre-ranked test ranks on a signed statistic. */
function signedRank(): EvalCase["grade"] {
    return (trial) => {
        const ranked = workScript(trial, /prerank\s*\(|fgsea\s*\(|fgseaMultilevel|GSEA\s*\(/);
        if (ranked === undefined) return { pass: false, detail: `no pre-ranked script (scripts: ${scriptNames(trial)})` };
        return /log2FoldChange|np\.sign|\bsign\s*\(|\bstat\b/.test(ranked[1])
            ? { pass: true, detail: `${ranked[0]} ranks on a signed statistic` }
            : { pass: false, detail: `${ranked[0]} ranks with no sign` };
    };
}

/**
 * An enrichment of CpG hits corrects the bias of the number of CpGs of a gene: a method that models the bias, or the
 * tested CpG count of each gene in a weight or a covariate. A list of the tested genes alone is a background, not a
 * correction.
 */
function probeBiasCorrected(): EvalCase["grade"] {
    const models = /gometh|gsameth|goseq|nullp|bias\.data|prior\.prob/;
    // A weighted null draws random sets with a probability that follows the CpG count.
    const weights = /weight|\bglm\s*\(|logit|logistic|covariate|offset|resampl|permut|match|\.choice\s*\(|\.sample\s*\(/i;
    return (trial) => {
        const enrich = workScript(trial, /gometh|gsameth|enrich\s*\(|enrichGO|enricher|goseq|fisher|hypergeom|fgsea|fold_enrichment|\bglm\s*\(|logit/i);
        if (enrich === undefined) return { pass: false, detail: `no enrichment script (scripts: ${scriptNames(trial)})` };
        const corrects = models.test(enrich[1]) || (/n_cpgs/.test(enrich[1]) && weights.test(enrich[1]));
        return corrects
            ? { pass: true, detail: `${enrich[0]} corrects the CpG-count bias` }
            : { pass: false, detail: `${enrich[0]} ignores the CpG-count bias` };
    };
}

/**
 * A model of an outcome selects its features inside the resampling, or the reply calls the estimate optimistic. A script
 * can read the upstream list to compare with it. The decision is where the selection of the fitted model happens.
 */
function selectionInsideResampling(): EvalCase["grade"] {
    const selector = /SelectKBest|SelectFromModel|SelectPercentile|\bRFE(CV)?\b|VarianceThreshold|Lasso|penalty\s*=\s*["'](l1|elasticnet)["']|l1_ratio/;
    const inside = (trial: Trial): Grade => {
        const fit = workScript(trial, /Pipeline\s*\(|make_pipeline/);
        if (fit === undefined) return { pass: false, detail: `no resampled pipeline (scripts: ${scriptNames(trial)})` };
        return selector.test(fit[1])
            ? { pass: true, detail: `${fit[0]} selects inside the resampling` }
            : { pass: false, detail: `${fit[0]} selects no feature inside the pipeline` };
    };
    return anyOf(inside, says(/optimistic|overestimat|selection bias|leak|biased upward|inflated/i));
}

/** The survival model reads the event from the coding of the data: `correct` holds, and `wrong` does not. */
function eventCoding(correct: RegExp, wrong: RegExp): EvalCase["grade"] {
    return (trial) => {
        const fit = workScript(trial, /CoxPHFitter|KaplanMeierFitter|coxph|survfit|Surv\s*\(|CoxnetSurvival|logrank/);
        if (fit === undefined) return { pass: false, detail: `no survival script (scripts: ${scriptNames(trial)})` };
        if (wrong.test(fit[1]) && !correct.test(fit[1])) return { pass: false, detail: `${fit[0]} takes the censoring flag as the event` };
        return correct.test(fit[1])
            ? { pass: true, detail: `${fit[0]} codes the event from the data` }
            : { pass: false, detail: `${fit[0]} does not show the coding of the event` };
    };
}

/** The association adjusts for ancestry with principal components, and the step reports the inflation. */
function adjustsForAncestry(): EvalCase["grade"] {
    return (trial) => {
        const text = commandsAndScripts(trial);
        if (!/--glm|\bglm\b|\blogit\b|\bols\b|logistic|linear.?regression|lstsq|linregress|regress|statsmodels|\bassoc/i.test(text))
            return { pass: false, detail: "no association test" };
        if (!/--covar|eigenvec|\bPC\d|\bPCA\b|\bpcs\b|prcomp\s*\(|principal component|\bsvd\b|linalg\.svd/i.test(text))
            return { pass: false, detail: "the association has no ancestry components" };
        return /lambda|genomic.?inflation|λ|inflation factor/i.test(`${text}\n${trial.text}`)
            ? { pass: true, detail: "adjusts for ancestry and reports the inflation" }
            : { pass: false, detail: "no inflation reported" };
    };
}

/** A join of two inputs on different builds converts one of them first. */
function alignsBuilds(): EvalCase["grade"] {
    return (trial) => {
        const text = commandsAndScripts(trial);
        if (!/merge\s*\(|\.join\s*\(|join_by|inner_join|left_join|overlap|intersect/i.test(text)) return { pass: false, detail: "no join of the two inputs" };
        return /liftover|liftOver|\.over\.chain|\.chain\b|CrossMap|pyliftover|hg19ToHg38|hg38ToHg19/i.test(text)
            ? { pass: true, detail: "converts the build before the join" }
            : { pass: false, detail: "joins positions of two builds" };
    };
}

/** A command of PLINK runs, and leaves the files that a real run leaves. */
const PLINK_RUN: ExecRule = ({ argv, line }) => {
    if (argv[0] !== "plink2" && argv[0] !== "plink") return undefined;
    const out = /--out\s+(\S+)/.exec(line)?.[1] ?? "plink2";
    const writes: Record<string, string> = {};
    if (line.includes("--pca")) writes[`${out}.eigenvec`] = "#FID\tIID\tPC1\tPC2\nF1\tI1\t0.01\t-0.02\n";
    if (line.includes("--glm"))
        writes[`${out}.PHENO1.glm.logistic.hybrid`] = "#CHROM\tPOS\tID\tREF\tALT\tA1\tOR\tLOG(OR)_SE\tP\n1\t1000\trs1\tA\tG\tG\t1.2\t0.04\t3e-9\n";
    return { exitCode: 0, stdout: "PLINK v2.00a6 64-bit\nEnd time: done", writes };
};

/** A command that reads the inputs: the head of each input, as a script that prints the data gives. */
const READS_INPUTS = /data\/inputs|runs\/run-001|\/mnt\/refs/;
const NAMES_OUTPUT = /(output|figures)\/[\w.-]+\.(csv|tsv|png|pdf|svg)/;

function inputHeads(files: Readonly<Record<string, string>>): string {
    return Object.entries(files)
        .map(([path, text]) => {
            const where = `/${ANALYSIS_ID}/${path}`;
            if (text.startsWith("[binary")) return `==> ${where} <== binary, read it with its library`;
            const lines = text.trimEnd().split("\n");
            return [`==> ${where} <== ${lines.length - 1} rows`, ...lines.slice(0, 4).map((line) => line.slice(0, 240))].join("\n");
        })
        .join("\n\n");
}

/**
 * A run of Python or R. A script that names its outputs leaves them and prints `result`. A script or an inline program
 * that reads the inputs prints their heads, as an exploration of the data does. A real run prints the data, and a
 * fixed line for each run made agents judge the sandbox fake and probe it until their step cap.
 */
function analysisRun(files: Readonly<Record<string, string>>, result: string): ExecRule {
    const finish = namedOutputsRun(result);
    const heads = inputHeads(files);
    return (view) => {
        if (!["python", "python3", "Rscript"].includes(view.argv[0] ?? "") || /^--?(version|V)$/.test(view.argv[1] ?? "")) return undefined;
        const script = /scripts\/\S+\.(py|R)\b/.exec(view.line)?.[0];
        const code = script === undefined ? view.line : (view.read(script) ?? view.read(`${view.cwd}/${script}`));
        if (code === undefined) return undefined;
        if (script !== undefined && NAMES_OUTPUT.test(code)) return finish(view);
        return READS_INPUTS.test(code) ? { exitCode: 0, stdout: heads } : undefined;
    };
}

/** A domain case: a run of Python or R answers with the `result` of the setup, after the rules of the case. */
function domainCase(
    spec: Omit<SandboxCaseSpec, "setup"> & { readonly setup: Omit<SandboxSetup, "agentId" | "stepId"> & { readonly result: string } },
): EvalCase {
    const { result, ...setup } = spec.setup;
    return sandboxCase({ ...spec, setup: { ...setup, exec: [...(setup.exec ?? []), analysisRun(setup.files, result)] } });
}

// ── The generators of the binary inputs of a real trial ──────────────────────
// Each program runs in the sandbox image (`generate` of a setup). A scripted trial reads the stub text in its place.

/** An AnnData file of raw counts: `perReplicate` cells of each replicate, a response of `target` in the first half. */
export function cellsGenerator(spec: {
    readonly path: string;
    readonly replicate: string;
    readonly replicates: readonly string[];
    readonly condition: string;
    readonly levels: readonly [string, string];
    readonly typeColumn: string;
    readonly types: readonly string[];
    readonly target: string;
    readonly perReplicate: number;
    readonly genes: number;
}): string {
    return `
import os
import numpy as np, pandas as pd, anndata as ad, scipy.sparse as sp
rng = np.random.default_rng(11)
reps = ${JSON.stringify(spec.replicates)}
types = ${JSON.stringify(spec.types)}
n_genes = ${spec.genes}
names = ["ISG15", "MX1", "IFI44L", "IFIT1", "IFIT3", "RSAD2", "OAS1", "STAT1"] + [f"GENE{i}" for i in range(8, n_genes)]
profiles = rng.gamma(0.6, 2.0, size=(len(types), n_genes))
rows, blocks = [], []
for r, rep in enumerate(reps):
    level = ${JSON.stringify(spec.levels)}[0 if r < len(reps) // 2 else 1]
    kinds = rng.choice(len(types), size=${spec.perReplicate}, p=np.r_[0.2, np.full(len(types) - 1, 0.8 / (len(types) - 1))])
    mu = profiles[kinds] * rng.lognormal(0, 0.25)
    if level == ${JSON.stringify(spec.levels[0])}:
        hit = kinds == types.index(${JSON.stringify(spec.target)})
        mu[np.ix_(hit, np.arange(20))] *= 3.0
    blocks.append(rng.negative_binomial(2, 2 / (2 + mu)).astype(np.float32))
    rows += [(rep, level, types[k]) for k in kinds]
obs = pd.DataFrame(rows, columns=[${JSON.stringify(spec.replicate)}, ${JSON.stringify(spec.condition)}, ${JSON.stringify(spec.typeColumn)}])
obs.index = [f"cell{i}" for i in range(len(obs))]
adata = ad.AnnData(X=sp.csr_matrix(np.vstack(blocks)), obs=obs.astype("category"), var=pd.DataFrame(index=names))
os.makedirs(os.path.dirname(${JSON.stringify(spec.path)}), exist_ok=True)
adata.write_h5ad(${JSON.stringify(spec.path)})
`;
}

/** FCS 3.0 files of 3000 events, with the channels of `PANEL`. The second half of the samples hold more CD14 cells. */
const FCS_GENERATOR = `
import os
import numpy as np
rng = np.random.default_rng(5)
chans = ["Y89Di","In115Di","Pr141Di","Nd142Di","Nd143Di","Nd144Di","Nd146Di","Sm147Di","Nd148Di","Sm149Di","Nd150Di","Eu151Di","Sm152Di","Ir191Di"]
ants = ["CD45","CD3","CD4","CD8a","CD19","CD14","CD16","CD56","pSTAT1","pSTAT3","Ki-67","pERK","Granzyme B","DNA1"]
pops = {"CD4T": [1,2], "CD8T": [1,3], "B": [4], "Mono": [5], "NK": [6,7]}
def write_fcs(path, data):
    n, p = data.shape
    kw = {"$BYTEORD": "1,2,3,4", "$DATATYPE": "F", "$MODE": "L", "$NEXTDATA": "0", "$PAR": str(p), "$TOT": str(n)}
    for i in range(p):
        kw[f"$P{i+1}N"], kw[f"$P{i+1}S"], kw[f"$P{i+1}B"], kw[f"$P{i+1}E"], kw[f"$P{i+1}R"] = chans[i], ants[i], "32", "0,0", "262144"
    body = data.astype("<f4").tobytes()
    begin = end = 0
    for _ in range(6):
        full = dict(kw, **{"$BEGINANALYSIS": "0", "$ENDANALYSIS": "0", "$BEGINSTEXT": "0", "$ENDSTEXT": "0", "$BEGINDATA": str(begin), "$ENDDATA": str(end)})
        text = "|" + "|".join(f"{k}|{v}" for k, v in full.items()) + "|"
        text_end = 58 + len(text) - 1
        begin, end = text_end + 1, text_end + len(body)
    header = "FCS3.0    " + "".join(f"{v:>8}" for v in [58, text_end, begin, end, 0, 0])
    with open(path, "wb") as f:
        f.write(header.encode() + text.encode() + body)
os.makedirs("data/inputs/f-cytof", exist_ok=True)
for s in range(8):
    shares = np.array([0.3, 0.2, 0.15, 0.2 if s < 4 else 0.35, 0.15]); shares /= shares.sum()
    kinds = rng.choice(len(pops), size=3000, p=shares)
    level = rng.normal(0.3, 0.3, size=(3000, len(chans)))
    level[:, 0] += 3.5
    level[:, 13] += 4.0
    for k, (name, marks) in enumerate(pops.items()):
        for m in marks:
            level[kinds == k, m] += 3.0
    level[:, 8:13] += rng.normal(1.0, 0.6, size=(3000, 5))
    write_fcs(f"data/inputs/f-cytof/sample_{s+1}.fcs", 5 * np.sinh(np.clip(level, 0, None)))
`;

/** A bgzipped, indexed VCF of two ancestries and its phenotype. `trait` is a case status or a quantitative level. */
function genotypeGenerator(trait: "binary" | "quantitative"): string {
    return `
import os, subprocess
import numpy as np
rng = np.random.default_rng(3)
n, m = 600, 3000
pop = np.r_[np.zeros(n // 2, int), np.ones(n // 2, int)]
base = rng.uniform(0.05, 0.5, m)
freq = np.clip(np.c_[base, base + rng.normal(0, 0.12, m)], 0.02, 0.98)
g = rng.binomial(2, freq[np.arange(m)[None, :], pop[:, None]])
causal = [100, 900, 1700, 2500]
score = g[:, causal].sum(axis=1) * 0.45 + pop * 1.2 + rng.normal(0, 1, n)
os.makedirs("data/inputs/f-geno", exist_ok=True)
ids = [f"I{i}" for i in range(n)]
code = {0: "0/0", 1: "0/1", 2: "1/1"}
with open("data/inputs/f-geno/cohort.vcf", "w") as f:
    f.write("##fileformat=VCFv4.2\\n##reference=GRCh38\\n")
    for c in range(1, 23):
        f.write(f"##contig=<ID=chr{c}>\\n")
    f.write('##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">\\n')
    f.write("#CHROM\\tPOS\\tID\\tREF\\tALT\\tQUAL\\tFILTER\\tINFO\\tFORMAT\\t" + "\\t".join(ids) + "\\n")
    for j in sorted(range(m), key=lambda j: (j % 22, j)):
        f.write(f"chr{j % 22 + 1}\\t{1_000_000 + j * 9_973}\\trs{100000 + j}\\tA\\tG\\t.\\tPASS\\t.\\tGT\\t" + "\\t".join(code[x] for x in g[:, j]) + "\\n")
subprocess.run(["bgzip", "-f", "data/inputs/f-geno/cohort.vcf"], check=True)
subprocess.run(["tabix", "-p", "vcf", "data/inputs/f-geno/cohort.vcf.gz"], check=True)
${trait === "binary" ? "pheno = np.where(score > np.quantile(score, 0.52), 2, 1)" : "pheno = np.round(110 + 25 * score, 1)"}
with open("data/inputs/f-geno/pheno.txt", "w") as f:
    f.write("FID\\tIID\\tPHENO1\\n" + "".join(f"F{i}\\t{iid}\\t{v}\\n" for i, (iid, v) in enumerate(zip(ids, pheno))))
`;
}

const MATRIX_GOAL = "Find what differs between the groups of the study.";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PROTEINS = 300;

function intensityTable(
    samples: readonly string[],
    scale: (i: number, j: number) => number,
    header: readonly string[],
    idOf: (i: number) => readonly string[],
): string {
    return table(
        [...header, ...samples],
        Array.from({ length: PROTEINS }, (_, i) => [...idOf(i), ...samples.map((_, j) => scale(i, j))]),
        "\t",
    );
}

const LFQ_SAMPLES = ["KO1", "KO2", "KO3", "KO4", "WT1", "WT2", "WT3", "WT4"];
const LFQ = intensityTable(
    LFQ_SAMPLES,
    (i, j) => (unit(i, j) < 0.04 ? "NaN" : Math.round(1e7 * (1 + 40 * unit(i, 0)) * (j < 4 && i < 30 ? 2.5 : 1) * (0.85 + 0.3 * unit(i, j)))) as number,
    ["protein_id", "gene"],
    (i) => [`P${String(10_000 + i)}`, `PROT${i}`],
);
const LFQ_SAMPLE_SHEET = table(
    ["sample", "genotype", "run_day"],
    LFQ_SAMPLES.map((s, j) => [s, s.startsWith("KO") ? "knockout" : "wildtype", j % 2 === 0 ? "day1" : "day2"]),
);

const TPM_SAMPLES = ["D1", "D2", "D3", "V1", "V2", "V3"];
const TPM = intensityTable(
    TPM_SAMPLES,
    (i, j) => Number(((1 + 200 * unit(i, 0)) * (j < 3 && i < 25 ? 3 : 1) * (0.9 + 0.2 * unit(i, j))).toFixed(2)),
    ["gene_id", "symbol"],
    (i) => [`ENSG${String(20_000 + i).padStart(11, "0")}`, `GENE${i}`],
);
const TPM_SAMPLE_SHEET = table(
    ["sample", "arm"],
    TPM_SAMPLES.map((s) => [s, s.startsWith("D") ? "drug" : "vehicle"]),
);

const ONE_VS_ONE_COUNTS = table(
    ["gene_id", "symbol", "treated", "control"],
    Array.from({ length: PROTEINS }, (_, i) => [
        `ENSG${String(30_000 + i).padStart(11, "0")}`,
        `GENE${i}`,
        Math.round(40 + 900 * unit(i, 0) * (i < 20 ? 3 : 1)),
        Math.round(40 + 900 * unit(i, 0)),
    ]),
    "\t",
);

const PEAKS_POOLED = table(
    ["feature_id", "mz", "rt_min", "fasted_pool", "fed_pool"],
    Array.from({ length: PROTEINS }, (_, i) => [
        `M${i}`,
        (100 + 700 * unit(i, 1)).toFixed(4),
        (0.5 + 14 * unit(i, 2)).toFixed(2),
        Math.round(5e4 + 5e6 * unit(i, 0)),
        Math.round((5e4 + 5e6 * unit(i, 0)) * (i < 15 ? 0.3 : 1)),
    ]),
);

const CPGS = 300;
function betaTable(samples: readonly string[], prefix: string): string {
    return table(
        ["cpg_id", ...samples],
        Array.from({ length: CPGS }, (_, i) => [
            `cg${String(10_000_000 + i * 37).padStart(8, "0")}`,
            ...samples.map((_, j) =>
                Math.min(0.99, Math.max(0.01, unit(i, 0) * (j < samples.length / 2 && i < 20 ? 0.5 : 1) + 0.04 * (unit(i, j) - 0.5))).toFixed(3),
            ),
        ]),
    ).replace("cpg_id", prefix);
}
const EPIC_SAMPLES = ["T1", "T2", "T3", "T4", "N1", "N2", "N3", "N4"];
const EPIC_BETAS = betaTable(EPIC_SAMPLES, "cpg_id");
const EPIC_SHEET = table(
    ["sample", "tissue", "patient"],
    EPIC_SAMPLES.map((s, j) => [s, s.startsWith("T") ? "tumor" : "normal", `pt${(j % 4) + 1}`]),
);
const K450_SAMPLES = ["A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3", "B4", "B5"];
const K450_BETAS = betaTable(K450_SAMPLES, "probe");
const K450_SHEET = table(
    ["sample", "exposure"],
    K450_SAMPLES.map((s) => [s, s.startsWith("A") ? "smoker" : "never_smoker"]),
);

const BATCH_COUNTS = table(
    ["gene_id", "symbol", "T1", "T2", "T3", "T4", "C1", "C2", "C3", "C4"],
    Array.from({ length: PROTEINS }, (_, i) => [
        `ENSG${String(40_000 + i).padStart(11, "0")}`,
        `GENE${i}`,
        ...Array.from({ length: 8 }, (_, j) =>
            Math.round((40 + 900 * unit(i, 0)) * (j < 4 && i < 25 ? 3 : 1) * (j % 2 === 0 ? 1.6 : 1) * (0.9 + 0.2 * unit(i, j))),
        ),
    ]),
    "\t",
);
const BATCH_SHEET = table(
    ["sample", "group", "batch"],
    ["T1", "T2", "T3", "T4", "C1", "C2", "C3", "C4"].map((s, j) => [s, s.startsWith("T") ? "treated" : "control", j % 2 === 0 ? "b1" : "b2"]),
);

const NPX_LONG = table(
    ["SampleID", "Assay", "UniProt", "OlinkID", "NPX", "LOD", "PlateID"],
    Array.from({ length: 12 }, (_, s) =>
        Array.from({ length: 92 }, (_, a) => [
            `S${s + 1}`,
            `ASSAY${a}`,
            `Q${10_000 + a}`,
            `OID${20_000 + a}`,
            (2 + 8 * unit(a, 0) + (s < 6 && a < 8 ? 1.2 : 0) + 0.3 * (unit(a, s) - 0.5)).toFixed(3),
            (1 + unit(a, 3)).toFixed(3),
            "Plate1",
        ]),
    ).flat(),
);
const NPX_SHEET = table(
    ["SampleID", "status"],
    Array.from({ length: 12 }, (_, s) => [`S${s + 1}`, s < 6 ? "case" : "control"]),
);

const SOMA_SAMPLES = Array.from({ length: 10 }, (_, s) => `SOMA${s + 1}`);
const SOMA = intensityTable(
    SOMA_SAMPLES,
    (i, j) => Number((800 + 20_000 * unit(i, 0) * (j < 5 && i < 20 ? 1.8 : 1) * (0.9 + 0.2 * unit(i, j))).toFixed(1)),
    ["SeqId", "Target"],
    (i) => [`${10_000 + i}-1`, `TARGET${i}`],
);
const SOMA_SHEET = table(
    ["sample", "arm"],
    SOMA_SAMPLES.map((s, j) => [s, j < 5 ? "statin" : "placebo"]),
);

const H5AD_STUB = "[binary HDF5 content of an AnnData file]\n";

const PANEL = table(
    ["fcs_colname", "antigen", "marker_class"],
    [
        ["Y89Di", "CD45", "type"],
        ["In115Di", "CD3", "type"],
        ["Pr141Di", "CD4", "type"],
        ["Nd142Di", "CD8a", "type"],
        ["Nd143Di", "CD19", "type"],
        ["Nd144Di", "CD14", "type"],
        ["Nd146Di", "CD16", "type"],
        ["Sm147Di", "CD56", "type"],
        ["Nd148Di", "pSTAT1", "state"],
        ["Sm149Di", "pSTAT3", "state"],
        ["Nd150Di", "Ki-67", "state"],
        ["Eu151Di", "pERK", "state"],
        ["Sm152Di", "Granzyme B", "state"],
        ["Ir191Di", "DNA1", "none"],
    ],
);
const PANEL_FUNCTIONAL = PANEL.replace("marker_class", "marker_type").replaceAll(",type\n", ",lineage\n").replaceAll(",state\n", ",functional\n");
const CYTOF_META = table(
    ["file_name", "sample_id", "condition", "patient_id"],
    Array.from({ length: 8 }, (_, s) => [`sample_${s + 1}.fcs`, `s${s + 1}`, s < 4 ? "responder" : "non_responder", `p${s + 1}`]),
);

const EXPRESSION_SAMPLES = 80;
function isResponder(sample: number): boolean {
    return unit(sample, 9) < 0.4;
}

const EXPRESSION = table(
    ["sample", ...Array.from({ length: 200 }, (_, g) => `GENE${g}`)],
    // The 25 genes of the upstream list (each seventh gene) are higher in the responders, as the upstream summary says.
    Array.from({ length: EXPRESSION_SAMPLES }, (_, s) => [
        `S${s + 1}`,
        ...Array.from({ length: 200 }, (_, g) => (4 + 6 * unit(g, s) + (g % 7 === 0 && g < 175 && isResponder(s) ? 1.5 : 0)).toFixed(2)),
    ]),
);
const RESPONSE = table(
    ["sample", "response"],
    Array.from({ length: EXPRESSION_SAMPLES }, (_, s) => [`S${s + 1}`, isResponder(s) ? "responder" : "non_responder"]),
);
const DE_LIST = table(
    ["gene", "log2_fold_change", "pvalue", "adjusted_pvalue"],
    Array.from({ length: 25 }, (_, g) => [`GENE${g * 7}`, (1 + unit(g, 1)).toFixed(2), (1e-6 * (g + 1)).toPrecision(2), (1e-4 * (g + 1)).toPrecision(2)]),
);

function modelHandoff(stepId: string, table: string, summary: string): UpstreamHandoff {
    const dir = `${ROOT}/runs/run-001/${stepId}`;
    return {
        stepId,
        agentId: "analyst",
        summaryMarkdown: summary,
        summaryPath: `${dir}/output/summary.md`,
        outputDir: `${dir}/output`,
        artifacts: [`${dir}/output/${table}`],
    };
}

const SURVIVAL_CENSORED = table(
    ["patient_id", "os_months", "censored", "stage", "age"],
    Array.from({ length: 120 }, (_, p) => [
        `P${p + 1}`,
        (2 + 80 * unit(p, 1)).toFixed(1),
        unit(p, 2) < 0.45 ? 1 : 0,
        ["I", "II", "III", "IV"][p % 4] ?? "I",
        Math.round(40 + 40 * unit(p, 3)),
    ]),
);
const DICTIONARY_CENSORED =
    "Data dictionary of clinical.csv\n\n- os_months: months from diagnosis to death or to the last follow-up\n- censored: 1 if the patient was alive at the last follow-up, 0 if the patient died\n- stage: AJCC stage at diagnosis\n- age: age at diagnosis, in years\n";
const SURVIVAL_STATUS = table(
    ["id", "time_days", "status", "grade", "sex"],
    Array.from({ length: 150 }, (_, p) => [`R${p + 1}`, Math.round(30 + 2500 * unit(p, 1)), unit(p, 2) < 0.5 ? 2 : 1, (p % 3) + 1, p % 2 === 0 ? "F" : "M"]),
);
const DICTIONARY_STATUS =
    "Codebook of cohort.tsv\n\ntime_days: days from enrollment to relapse or to the last visit\nstatus: 1 = no relapse at the last visit, 2 = relapse\ngrade: tumor grade, 1 to 3\nsex: F or M\n";

const PHENO = table(
    ["FID", "IID", "PHENO1"],
    Array.from({ length: 40 }, (_, s) => [`F${s}`, `I${s}`, s % 2 === 0 ? 2 : 1]),
    "\t",
);
const GENO_STUB = "[binary genotype content]\n";

/** Real HGNC symbols, thus a gene list reads as genes. */
const GENE_SYMBOLS = [
    "ACTB",
    "ADAM10",
    "ADM",
    "AKT1",
    "ALDOA",
    "ANGPTL4",
    "APC",
    "APOE",
    "AR",
    "ARNT",
    "ATF4",
    "ATM",
    "AXL",
    "BAX",
    "BCL2",
    "BDNF",
    "BHLHE40",
    "BNIP3",
    "BRCA1",
    "BRCA2",
    "CA9",
    "CACNA1A",
    "CAMK2A",
    "CASP3",
    "CAV1",
    "CCND1",
    "CD44",
    "CDH1",
    "CDH2",
    "CDK4",
    "CDKN1A",
    "CDKN2A",
    "CHD7",
    "CITED2",
    "CLOCK",
    "CNTNAP2",
    "CREB1",
    "CTNNB1",
    "CXCL12",
    "CXCR4",
    "DCC",
    "DDIT4",
    "DLG4",
    "DLL1",
    "DNMT1",
    "DNMT3A",
    "E2F1",
    "EGFR",
    "EGLN1",
    "EGLN3",
    "ELK1",
    "ENO1",
    "EP300",
    "EPAS1",
    "ERBB2",
    "ERRFI1",
    "ESR1",
    "ETS1",
    "EZH2",
    "FGF2",
    "FLT1",
    "FOS",
    "FOXA1",
    "FOXO1",
    "FOXP2",
    "GABRA1",
    "GAD1",
    "GAPDH",
    "GATA3",
    "GLI1",
    "GLS",
    "GLUL",
    "GRIA1",
    "GRIN1",
    "GRIN2B",
    "GSK3B",
    "HDAC1",
    "HES1",
    "HEY1",
    "HIF1A",
    "HK2",
    "HMOX1",
    "HOXA9",
    "HRAS",
    "IGF1R",
    "IGFBP3",
    "IL6",
    "INSR",
    "JAK2",
    "JUN",
    "KDM5A",
    "KDR",
    "KLF4",
    "KMT2A",
    "KRAS",
    "LDHA",
    "LEP",
    "LOX",
    "MAPK1",
    "MAPK3",
    "MDM2",
    "MECP2",
    "MET",
    "MKI67",
    "MMP2",
    "MMP9",
    "MTOR",
    "MYC",
    "NANOG",
    "NCAM1",
    "NEUROD1",
    "NFKB1",
    "NGF",
    "NLGN1",
    "NOS3",
    "NOTCH1",
    "NRXN1",
    "NTRK2",
    "P4HA1",
    "PAX6",
    "PDGFRA",
    "PDK1",
    "PFKFB3",
    "PGK1",
    "PIK3CA",
    "PKM",
    "PLAU",
    "PML",
    "POU5F1",
    "PPARG",
    "PRKCA",
    "PTEN",
    "PTGS2",
    "RAC1",
    "RAF1",
    "RARA",
    "RB1",
    "RELN",
    "RET",
    "RHOA",
    "RUNX1",
    "SCN1A",
    "SCN2A",
    "SERPINE1",
    "SHANK3",
    "SIRT1",
    "SLC2A1",
    "SLC2A3",
    "SMAD2",
    "SMAD3",
    "SMAD4",
    "SNAP25",
    "SOD2",
    "SOX2",
    "SOX9",
    "SP1",
    "SRC",
    "STAT3",
    "SYN1",
    "SYP",
    "SYT1",
    "TCF4",
    "TERT",
    "TET2",
    "TGFB1",
    "TGFBR2",
    "THBS1",
    "TNF",
    "TP53",
    "TWIST1",
    "TXNIP",
    "VEGFA",
    "VHL",
    "VIM",
    "WNT1",
    "WNT5A",
    "WT1",
    "XIAP",
    "YAP1",
    "ZEB1",
    "ABCB1",
    "ACACA",
    "ADRB2",
    "AHR",
    "ALB",
    "ANXA1",
    "AQP4",
    "ARG1",
    "ASCL1",
    "BACE1",
    "BMP2",
    "BMP4",
    "CALB1",
    "CCL2",
    "CD4",
    "CD8A",
    "CEBPA",
    "CHAT",
    "CNR1",
    "COL1A1",
    "CRH",
    "CRP",
    "CSF1R",
    "CTSD",
    "CYP1A1",
    "DBH",
    "DRD2",
    "EDN1",
    "ELN",
    "EPO",
    "FASN",
    "FN1",
    "GDNF",
    "GFAP",
    "GH1",
    "HTR2A",
    "ICAM1",
    "IFNG",
    "IL1B",
    "INS",
];

/** The positions of the fixtures move by this offset from GRCh37 to GRCh38. */
const BUILD_OFFSET = 4_211;

const SUMSTATS_37 = table(
    ["CHR", "BP", "A1", "A2", "BETA", "SE", "P"],
    Array.from({ length: 120 }, (_, v) => [
        (v % 22) + 1,
        1_000_000 + v * 12_345,
        "A",
        "G",
        (0.1 * (unit(v, 1) - 0.5)).toFixed(4),
        "0.01",
        (v < 6 ? 1e-9 * (v + 1) : unit(v, 2)).toPrecision(3),
    ]),
    "\t",
);
const EQTL_38 = table(
    ["variant_chr", "variant_pos", "ref", "alt", "gene_symbol", "slope", "pval_nominal"],
    Array.from({ length: 120 }, (_, v) => [
        `chr${(v % 22) + 1}`,
        1_000_000 + v * 12_345 + BUILD_OFFSET,
        "A",
        "G",
        GENE_SYMBOLS[v] ?? `GENE${v}`,
        (unit(v, 3) - 0.5).toFixed(3),
        (1e-7 * (v + 1)).toPrecision(3),
    ]),
    "\t",
);

const CHAIN_37_TO_38 = "- /mnt/refs/liftover/hg19ToHg38.over.chain (UCSC liftOver chain, GRCh37 to GRCh38) — chain file";
const CHAIN_38_TO_37 = "- /mnt/refs/liftover/hg38ToHg19.over.chain (UCSC liftOver chain, GRCh38 to GRCh37) — chain file";

/** `text` with `offset` added to each value of the numeric column `name`. */
function shiftColumn(text: string, name: string, offset: number): string {
    const [header = "", ...rows] = text.trimEnd().split("\n");
    const at = header.split("\t").indexOf(name);
    return `${[
        header,
        ...rows.map((row) =>
            row
                .split("\t")
                .map((cell, i) => (i === at ? String(Number(cell) + offset) : cell))
                .join("\t"),
        ),
    ].join("\n")}\n`;
}

/** A UCSC chain of one ungapped block for each autosome, which moves each position by `offset`. */
function chainOf(offset: number): string {
    const length = 100_000_000;
    const size = 250_000_000;
    return Array.from({ length: 22 }, (_, c) => {
        const from = offset >= 0 ? 0 : -offset;
        const to = offset >= 0 ? offset : 0;
        return `chain 1000 chr${c + 1} ${size} + ${from} ${from + length} chr${c + 1} ${size} + ${to} ${to + length} ${c + 1}\n${length}\n`;
    }).join("\n");
}
const GO_BP = "- /mnt/refs/go/c5.go.bp.v2024.1.Hs.symbols.gmt (MSigDB GO biological process 2024.1, gene-sets, Homo sapiens) — GMT of human gene symbols";
const GENETIC_REFS = { ...REF_FILES, "liftover/hg19ToHg38.over.chain": chainOf(BUILD_OFFSET), "liftover/hg38ToHg19.over.chain": chainOf(-BUILD_OFFSET) };

/** The number of CpGs that the sequencing covered in each gene. Each fifth gene is long and CpG-rich. */
function cpgsOf(i: number): number {
    return i % 5 === 0 ? 80 + Math.round(40 * unit(i, 7)) : 3 + Math.round(27 * unit(i, 7));
}

/** The genes with a site that changes: more often a CpG-rich gene, and each gene of the true program (190-219). */
const HIT_GENES = GENE_SYMBOLS.map((gene, i) => ({ gene, i })).filter(({ i }) => (i >= 190 && i < 220 ? unit(i, 8) < 0.6 : unit(i, 8) < cpgsOf(i) / 220));

const DMP_TABLE = table(
    ["site_id", "gene", "delta_methylation", "pvalue", "adjusted_pvalue"],
    HIT_GENES.flatMap(({ gene, i }, k) =>
        Array.from({ length: 1 + (i % 3) }, (_, j) => [
            `chr${(i % 22) + 1}:${2_000_000 + i * 7_919 + j * 37}`,
            gene,
            (-0.3 + 0.6 * unit(i, j)).toFixed(3),
            (1e-7 * (k + 1)).toPrecision(2),
            (1e-4 * (k + 1)).toPrecision(2),
        ]),
    ),
);

const TESTED_PER_GENE = table(
    ["gene", "n_cpgs_tested"],
    GENE_SYMBOLS.map((gene, i) => [gene, cpgsOf(i)]),
);

/** GO sets of the gene symbols: a set of CpG-rich genes that a naive test finds, the true program, and other sets. */
const GO_SETS: readonly (readonly [string, readonly string[]])[] = [
    ["GOBP_SYNAPTIC_SIGNALING", GENE_SYMBOLS.filter((_, i) => i % 5 === 0).slice(0, 36)],
    ["GOBP_RESPONSE_TO_HYPOXIA", GENE_SYMBOLS.slice(190, 220)],
    ...[
        "GOBP_CELL_CYCLE_PROCESS",
        "GOBP_REGULATION_OF_APOPTOTIC_PROCESS",
        "GOBP_ANGIOGENESIS",
        "GOBP_INFLAMMATORY_RESPONSE",
        "GOBP_WNT_SIGNALING_PATHWAY",
        "GOBP_GLUCOSE_METABOLIC_PROCESS",
        "GOBP_EPITHELIAL_TO_MESENCHYMAL_TRANSITION",
        "GOBP_RESPONSE_TO_GROWTH_FACTOR",
        "GOBP_CHROMATIN_ORGANIZATION",
        "GOBP_CELL_MIGRATION",
    ].map((name, k): [string, string[]] => [name, GENE_SYMBOLS.filter((_, i) => (i * 7 + k * 13) % 11 === 0).slice(0, 25)]),
];
const GO_GMT = `${GO_SETS.map(([name, genes]) => [name, "http://www.gsea-msigdb.org", ...genes].join("\t")).join("\n")}\n`;

function dmpHandoff(stepId: string, assay: string): UpstreamHandoff {
    const dir = `${ROOT}/runs/run-001/${stepId}`;
    return {
        stepId,
        agentId: "analyst",
        summaryMarkdown: `# Differential methylation\n\nDSS on the CpG sites of the ${assay} data, after a coverage filter of 10 reads. The sites at FDR < 0.05 are in \`output/dmp_results.csv\`, with site_id, gene, delta_methylation, pvalue, and adjusted_pvalue. \`output/tested_cpgs_per_gene.csv\` gives the number of CpGs tested in each of the ${GENE_SYMBOLS.length} genes with coverage.\n`,
        summaryPath: `${dir}/output/summary.md`,
        outputDir: `${dir}/output`,
        artifacts: [`${dir}/output/dmp_results.csv`, `${dir}/output/tested_cpgs_per_gene.csv`],
    };
}

function dmpFiles(stepId: string): Readonly<Record<string, string>> {
    return {
        [`runs/run-001/${stepId}/output/dmp_results.csv`]: DMP_TABLE,
        [`runs/run-001/${stepId}/output/tested_cpgs_per_gene.csv`]: TESTED_PER_GENE,
        [`runs/run-001/${stepId}/output/summary.md`]: "# Differential methylation\n",
    };
}

// ── Steps ─────────────────────────────────────────────────────────────────────

const MAX_STEPS = 40;
const TIMEOUT = 3_600_000;

function step(spec: Omit<StepSpec, "stepId"> & { readonly stepId?: string }): StepSpec {
    return { stepId: "T1S1", goal: MATRIX_GOAL, ...spec };
}

export const domainCases: readonly EvalCase[] = [
    // The scale decides the family: continuous values take a linear model.
    domainCase({
        id: "domain-intensities-linear-model",
        set: "dev",
        source: "matrix stance: the scale decides the family; proteomics prompt anti-pattern 'DESeq2 on protein intensities'",
        step: step({
            agent: "analyst",
            name: "Differential abundance",
            question: "Which proteins differ in abundance between the knockout and the wild-type cells?",
            acceptance: ["A table of each protein with log2 fold change and adjusted p-value", "A volcano plot"],
            profile: profile({
                summary: "Label-free quantification of 8 cell lines, 300 protein groups, knockout against wild-type.",
                domain: "proteomics",
                subtype: "label-free DDA",
                organism: HUMAN,
                condition: "knockout vs wildtype",
                design: "Two genotypes, four biological replicates each, measured on two days.",
                files: [
                    file(
                        "data/inputs/f-prot/protein_intensities.tsv",
                        "MaxQuant LFQ intensities of the protein groups, with NaN for an undetected protein",
                        "protein-intensity-matrix",
                        "TSV",
                        PROTEINS,
                        10,
                    ),
                    file("data/inputs/f-meta/samples.csv", "Sample sheet: sample, genotype, run_day", "clinical-metadata", "CSV", 8, 3),
                ],
            }),
        }),
        setup: {
            files: { "data/inputs/f-prot/protein_intensities.tsv": LFQ, "data/inputs/f-meta/samples.csv": LFQ_SAMPLE_SHEET },
            packages: MATRIX_LOCK,
            result: "30 proteins at adjusted p < 0.05",
        },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: linearNotCount(),
    }),
    domainCase({
        id: "domain-intensities-linear-model-held-out",
        set: "held-out",
        source: "paraphrase of domain-intensities-linear-model: a TPM matrix of bulk RNA-seq",
        step: step({
            agent: "analyst",
            name: "Drug response",
            question: "Compare the drug arm with the vehicle arm gene by gene.",
            acceptance: ["Fold changes and adjusted p-values for each gene"],
            profile: profile({
                summary: "Bulk RNA-seq expression of 6 organoid cultures, 300 genes, delivered by the sequencing core as transcripts per million.",
                domain: "transcriptomics",
                subtype: "bulk-rna-seq",
                organism: HUMAN,
                condition: "drug vs vehicle",
                design: "Two arms, three cultures each.",
                files: [
                    file(
                        "data/inputs/f-expr/expression_tpm.tsv",
                        "Gene-level TPM values from salmon, aggregated by tximport; no counts were delivered",
                        "expression-matrix",
                        "TSV",
                        PROTEINS,
                        8,
                    ),
                    file("data/inputs/f-meta/samples.csv", "Sample sheet: sample, arm", "clinical-metadata", "CSV", 6, 2),
                ],
            }),
        }),
        setup: {
            files: { "data/inputs/f-expr/expression_tpm.tsv": TPM, "data/inputs/f-meta/samples.csv": TPM_SAMPLE_SHEET },
            packages: MATRIX_LOCK,
            result: "25 genes at adjusted p < 0.05",
        },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: linearNotCount(),
    }),

    // The replicates limit the claim: one sample in each group gives effect sizes, no p-value.
    domainCase({
        id: "domain-no-replicate-descriptive",
        set: "dev",
        source: "matrix stance: the replicates limit the claim; bulk prompt 'no inferential DE for 1 vs 1'",
        step: step({
            agent: "analyst",
            name: "Treatment response",
            question: "Which genes change between the treated culture and the control culture?",
            acceptance: ["A table of the genes that change, with their fold change"],
            profile: profile({
                summary: "Bulk RNA-seq raw counts of 2 cultures, one treated and one control.",
                domain: "transcriptomics",
                subtype: "bulk-rna-seq",
                organism: HUMAN,
                condition: "treated vs control",
                design: "One treated culture and one control culture. No replicate.",
                files: [
                    file("data/inputs/f-counts/counts.tsv", "Raw gene-level counts: gene_id, symbol, treated, control", "count-matrix", "TSV", PROTEINS, 4),
                ],
            }),
        }),
        setup: {
            files: { "data/inputs/f-counts/counts.tsv": ONE_VS_ONE_COUNTS },
            packages: MATRIX_LOCK,
            result: "20 genes above a 2-fold change",
        },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: descriptiveOnly(),
    }),
    domainCase({
        id: "domain-no-replicate-descriptive-held-out",
        set: "held-out",
        source: "paraphrase of domain-no-replicate-descriptive: one pooled metabolomics sample in each condition",
        step: step({
            agent: "analyst",
            name: "Fasting effect",
            question: "Find the metabolite features that differ between the fasted and the fed state.",
            acceptance: ["A table of the features that differ"],
            profile: profile({
                summary: "LC-MS feature table of two pooled plasma samples: one pool of fasted mice, one pool of fed mice.",
                domain: "metabolomics",
                subtype: "untargeted LC-MS",
                organism: MOUSE,
                condition: "fasted vs fed",
                design: "One pooled sample for each state. The pools mix the plasma of the animals.",
                files: [
                    file(
                        "data/inputs/f-ms/feature_table.csv",
                        "Gap-filled, PQN-normalized feature intensities: feature_id, mz, rt_min, fasted_pool, fed_pool",
                        "feature-table",
                        "CSV",
                        PROTEINS,
                        5,
                    ),
                ],
            }),
        }),
        setup: {
            files: { "data/inputs/f-ms/feature_table.csv": PEAKS_POOLED },
            packages: MATRIX_LOCK,
            result: "15 features above a 2-fold change",
        },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: descriptiveOnly(),
    }),

    // A proportion is tested on the logit scale.
    domainCase({
        id: "domain-beta-logit",
        set: "dev",
        source: "matrix stance: a proportion takes the logit scale for the test; methylation prompt 'statistics on beta-values'",
        step: step({
            agent: "analyst",
            name: "Differential methylation",
            question: "Which CpGs are differentially methylated between the tumor and the normal tissue?",
            acceptance: ["A table of the CpGs with the methylation difference and the adjusted p-value"],
            profile: profile({
                summary: "EPIC array beta values of 4 tumor and 4 matched normal samples, 300 CpGs after the filters.",
                domain: "epigenomics",
                subtype: "methylation-array",
                organism: HUMAN,
                condition: "tumor vs normal",
                design: "Four patients, each with one tumor and one normal sample.",
                files: [
                    file(
                        "data/inputs/f-meth/betas.csv",
                        "Beta values after the filters of the core: cpg_id, then one column for each sample",
                        "methylation-matrix",
                        "CSV",
                        CPGS,
                        9,
                    ),
                    file("data/inputs/f-meta/samples.csv", "Sample sheet: sample, tissue, patient", "clinical-metadata", "CSV", 8, 3),
                ],
            }),
        }),
        setup: {
            files: { "data/inputs/f-meth/betas.csv": EPIC_BETAS, "data/inputs/f-meta/samples.csv": EPIC_SHEET },
            packages: MATRIX_LOCK,
            result: "20 CpGs at adjusted p < 0.05",
        },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: testsOnLogit(),
    }),
    domainCase({
        id: "domain-beta-logit-held-out",
        set: "held-out",
        source: "paraphrase of domain-beta-logit: 450K blood samples by smoking",
        step: step({
            agent: "analyst",
            name: "Smoking-associated methylation",
            question: "Test each probe for a methylation difference between the smokers and the never-smokers.",
            acceptance: ["The difference of each probe and its adjusted p-value"],
            profile: profile({
                summary: "450K methylation levels of 10 saliva samples, 300 probes.",
                domain: "epigenomics",
                subtype: "methylation-array",
                organism: HUMAN,
                condition: "smoker vs never smoker",
                design: "Five smokers and five never-smokers.",
                files: [
                    file(
                        "data/inputs/f-meth/methylation_levels.csv",
                        "Methylation level (0 to 1) of each probe in each sample",
                        "methylation-matrix",
                        "CSV",
                        CPGS,
                        11,
                    ),
                    file("data/inputs/f-meta/samples.csv", "Sample sheet: sample, exposure", "clinical-metadata", "CSV", 10, 2),
                ],
            }),
        }),
        setup: {
            files: { "data/inputs/f-meth/methylation_levels.csv": K450_BETAS, "data/inputs/f-meta/samples.csv": K450_SHEET },
            packages: MATRIX_LOCK,
            result: "18 probes at adjusted p < 0.05",
        },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: testsOnLogit(),
    }),

    // A known batch is a term of the design.
    domainCase({
        id: "domain-batch-in-design",
        set: "dev",
        source: "matrix stance: keep a known batch as a term of the design; bulk prompt 'skipping batch assessment'",
        step: step({
            agent: "analyst",
            name: "Differential expression",
            question: "Which genes change between the treated and the control samples?",
            acceptance: ["A table of each gene with log2 fold change and adjusted p-value"],
            profile: profile({
                summary: "Bulk RNA-seq raw counts of 8 samples, 300 genes. The libraries were prepared in two batches.",
                domain: "transcriptomics",
                subtype: "bulk-rna-seq",
                organism: HUMAN,
                condition: "treated vs control",
                design: "Four treated and four control samples. Each batch holds two samples of each group.",
                files: [
                    file("data/inputs/f-counts/counts.tsv", "Raw gene-level counts", "count-matrix", "TSV", PROTEINS, 10),
                    file("data/inputs/f-meta/samples.csv", "Sample sheet: sample, group, batch", "clinical-metadata", "CSV", 8, 3),
                ],
            }),
        }),
        setup: {
            files: { "data/inputs/f-counts/counts.tsv": BATCH_COUNTS, "data/inputs/f-meta/samples.csv": BATCH_SHEET },
            packages: MATRIX_LOCK,
            result: "25 genes at padj < 0.05",
        },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: batchInModel("batch"),
    }),
    domainCase({
        id: "domain-batch-in-design-held-out",
        set: "held-out",
        source: "paraphrase of domain-batch-in-design: proteomics measured on two days",
        step: step({
            agent: "analyst",
            name: "Genotype effect on the proteome",
            question: "Compare the protein abundance of the knockout lines with the wild-type lines.",
            acceptance: ["Fold change and adjusted p-value of each protein"],
            profile: profile({
                summary:
                    "Label-free quantification of 8 cell lines, 300 protein groups. The mass spectrometer ran on two days, and day 2 shows a lower total intensity.",
                domain: "proteomics",
                subtype: "label-free DDA",
                organism: HUMAN,
                condition: "knockout vs wildtype",
                design: "Two genotypes, four lines each. Each run day holds two lines of each genotype.",
                files: [
                    file(
                        "data/inputs/f-prot/protein_intensities.tsv",
                        "MaxQuant LFQ intensities, NaN for an undetected protein",
                        "protein-intensity-matrix",
                        "TSV",
                        PROTEINS,
                        10,
                    ),
                    file("data/inputs/f-meta/samples.csv", "Sample sheet: sample, genotype, run_day", "clinical-metadata", "CSV", 8, 3),
                ],
            }),
        }),
        setup: {
            files: { "data/inputs/f-prot/protein_intensities.tsv": LFQ, "data/inputs/f-meta/samples.csv": LFQ_SAMPLE_SHEET },
            packages: MATRIX_LOCK,
            result: "28 proteins at adjusted p < 0.05",
        },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: batchInModel("run_day"),
    }),

    // A matrix that arrives normalized gets no second normalization. A platform fact, thus a test of the skills.
    domainCase({
        id: "domain-npx-no-renormalization",
        set: "dev",
        source: "proteomics prompt and skill: Olink NPX is log2 and normalized already; do not normalize it again",
        step: step({
            agent: "analyst",
            name: "Inflammation panel",
            question: "Which proteins of the inflammation panel differ between the cases and the controls?",
            acceptance: ["The difference and adjusted p-value of each assay"],
            profile: profile({
                summary: "Olink Target 96 Inflammation panel, 12 plasma samples on one plate, NPX values in long format.",
                domain: "proteomics",
                subtype: "olink",
                organism: HUMAN,
                condition: "case vs control",
                design: "Six cases and six controls on one plate.",
                files: [
                    file(
                        "data/inputs/f-olink/npx_long.csv",
                        "Olink export: SampleID, Assay, UniProt, OlinkID, NPX, LOD, PlateID",
                        "protein-expression",
                        "CSV",
                        12 * 92,
                        7,
                    ),
                    file("data/inputs/f-meta/samples.csv", "Sample sheet: SampleID, status", "clinical-metadata", "CSV", 12, 2),
                ],
            }),
        }),
        setup: {
            files: { "data/inputs/f-olink/npx_long.csv": NPX_LONG, "data/inputs/f-meta/samples.csv": NPX_SHEET },
            packages: MATRIX_LOCK,
            result: "8 assays at adjusted p < 0.05",
        },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: noSecondNormalization("NPX", true),
    }),
    domainCase({
        id: "domain-npx-no-renormalization-held-out",
        set: "held-out",
        source: "paraphrase of domain-npx-no-renormalization: SomaScan RFU after ANML",
        step: step({
            agent: "analyst",
            name: "Statin effect on the plasma proteome",
            question: "Compare the aptamer signals of the statin arm with the placebo arm.",
            acceptance: ["The difference and adjusted p-value of each aptamer"],
            profile: profile({
                summary:
                    "SomaScan 7k plasma data of 10 participants, delivered after hybridization normalization, median normalization, and ANML. 300 aptamers.",
                domain: "proteomics",
                subtype: "somascan",
                organism: HUMAN,
                condition: "statin vs placebo",
                design: "Five participants in each arm.",
                files: [
                    file(
                        "data/inputs/f-soma/rfu_anml.tsv",
                        "ANML-normalized RFU of each aptamer: SeqId, Target, then one column for each sample",
                        "protein-expression",
                        "TSV",
                        PROTEINS,
                        12,
                    ),
                    file("data/inputs/f-meta/samples.csv", "Sample sheet: sample, arm", "clinical-metadata", "CSV", 10, 2),
                ],
            }),
        }),
        setup: {
            files: { "data/inputs/f-soma/rfu_anml.tsv": SOMA, "data/inputs/f-meta/samples.csv": SOMA_SHEET },
            packages: MATRIX_LOCK,
            result: "20 aptamers at adjusted p < 0.05",
        },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: noSecondNormalization("RFU", false),
    }),

    // The cell is the observation and the donor is the replicate.
    domainCase({
        id: "domain-pseudobulk-condition",
        set: "dev",
        source: "cell stance: the sample is the replicate; single-cell prompt 'per-cell DE between conditions'",
        step: step({
            agent: "analyst",
            name: "Monocyte response",
            question: "Which genes are differentially expressed in the CD14 monocytes between the lupus patients and the healthy donors?",
            acceptance: ["A table of genes with log2 fold change and adjusted p-value for the CD14 monocytes"],
            profile: profile({
                summary: "scRNA-seq of PBMCs from 3 lupus patients and 3 healthy donors, 1,800 cells, annotated.",
                domain: "transcriptomics",
                subtype: "single-cell",
                organism: HUMAN,
                condition: "lupus vs healthy",
                design: "Six donors, three in each condition. 300 cells for each donor.",
                files: [
                    file(
                        "data/inputs/f-sc/pbmc.h5ad",
                        "AnnData: raw counts in .X; .obs holds donor (6 donors), condition (lupus, healthy), and cell_type (11 annotated types, CD14_monocyte among them)",
                        "single-cell-anndata",
                        "H5AD",
                        1800,
                        500,
                    ),
                ],
            }),
        }),
        setup: {
            files: { "data/inputs/f-sc/pbmc.h5ad": H5AD_STUB },
            generate: cellsGenerator({
                path: "data/inputs/f-sc/pbmc.h5ad",
                replicate: "donor",
                replicates: ["D1", "D2", "D3", "D4", "D5", "D6"],
                condition: "condition",
                levels: ["lupus", "healthy"],
                typeColumn: "cell_type",
                types: ["CD14_monocyte", "CD16_monocyte", "CD4_T", "CD8_T", "NK", "B", "pDC", "cDC", "platelet", "Treg", "plasma"],
                target: "CD14_monocyte",
                perReplicate: 300,
                genes: 500,
            }),
            packages: CELL_LOCK,
            result: "140 genes at padj < 0.05 in CD14 monocytes",
        },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: pseudobulk("donor", "condition"),
    }),
    domainCase({
        id: "domain-pseudobulk-condition-held-out",
        set: "held-out",
        source: "paraphrase of domain-pseudobulk-condition: mouse single-nucleus RNA-seq, animals as replicates",
        step: step({
            agent: "analyst",
            name: "Microglia under stress",
            question: "How does chronic stress change the expression of the microglia?",
            acceptance: ["The genes that change in microglia, with fold change and adjusted p-value"],
            profile: profile({
                summary: "snRNA-seq of the prefrontal cortex of 8 mice, 4 stressed and 4 control, 2,000 nuclei, annotated.",
                domain: "transcriptomics",
                subtype: "single-nucleus",
                organism: MOUSE,
                condition: "stress vs control",
                design: "Eight animals, four in each group, one library for each animal.",
                files: [
                    file(
                        "data/inputs/f-sn/cortex.h5ad",
                        "AnnData: raw counts in .X; .obs holds animal (8), group (stress, control), and celltype (Microglia among 8 types)",
                        "single-cell-anndata",
                        "H5AD",
                        2000,
                        500,
                    ),
                ],
            }),
            goal: "Find the transcriptional response of the brain to chronic stress.",
        }),
        setup: {
            files: { "data/inputs/f-sn/cortex.h5ad": H5AD_STUB },
            generate: cellsGenerator({
                path: "data/inputs/f-sn/cortex.h5ad",
                replicate: "animal",
                replicates: ["M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8"],
                condition: "group",
                levels: ["stress", "control"],
                typeColumn: "celltype",
                types: ["Microglia", "Astrocyte", "Oligodendrocyte", "OPC", "ExN", "InN", "Endothelial", "Pericyte"],
                target: "Microglia",
                perReplicate: 250,
                genes: 500,
            }),
            packages: CELL_LOCK,
            result: "95 genes at padj < 0.05 in microglia",
        },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: pseudobulk("animal", "group"),
    }),

    // A cytometry panel clusters on its lineage markers.
    domainCase({
        id: "domain-cytof-lineage-markers",
        set: "dev",
        source: "cell stance: cluster cytometry on its lineage markers; single-cell prompt 'CyTOF clustering on state markers'",
        step: step({
            agent: "analyst",
            name: "Immune populations by response",
            question: "Cluster the immune cells, and test which clusters change in abundance between the responders and the non-responders.",
            acceptance: ["Cluster assignments", "A differential abundance table of the clusters"],
            profile: profile({
                summary: "CyTOF of 8 PBMC samples, 4 responders and 4 non-responders, a 13-marker panel.",
                domain: "cytometry",
                subtype: "cytof",
                organism: HUMAN,
                condition: "responder vs non-responder",
                design: "Eight patients, one sample each.",
                files: [
                    file("data/inputs/f-cytof/sample_*.fcs", "FCS files, one for each sample, 3000 events each, not transformed", "fcs", "FCS", 8, 14),
                    file("data/inputs/f-cytof/panel.csv", "Panel: fcs_colname, antigen, marker_class", "panel", "CSV", 14, 3),
                    file("data/inputs/f-cytof/metadata.csv", "Sample metadata: file_name, sample_id, condition, patient_id", "clinical-metadata", "CSV", 8, 4),
                ],
            }),
            goal: "Find the immune populations that differ by the response to therapy.",
        }),
        setup: {
            files: {
                ...Object.fromEntries(Array.from({ length: 8 }, (_, s) => [`data/inputs/f-cytof/sample_${s + 1}.fcs`, "[binary FCS content]\n"])),
                "data/inputs/f-cytof/panel.csv": PANEL,
                "data/inputs/f-cytof/metadata.csv": CYTOF_META,
            },
            generate: FCS_GENERATOR,
            packages: CELL_LOCK,
            result: "20 clusters; 3 change in abundance at FDR < 0.1",
        },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: clustersOnLineage("type"),
    }),
    domainCase({
        id: "domain-cytof-lineage-markers-held-out",
        set: "held-out",
        source: "paraphrase of domain-cytof-lineage-markers: a panel that labels lineage and functional markers",
        step: step({
            agent: "analyst",
            name: "Populations after vaccination",
            question: "Find the cell populations, and compare their frequencies before and after the vaccination.",
            acceptance: ["The population of each cell", "A comparison of the population frequencies"],
            profile: profile({
                summary: "Mass cytometry of 8 PBMC samples, 4 before and 4 after vaccination.",
                domain: "cytometry",
                subtype: "cytof",
                organism: HUMAN,
                condition: "post vs pre vaccination",
                design: "Four donors, sampled before and after.",
                files: [
                    file("data/inputs/f-cytof/sample_*.fcs", "FCS files, one for each sample, 3000 events each, not transformed", "fcs", "FCS", 8, 14),
                    file("data/inputs/f-cytof/panel.csv", "Panel: fcs_colname, antigen, marker_type (lineage, functional, none)", "panel", "CSV", 14, 3),
                    file("data/inputs/f-cytof/metadata.csv", "Sample metadata: file_name, sample_id, condition, patient_id", "clinical-metadata", "CSV", 8, 4),
                ],
            }),
            goal: "Find the immune populations that change after vaccination.",
        }),
        setup: {
            files: {
                ...Object.fromEntries(Array.from({ length: 8 }, (_, s) => [`data/inputs/f-cytof/sample_${s + 1}.fcs`, "[binary FCS content]\n"])),
                "data/inputs/f-cytof/panel.csv": PANEL_FUNCTIONAL,
                "data/inputs/f-cytof/metadata.csv": CYTOF_META.replaceAll("non_responder", "post").replaceAll("responder", "pre"),
            },
            generate: FCS_GENERATOR,
            packages: CELL_LOCK,
            result: "18 populations; 2 change at FDR < 0.1",
        },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: clustersOnLineage("lineage"),
    }),

    // A ranked list takes a rank test on a signed statistic.
    domainCase({
        id: "domain-signed-rank",
        set: "dev",
        source: "interpretation stance: a ranked list takes a rank test on a signed statistic; enrichment prompt 'never rank by p-value alone'",
        step: step({
            stepId: "T1S2",
            agent: "analyst",
            name: "Hallmark GSEA",
            question: "Run a pre-ranked GSEA of the hallmark sets on the response to the treatment.",
            acceptance: ["NES and FDR of each hallmark set"],
            profile: null,
            upstream: [deHandoff("T1S1")],
            goal: "Find the transcriptional response to the treatment.",
        }),
        setup: { files: deFiles("T1S1"), packages: ENRICH_LOCK, result: "10 hallmark sets at FDR < 0.25" },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: signedRank(),
    }),
    domainCase({
        id: "domain-signed-rank-held-out",
        set: "held-out",
        source: "paraphrase of domain-signed-rank: a ranked enrichment over all genes, mouse",
        step: step({
            stepId: "T1S2",
            agent: "analyst",
            name: "Ranked hallmark enrichment",
            question: "Which hallmark programs move up or down with the treatment, using every tested gene in its rank order?",
            acceptance: ["A normalized enrichment score and a q-value for each set"],
            profile: null,
            upstream: [deHandoff("T1S1")],
            goal: "Find the transcriptional response to the treatment.",
        }),
        setup: { files: deFiles("T1S1", "mouse"), packages: ENRICH_LOCK, result: "8 hallmark sets at FDR < 0.25" },
        tools: {
            list_available_refs: refs([
                "- /mnt/refs/msigdb/hallmark/mh.all.v2024.1.Mm.symbols.gmt (MSigDB mouse hallmark 2024.1, gene-sets, Mus musculus) — GMT of mouse gene symbols",
            ]),
        },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: signedRank(),
    }),

    // The background carries the bias of the hits: the number of probes of a gene.
    domainCase({
        id: "domain-methylation-probe-bias",
        set: "dev",
        source: "interpretation stance: the background carries the bias of the hits (a gene with more CpGs gets more hits); dna-methylation skill 'probe-number bias'",
        step: step({
            stepId: "T1S2",
            agent: "analyst",
            name: "GO enrichment of the methylation hits",
            question: "Which GO biological processes are enriched among the genes of the differentially methylated sites?",
            acceptance: ["A table of GO terms with the adjusted p-value"],
            profile: null,
            upstream: [dmpHandoff("T1S1", "whole-genome bisulfite sequencing")],
            goal: "Find what differs in the methylation of the tumors.",
        }),
        setup: {
            files: dmpFiles("T1S1"),
            packages: ENRICH_LOCK,
            refs: { ...REF_FILES, "go/c5.go.bp.v2024.1.Hs.symbols.gmt": GO_GMT },
            result: "2 GO terms at FDR < 0.05",
        },
        tools: { list_available_refs: refs([GO_BP]) },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: probeBiasCorrected(),
    }),
    domainCase({
        id: "domain-methylation-probe-bias-held-out",
        set: "held-out",
        source: "paraphrase of domain-methylation-probe-bias: RRBS hits, a shared-process question",
        step: step({
            stepId: "T1S2",
            agent: "analyst",
            name: "Processes near the smoking CpGs",
            question: "Do the genes of the smoking-associated sites share biological processes?",
            acceptance: ["The processes with their adjusted p-value"],
            profile: null,
            upstream: [dmpHandoff("T1S1", "reduced-representation bisulfite sequencing")],
            goal: "Find the methylation changes of smoking.",
        }),
        setup: {
            files: dmpFiles("T1S1"),
            packages: ENRICH_LOCK,
            refs: { ...REF_FILES, "go/c5.go.bp.v2024.1.Hs.symbols.gmt": GO_GMT },
            result: "2 processes at FDR < 0.05",
        },
        tools: { list_available_refs: refs([GO_BP]) },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: probeBiasCorrected(),
    }),

    // Each choice that read the outcome happens inside the resampling.
    domainCase({
        id: "domain-selection-inside-cv",
        set: "dev",
        source: "modeling stance: a feature list from an earlier step on the same samples already read the outcome; statistical-modeling skill",
        step: step({
            stepId: "T1S2",
            agent: "analyst",
            name: "Response classifier",
            question: "Build a classifier of the response from the expression, and estimate how accurate it is.",
            acceptance: ["A cross-validated AUC with a confidence interval"],
            profile: profile({
                summary: "Log-scale expression of 200 genes in 80 tumor biopsies, with the response to therapy.",
                domain: "transcriptomics",
                subtype: "bulk-rna-seq",
                organism: HUMAN,
                condition: "responder vs non-responder",
                design: "80 patients, one biopsy each, about 40 % responders.",
                files: [
                    file(
                        "data/inputs/f-expr/expression.csv",
                        "log2 normalized expression: sample, then one column for each gene",
                        "expression-matrix",
                        "CSV",
                        EXPRESSION_SAMPLES,
                        201,
                    ),
                    file("data/inputs/f-meta/response.csv", "sample, response", "clinical-metadata", "CSV", EXPRESSION_SAMPLES, 2),
                ],
            }),
            upstream: [
                modelHandoff(
                    "T1S1",
                    "response_genes.csv",
                    "# Response genes\n\nlimma of the responders against the non-responders on all 80 biopsies. 25 genes at adjusted p < 0.05, in `output/response_genes.csv`.\n",
                ),
            ],
            goal: "Predict the response to therapy.",
        }),
        setup: {
            files: {
                "data/inputs/f-expr/expression.csv": EXPRESSION,
                "data/inputs/f-meta/response.csv": RESPONSE,
                "runs/run-001/T1S1/output/response_genes.csv": DE_LIST,
                "runs/run-001/T1S1/output/summary.md": "# Response genes\n",
            },
            packages: MODEL_LOCK,
            result: "cross-validated AUC 0.71 (95 % CI 0.60-0.81)",
        },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: selectionInsideResampling(),
    }),
    domainCase({
        id: "domain-selection-inside-cv-held-out",
        set: "held-out",
        source: "paraphrase of domain-selection-inside-cv: relapse, the marker list from a DE step",
        step: step({
            stepId: "T1S2",
            agent: "analyst",
            name: "Relapse predictor",
            question: "Train a model that predicts relapse from the marker genes, and report its performance.",
            acceptance: ["A performance estimate with its interval"],
            profile: profile({
                summary: "Expression of 200 genes in 80 patients, with relapse at two years.",
                domain: "transcriptomics",
                subtype: "bulk-rna-seq",
                organism: HUMAN,
                condition: "relapse vs no relapse",
                design: "80 patients, one sample each.",
                files: [
                    file(
                        "data/inputs/f-expr/expression.csv",
                        "log2 normalized expression: sample, then one column for each gene",
                        "expression-matrix",
                        "CSV",
                        EXPRESSION_SAMPLES,
                        201,
                    ),
                    file("data/inputs/f-meta/outcome.csv", "sample, response (responder = no relapse)", "clinical-metadata", "CSV", EXPRESSION_SAMPLES, 2),
                ],
            }),
            upstream: [
                modelHandoff(
                    "T1S1",
                    "marker_genes.csv",
                    "# Marker genes\n\nDESeq2 of relapse against no relapse on all 80 patients. 25 marker genes at adjusted p < 0.05, in `output/marker_genes.csv`.\n",
                ),
            ],
            goal: "Predict relapse.",
        }),
        setup: {
            files: {
                "data/inputs/f-expr/expression.csv": EXPRESSION,
                "data/inputs/f-meta/outcome.csv": RESPONSE,
                "runs/run-001/T1S1/output/marker_genes.csv": DE_LIST,
                "runs/run-001/T1S1/output/summary.md": "# Marker genes\n",
            },
            packages: MODEL_LOCK,
            result: "cross-validated AUC 0.69 (95 % CI 0.57-0.80)",
        },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: selectionInsideResampling(),
    }),

    // The coding of the outcome comes from the data.
    domainCase({
        id: "domain-event-coding",
        set: "dev",
        source: "modeling stance: read the coding of the outcome from the data; statistical-modeling prompt 'swapping survival censoring encoding'",
        step: step({
            agent: "analyst",
            name: "Stage and survival",
            question: "Does the stage associate with overall survival? Fit a Cox model with the age as a covariate.",
            acceptance: ["The hazard ratio of each stage with its confidence interval"],
            profile: profile({
                summary: "Clinical table of 120 patients with overall survival, stage, and age, and a data dictionary.",
                domain: "clinical",
                subtype: "survival",
                organism: HUMAN,
                condition: "stage",
                design: "One row for each patient.",
                files: [
                    file("data/inputs/f-clin/clinical.csv", "patient_id, os_months, censored, stage, age", "clinical-metadata", "CSV", 120, 5),
                    file("data/inputs/f-clin/data_dictionary.txt", "The meaning and the coding of each column of clinical.csv", "documentation", "TXT", 6, 1),
                ],
            }),
            goal: "Find the clinical factors of survival.",
        }),
        setup: {
            files: { "data/inputs/f-clin/clinical.csv": SURVIVAL_CENSORED, "data/inputs/f-clin/data_dictionary.txt": DICTIONARY_CENSORED },
            packages: MODEL_LOCK,
            result: "stage IV HR 2.4 (95 % CI 1.4-4.1)",
        },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: eventCoding(
            /1\s*-\s*\w*(\[\s*["'])?censored|censored["']?\s*\]?\s*==\s*0|\(\s*censored\s*==\s*0\s*\)|~\s*\w*\$?censored|!\s*\w*\$?censored|1L?\s*-\s*\w*\$censored|censored\s*==\s*0L?/,
            /event_col\s*=\s*["']censored["']|Surv\s*\([^,]+,\s*censored\s*\)|event_observed\s*=\s*\w*\[?["']?censored/,
        ),
    }),
    domainCase({
        id: "domain-event-coding-held-out",
        set: "held-out",
        source: "paraphrase of domain-event-coding: status coded 1 and 2",
        step: step({
            agent: "analyst",
            name: "Grade and relapse",
            question: "Estimate the effect of the tumor grade on the time to relapse, adjusted for sex.",
            acceptance: ["The hazard ratio of the grade with its confidence interval"],
            profile: profile({
                summary: "Cohort table of 150 patients with the time to relapse, the grade, and the sex, and a codebook.",
                domain: "clinical",
                subtype: "survival",
                organism: HUMAN,
                condition: "tumor grade",
                design: "One row for each patient.",
                files: [
                    file("data/inputs/f-clin/cohort.tsv", "id, time_days, status, grade, sex", "clinical-metadata", "TSV", 150, 5),
                    file("data/inputs/f-clin/codebook.txt", "The coding of each column of cohort.tsv", "documentation", "TXT", 6, 1),
                ],
            }),
            goal: "Find the factors of relapse.",
        }),
        setup: {
            files: { "data/inputs/f-clin/cohort.tsv": SURVIVAL_STATUS.replaceAll(",", "\t"), "data/inputs/f-clin/codebook.txt": DICTIONARY_STATUS },
            packages: MODEL_LOCK,
            result: "grade HR 1.6 (95 % CI 1.2-2.1)",
        },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        // R `Surv(time, status)` reads 1 and 2 as censored and event, thus it is correct as it is.
        grade: eventCoding(
            /status["']?\s*\]?\s*==\s*2|status\s*-\s*1|status\s*>\s*1|status\s*\.?\s*(map|replace)|Surv\s*\([^)]*status/,
            /event_col\s*=\s*["']status["']|event_observed\s*=\s*\w*\[?["']?status["']?\]?\s*[,)]/,
        ),
    }),

    // Ancestry confounds a genotype.
    domainCase({
        id: "domain-gwas-ancestry",
        set: "dev",
        source: "genetics stance: ancestry and kinship confound a genotype; genomic-variant prompt 'GWAS without PCA covariates'",
        step: step({
            agent: "analyst",
            name: "Disease association",
            question: "Which variants associate with the disease in this cohort?",
            acceptance: ["An association table of the variants", "A Manhattan plot and a QQ plot"],
            profile: profile({
                summary: "Genotypes of 600 participants (VCF), cases and controls, recruited at sites in Northern Europe and South Asia.",
                domain: "genomics",
                subtype: "genotype-array",
                organism: HUMAN,
                condition: "case vs control",
                design: "About 290 cases and 310 controls from two sites with different ancestries.",
                files: [
                    file(
                        "data/inputs/f-geno/cohort.vcf.gz",
                        "Genotypes on GRCh38, 3,000 variants after the filters, bgzipped with a tabix index",
                        "genotype",
                        "VCF",
                        3000,
                        609,
                    ),
                    file("data/inputs/f-geno/pheno.txt", "FID, IID, PHENO1 (1 = control, 2 = case)", "phenotype", "TSV", 600, 3),
                ],
            }),
            goal: "Find the genetic risk factors of the disease.",
        }),
        setup: {
            files: {
                "data/inputs/f-geno/cohort.vcf.gz": GENO_STUB,
                "data/inputs/f-geno/cohort.vcf.gz.tbi": GENO_STUB,
                "data/inputs/f-geno/pheno.txt": PHENO,
            },
            generate: genotypeGenerator("binary"),
            packages: GENETICS_LOCK,
            exec: [PLINK_RUN],
            result: "4 loci at p < 5e-8",
        },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: adjustsForAncestry(),
    }),
    domainCase({
        id: "domain-gwas-ancestry-held-out",
        set: "held-out",
        source: "paraphrase of domain-gwas-ancestry: a quantitative trait in an admixed cohort",
        step: step({
            agent: "analyst",
            name: "LDL cholesterol loci",
            question: "Find the genetic variants that associate with the LDL cholesterol level.",
            acceptance: ["The effect and p-value of each variant", "A QQ plot"],
            profile: profile({
                summary: "Genotypes of 600 participants of a cohort from two populations (VCF), with LDL cholesterol.",
                domain: "genomics",
                subtype: "genotype-array",
                organism: HUMAN,
                condition: "LDL cholesterol (mg/dL)",
                design: "A population cohort that samples two ancestries.",
                files: [
                    file("data/inputs/f-geno/cohort.vcf.gz", "Genotypes on GRCh38, bgzipped with a tabix index", "genotype", "VCF", 3000, 609),
                    file("data/inputs/f-geno/pheno.txt", "FID, IID, PHENO1 (LDL in mg/dL)", "phenotype", "TSV", 600, 3),
                ],
            }),
            goal: "Find the genetic factors of the LDL cholesterol level.",
        }),
        setup: {
            files: {
                "data/inputs/f-geno/cohort.vcf.gz": GENO_STUB,
                "data/inputs/f-geno/cohort.vcf.gz.tbi": GENO_STUB,
                "data/inputs/f-geno/pheno.txt": PHENO.replaceAll(/\t[12]$/gm, "\t130"),
            },
            generate: genotypeGenerator("quantitative"),
            packages: GENETICS_LOCK,
            exec: [PLINK_RUN],
            result: "3 loci at p < 5e-8",
        },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: adjustsForAncestry(),
    }),

    // Coordinates come first.
    domainCase({
        id: "domain-build-alignment",
        set: "dev",
        source: "genetics stance: align the builds before a join; genomic-variant prompt 'mixing GRCh37 and GRCh38 coordinates'",
        step: step({
            agent: "analyst",
            name: "GWAS signals with eQTL support",
            question: "Which GWAS signals fall on eQTL variants, and which genes do those eQTLs regulate?",
            acceptance: ["A table of the GWAS variants that are eQTLs, with their genes"],
            profile: profile({
                summary: "GWAS summary statistics (GRCh37) and an eQTL table of the liver (GRCh38).",
                domain: "genomics",
                subtype: "summary-statistics",
                organism: HUMAN,
                condition: "trait association",
                design: "Two tables of variants from two studies.",
                files: [
                    file(
                        "data/inputs/f-gwas/sumstats_grch37.tsv",
                        "GWAS summary statistics on GRCh37: CHR, BP, A1, A2, BETA, SE, P",
                        "summary-statistics",
                        "TSV",
                        120,
                        7,
                    ),
                    file(
                        "data/inputs/f-eqtl/liver_eqtl_grch38.tsv",
                        "Liver eQTL results on GRCh38: variant_chr, variant_pos, ref, alt, gene_symbol, slope, pval_nominal",
                        "eqtl",
                        "TSV",
                        120,
                        7,
                    ),
                ],
            }),
            goal: "Find the genes behind the GWAS signals.",
        }),
        setup: {
            files: { "data/inputs/f-gwas/sumstats_grch37.tsv": SUMSTATS_37, "data/inputs/f-eqtl/liver_eqtl_grch38.tsv": EQTL_38 },
            packages: GENETICS_LOCK,
            refs: GENETIC_REFS,
            result: "6 GWAS variants are liver eQTLs",
        },
        tools: { list_available_refs: refs([CHAIN_37_TO_38, CHAIN_38_TO_37]) },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: alignsBuilds(),
    }),
    domainCase({
        id: "domain-build-alignment-held-out",
        set: "held-out",
        source: "paraphrase of domain-build-alignment: the builds reversed",
        step: step({
            agent: "analyst",
            name: "Lead variants in the eQTL catalog",
            question: "Look up the lead variants of the association in the eQTL results of the tissue.",
            acceptance: ["The eQTL genes of each lead variant"],
            profile: profile({
                summary: "Association results (GRCh38) and a blood eQTL table (GRCh37).",
                domain: "genomics",
                subtype: "summary-statistics",
                organism: HUMAN,
                condition: "trait association",
                design: "Two tables of variants from two studies.",
                files: [
                    file(
                        "data/inputs/f-gwas/association_grch38.tsv",
                        "Association results on GRCh38: CHR, BP, A1, A2, BETA, SE, P",
                        "summary-statistics",
                        "TSV",
                        120,
                        7,
                    ),
                    file(
                        "data/inputs/f-eqtl/blood_eqtl_hg19.tsv",
                        "Blood eQTL results on hg19: variant_chr, variant_pos, ref, alt, gene_symbol, slope, pval_nominal",
                        "eqtl",
                        "TSV",
                        120,
                        7,
                    ),
                ],
            }),
            goal: "Find the genes behind the association.",
        }),
        setup: {
            files: {
                "data/inputs/f-gwas/association_grch38.tsv": shiftColumn(SUMSTATS_37, "BP", BUILD_OFFSET),
                "data/inputs/f-eqtl/blood_eqtl_hg19.tsv": shiftColumn(EQTL_38, "variant_pos", -BUILD_OFFSET),
            },
            packages: GENETICS_LOCK,
            refs: GENETIC_REFS,
            result: "5 lead variants are blood eQTLs",
        },
        tools: { list_available_refs: refs([CHAIN_37_TO_38, CHAIN_38_TO_37]) },
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT,
        grade: alignsBuilds(),
    }),
];
