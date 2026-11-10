import { describe, expect, test } from "bun:test";

import { domainCases } from "../cases/domain.js";
import type { Trial } from "../lib/case.js";

function trial(files: Readonly<Record<string, string>>, opts: { readonly commands?: readonly string[]; readonly text?: string } = {}): Trial {
    return {
        calls: (opts.commands ?? []).map((command, step) => ({ step, tool: "execute_command", input: { command }, refused: false })),
        asks: [],
        text: opts.text ?? "",
        finishReason: "stop",
        stepFinishes: [],
        capped: false,
        files,
    };
}

function gradeOf(id: string, t: Trial): boolean {
    const evalCase = domainCases.find((c) => c.id === id);
    if (evalCase === undefined) throw new Error(`no case ${id}`);
    return evalCase.grade(t).pass;
}

/** A correct and a wrong trial for the behavior of each pair: the dev case and its held-out twin grade both alike. */
const PAIRS: readonly { readonly id: string; readonly twin?: string; readonly pass: Trial; readonly fail: Trial }[] = [
    {
        id: "domain-intensities-linear-model",
        pass: trial({ "scripts/de.R": "library(limma)\nfit <- lmFit(log2(x), design)\nfit <- eBayes(fit)\n" }),
        fail: trial({ "scripts/de.py": "dds = DeseqDataSet(counts=x.round().astype(int), metadata=m, design='~genotype')\n" }),
    },
    {
        id: "domain-intensities-linear-model-held-out",
        pass: trial({ "scripts/de.py": "from scipy.stats import ttest_ind\nt = ttest_ind(np.log2(a + 1), np.log2(b + 1), axis=1)\n" }),
        fail: trial({ "scripts/de.R": "y <- DGEList(round(tpm))\nv <- voom(y, design)\n" }),
    },
    {
        id: "domain-no-replicate-descriptive",
        twin: "domain-no-replicate-descriptive-held-out",
        pass: trial(
            { "scripts/fold.py": "lfc = np.log2((t + 1) / (c + 1))\n" },
            { text: "With one sample in each group there is no replicate, thus no p-value." },
        ),
        fail: trial({ "scripts/de.py": "dds = DeseqDataSet(counts=x, metadata=m, design='~group')\n" }, { text: "One replicate only." }),
    },
    {
        id: "domain-beta-logit",
        twin: "domain-beta-logit-held-out",
        pass: trial({ "scripts/dmp.py": "m = np.log2(betas / (1 - betas))\nres = smf.ols('m ~ tissue', d).fit()\n" }),
        fail: trial({ "scripts/dmp.py": "res = ttest_ind(betas[tumor], betas[normal], axis=1)\n" }),
    },
    {
        id: "domain-batch-in-design",
        pass: trial({ "scripts/de.py": "dds = DeseqDataSet(counts=x, metadata=m, design='~batch + group')\n" }),
        fail: trial({ "scripts/de.py": "dds = DeseqDataSet(counts=x, metadata=m, design='~group')\n" }),
    },
    {
        id: "domain-batch-in-design-held-out",
        pass: trial({ "scripts/de.R": "design <- model.matrix(~ run_day + genotype, s)\nfit <- lmFit(y, design)\n" }),
        fail: trial({ "scripts/de.R": "design <- model.matrix(~ genotype, s)\nfit <- lmFit(y, design)\n" }),
    },
    {
        id: "domain-npx-no-renormalization",
        pass: trial({ "scripts/de.R": "fit <- lmFit(npx_wide, design)\nfit <- eBayes(fit)\n" }),
        fail: trial({ "scripts/de.py": "df['NPX'] = np.log2(df['NPX'])\nres = ttest_ind(a, b)\n" }),
    },
    {
        id: "domain-npx-no-renormalization-held-out",
        pass: trial({ "scripts/de.R": "y <- log2(rfu)\nfit <- lmFit(y, design)\n" }),
        fail: trial({ "scripts/de.R": "y <- normalizeBetweenArrays(log2(rfu))\nfit <- lmFit(y, design)\n" }),
    },
    {
        id: "domain-pseudobulk-condition",
        pass: trial({
            "scripts/pb.py": "pb = adata.to_df().groupby(adata.obs['donor']).sum()\ndds = DeseqDataSet(counts=pb, metadata=m, design='~condition')\n",
        }),
        fail: trial({ "scripts/de.py": "sc.tl.rank_genes_groups(mono, groupby='condition', method='wilcoxon')\n" }),
    },
    {
        id: "domain-pseudobulk-condition-held-out",
        pass: trial({ "scripts/pb.py": "pb = dc.pp.pseudobulk(adata, sample_col='animal', groups_col='celltype')\n" }),
        fail: trial({ "scripts/de.py": "sc.tl.rank_genes_groups(mg, groupby='group')\n" }),
    },
    {
        id: "domain-cytof-lineage-markers",
        pass: trial({ "scripts/cluster.R": 'sce <- cluster(sce, features = "type", xdim = 10, ydim = 10, maxK = 20)\n' }),
        fail: trial({ "scripts/cluster.R": "sce <- cluster(sce, features = NULL, maxK = 20)\n" }),
    },
    {
        id: "domain-cytof-lineage-markers-held-out",
        pass: trial({ "scripts/cluster.py": "cols = panel[panel.marker_type == 'lineage'].fcs_colname\nsc.tl.leiden(adata[:, cols])\n" }),
        fail: trial({ "scripts/cluster.py": "sc.tl.leiden(adata)\n" }),
    },
    {
        id: "domain-signed-rank",
        twin: "domain-signed-rank-held-out",
        pass: trial({ "scripts/gsea.py": "rnk = np.sign(de.log2FoldChange) * -np.log10(de.padj)\ngp.prerank(rnk=rnk, gene_sets=gmt)\n" }),
        fail: trial({ "scripts/gsea.py": "rnk = -np.log10(de.padj)\ngp.prerank(rnk=rnk, gene_sets=gmt)\n" }),
    },
    {
        id: "domain-methylation-probe-bias",
        twin: "domain-methylation-probe-bias-held-out",
        pass: trial({ "scripts/go.R": "library(missMethyl)\ngo <- gometh(sig.cpg = sig, all.cpg = all, collection = 'GO')\n" }),
        fail: trial({ "scripts/go.py": "gp.enrich(gene_list=genes, gene_sets=gmt, background=bg)\n" }),
    },
    {
        id: "domain-selection-inside-cv",
        pass: trial({
            "scripts/model.py":
                "pipe = Pipeline([('sel', SelectKBest(k=25)), ('clf', LogisticRegression())])\ncross_val_score(pipe, X, y, cv=StratifiedKFold(5))\n",
        }),
        fail: trial({
            "scripts/model.py":
                "genes = pd.read_csv('response_genes.csv').gene\npipe = Pipeline([('sc', StandardScaler()), ('clf', LogisticRegression())])\ncross_val_score(pipe, X[genes], y, cv=5)\n",
        }),
    },
    {
        id: "domain-selection-inside-cv-held-out",
        pass: trial(
            { "scripts/model.py": "genes = pd.read_csv('marker_genes.csv').gene\ncross_val_score(clf, X[genes], y)\n" },
            { text: "The estimate is optimistic: the markers were selected on all samples." },
        ),
        fail: trial({ "scripts/model.py": "genes = pd.read_csv('marker_genes.csv').gene\ncross_val_score(clf, X[genes], y)\n" }),
    },
    {
        id: "domain-event-coding",
        pass: trial({ "scripts/cox.py": "df['event'] = 1 - df['censored']\nCoxPHFitter().fit(df, duration_col='os_months', event_col='event')\n" }),
        fail: trial({ "scripts/cox.py": "CoxPHFitter().fit(df, duration_col='os_months', event_col='censored')\n" }),
    },
    {
        id: "domain-event-coding-held-out",
        pass: trial({
            "scripts/cox.py": "df['event'] = (df['status'] == 2).astype(int)\nCoxPHFitter().fit(df, duration_col='time_days', event_col='event')\n",
        }),
        fail: trial({ "scripts/cox.py": "CoxPHFitter().fit(df, duration_col='time_days', event_col='status')\n" }),
    },
    {
        id: "domain-gwas-ancestry",
        twin: "domain-gwas-ancestry-held-out",
        pass: trial(
            { "scripts/qq.py": "lambda_gc = np.median(chi2) / 0.456\n" },
            { commands: ["plink2 --bfile cohort --pca 10 --out pcs", "plink2 --bfile cohort --glm --covar pcs.eigenvec --out assoc"] },
        ),
        fail: trial({ "scripts/qq.py": "lam = np.median(chi2) / 0.456\n" }, { commands: ["plink2 --bfile cohort --glm --out assoc"] }),
    },
    {
        id: "domain-build-alignment",
        twin: "domain-build-alignment-held-out",
        pass: trial({ "scripts/join.py": "lo = LiftOver('/mnt/refs/liftover/hg19ToHg38.over.chain.gz')\nm = gwas.merge(eqtl, on=['chr', 'pos'])\n" }),
        fail: trial({ "scripts/join.py": "m = gwas.merge(eqtl, left_on=['CHR', 'BP'], right_on=['variant_chr', 'variant_pos'])\n" }),
    },
];

describe("the graders of the domain cases", () => {
    test("each domain case has a grader check", () => {
        const covered = new Set(PAIRS.flatMap((p) => [p.id, ...(p.twin === undefined ? [] : [p.twin])]));
        expect(domainCases.map((c) => c.id).filter((id) => !covered.has(id))).toEqual([]);
    });

    for (const pair of PAIRS) {
        for (const id of [pair.id, ...(pair.twin === undefined ? [] : [pair.twin])]) {
            test(`${id} passes the correct script and fails the wrong one`, () => {
                expect(gradeOf(id, pair.pass)).toBe(true);
                expect(gradeOf(id, pair.fail)).toBe(false);
            });
        }
    }
});

/** Forms that a correct trial wrote and an earlier grader refused. */
const OBSERVED: readonly { readonly id: string; readonly trial: Trial; readonly pass: boolean }[] = [
    {
        id: "domain-batch-in-design-held-out",
        trial: trial({ "scripts/de.R": "day <- factor(m$run_day)\ndesign <- model.matrix(~ g + day)\nfit <- eBayes(lmFit(L, design))\n" }),
        pass: true,
    },
    {
        id: "domain-batch-in-design-held-out",
        trial: trial({ "scripts/de.R": "day <- factor(m$run_day)\ndesign <- model.matrix(~ g)\nfit <- eBayes(lmFit(L, design))\n" }),
        pass: false,
    },
    {
        id: "domain-cytof-lineage-markers-held-out",
        trial: trial({ "scripts/cytof.R": 'sce <- cluster(sce, features="type", xdim=8, ydim=8, maxK=12)\n' }),
        pass: true,
    },
    {
        id: "domain-gwas-ancestry-held-out",
        trial: trial({ "scripts/gwas.py": "pcs = PCA(10).fit(Z)\nbeta = np.linalg.lstsq(X, y, rcond=None)\nprint('lambda', lam)\n" }),
        pass: true,
    },
    {
        id: "domain-no-replicate-descriptive-held-out",
        trial: trial({ "scripts/fc.py": "lfc = np.log2(fasted / fed)\n" }, { text: "Pooling also hides differences between animals, thus no p-value." }),
        pass: true,
    },
    {
        id: "domain-methylation-probe-bias-held-out",
        trial: trial({ "scripts/ora.py": "bg = set(pd.read_csv('tested_cpgs_per_gene.csv').gene)\npv = hypergeom.sf(k - 1, N, K, n)\n" }),
        pass: false,
    },
    {
        id: "domain-methylation-probe-bias",
        trial: trial({
            "scripts/ora.py":
                "t = pd.read_csv('tested_cpgs_per_gene.csv')\nfit = smf.glm('hit ~ in_set + np.log(n_cpgs_tested)', t, family=sm.families.Binomial()).fit()\n",
        }),
        pass: true,
    },
    {
        id: "domain-gwas-ancestry-held-out",
        trial: trial({
            "scripts/gwas.py":
                "U, S, Vt = np.linalg.svd(Z, full_matrices=False)\npcs = U[:, :NPC] * S[:NPC]\nC = sm.add_constant(pcs)\nm = sm.OLS(y, X).fit()\nprint('lambda_GC', lam)\n",
        }),
        pass: true,
    },
    {
        id: "domain-beta-logit",
        trial: trial({ "scripts/dmp.py": "M = lambda x: np.log2(x / (1 - x))\ndM = M(bt) - M(bn)\nt = dM.mean(1) / se\np = 2 * stats.t.sf(abs(t), df=3)\n" }),
        pass: true,
    },
    {
        id: "domain-gwas-ancestry-held-out",
        trial: trial({
            "scripts/gwas.py": "PCs = U[:, :NPC] * S[:NPC]\n# association: OLS y ~ dosage + PCs, vectorised\nr_pc = assoc(Gp, PCs)\nprint('lambda GC', lam)\n",
        }),
        pass: true,
    },
    {
        id: "domain-methylation-probe-bias-held-out",
        trial: trial({
            "scripts/ora.py": "_, p = fisher_exact(tab)\nw = bg.set_index('gene').n_cpgs_tested\nnull = rng.choice(genes, size=k, p=w / w.sum())\n",
        }),
        pass: true,
    },
    {
        id: "domain-selection-inside-cv",
        trial: trial({
            "scripts/classifier.py":
                "pipe = Pipeline([('sel', SelectKBest(f_classif)), ('clf', LogisticRegression())])\nup = pd.read_csv('/analysis-001/runs/run-001/T1S1/output/response_genes.csv')\n",
        }),
        pass: true,
    },
];

describe("the graders accept the forms of correct trials", () => {
    for (const [index, observed] of OBSERVED.entries()) {
        test(`${observed.id} #${index} grades ${observed.pass ? "pass" : "fail"}`, () => {
            expect(gradeOf(observed.id, observed.trial)).toBe(observed.pass);
        });
    }
});
