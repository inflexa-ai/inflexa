# GSVA via rpy2 API Reference

R GSVA (Gene Set Variation Analysis) called from Python via rpy2. Computes per-sample gene set enrichment scores from expression data. Supports four methods: GSVA, ssGSEA, z-score, and PLAGE. Version 2.x uses parameter objects instead of a single function with a `method` argument.

## rpy2 Setup Boilerplate

```python
import numpy as np
import pandas as pd
import rpy2.robjects as ro
from rpy2.robjects import pandas2ri
from rpy2.robjects.conversion import localconverter
from rpy2.robjects.packages import importr

pandas2ri.activate()

gsva_pkg = importr("GSVA")
base = importr("base")
stats = importr("stats")
```

## pandas to R Conversion Helpers

```python
def pd_to_r(df):
    with localconverter(ro.default_converter + pandas2ri.converter):
        return ro.conversion.py2rpy(df)

def r_to_pd(r_obj):
    with localconverter(ro.default_converter + pandas2ri.converter):
        return ro.conversion.rpy2py(r_obj)
```

## Input Preparation

GSVA requires an expression matrix (genes x samples) and gene sets.

```python
# expr_df: genes as rows, samples as columns (continuous values: log-CPM, FPKM, microarray)
expr_r = base.as_matrix(pd_to_r(expr_df))

# Gene sets as a named R list of character vectors
gene_sets = {
    "Apoptosis": ["CASP3", "CASP9", "BAX", "BCL2", "TP53"],
    "Cell_Cycle": ["CDK1", "CDK2", "CCNB1", "CCND1", "RB1"],
    "Hypoxia": ["VEGFA", "HIF1A", "LDHA", "PGK1", "SLC2A1"],
}
gs_list = ro.ListVector({
    name: ro.StrVector(genes) for name, genes in gene_sets.items()
})

# Or load a gene set file resolved from the reference inventory (no network egress,
# so nothing may be fetched at runtime). Ask for the dataset by what it is — the
# MSigDB hallmark collection for your organism is the reliable default; Reactome and
# WikiPathways cover curated pathways; GO/oncogenic/immunologic collections only if
# your environment happens to have them. The directory, filename, and format all vary
# per environment, so resolve them rather than assuming.
#
# `gmt_path` holds the resolved path. readGMT() reads GMT only: one set per line,
# tab-separated — set name, description, then member gene symbols (HGNC for human,
# MGI for mouse). If the inventory reports another format, parse it in Python and
# build the ro.ListVector above instead.
ro.r.assign("gmt_path", gmt_path)
ro.r('gs_list <- readGMT(gmt_path, valueType="list")')
gs_list = ro.r("gs_list")
```

## GSVA Method (Hanzelmann et al. 2013)

Default method. Non-parametric kernel-based approach. Best for ranking pathway activity across samples.

```python
ro.r.assign("expr_mat", expr_r)
ro.r.assign("gs_list", gs_list)

ro.r('''
param <- gsvaParam(
    exprData = expr_mat,
    geneSets = gs_list,
    kcdf = "Gaussian",       # "Gaussian" for continuous | "Poisson" for counts | "none"
    minSize = 5,
    maxSize = 500,
    tau = 1,                 # weight of tail in random walk
    maxDiff = TRUE,          # use max deviation (Kuiper statistic)
    absRanking = FALSE
)
gsva_scores <- gsva(param, verbose = FALSE)
''')
scores_r = ro.r("gsva_scores")
scores_df = r_to_pd(base.as_data_frame(scores_r))
scores_df.index = list(base.rownames(scores_r))
# scores_df: gene_sets x samples
```

### gsvaParam() Parameters

```python
ro.r('''
param <- gsvaParam(
    exprData = expr_mat,       # matrix — genes x samples
    geneSets = gs_list,        # named list of character vectors (or GeneSetCollection)
    assay = NA,                # character | NA — assay name (for SummarizedExperiment)
    annotation = NULL,         # character | NULL — annotation package name
    minSize = 1,               # int — minimum gene set size (after filtering)
    maxSize = Inf,             # int — maximum gene set size
    kcdf = "Gaussian",         # "Gaussian"|"Poisson"|"none" — kernel for ECDF estimation
    tau = 1,                   # numeric — weight of tail in random walk (default 1)
    maxDiff = TRUE,            # logical — max deviation (TRUE) or max deviation from mean (FALSE)
    absRanking = FALSE,        # logical — rank by absolute expression value
    kcdfNoneMinSampleSize = 200  # int — min samples for kcdf="none" (direct ECDF)
)
''')
```

### kcdf Selection Guide

| `kcdf=` | When to Use |
|---------|-------------|
| `"Gaussian"` | Continuous data: microarray, log-CPM, log-RPKM, VST. Default. |
| `"Poisson"` | Integer count data: raw RNA-seq counts. |
| `"none"` | Large sample sizes (>200). Skips kernel estimation, uses direct ECDF. Faster. |

## ssGSEA Method (Barbie et al. 2009)

Single-sample GSEA. Normalizes scores by gene set size range.

```python
ro.r('''
param <- ssgseaParam(
    exprData = expr_mat,
    geneSets = gs_list,
    alpha = 0.25,            # weight for tail of ranking (default from Barbie et al.)
    normalize = TRUE,        # normalize scores by range
    minSize = 5,
    maxSize = 500
)
ssgsea_scores <- gsva(param, verbose = FALSE)
''')
ssgsea_df = r_to_pd(base.as_data_frame(ro.r("ssgsea_scores")))
ssgsea_df.index = list(base.rownames(ro.r("ssgsea_scores")))
```

### ssgseaParam() Parameters

```python
ro.r('''
param <- ssgseaParam(
    exprData = expr_mat,       # matrix — genes x samples
    geneSets = gs_list,        # named list of character vectors
    alpha = 0.25,              # numeric — tail weight (0.25 is standard)
    normalize = TRUE,          # logical — normalize scores to [0, 1] range
    minSize = 1,               # int — minimum gene set size
    maxSize = Inf              # int — maximum gene set size
)
''')
```

## Z-Score Method (Lee et al. 2008)

Combined z-score approach. Simple and fast.

```python
ro.r('''
param <- zscoreParam(
    exprData = expr_mat,
    geneSets = gs_list,
    minSize = 5,
    maxSize = 500
)
zscore_scores <- gsva(param, verbose = FALSE)
''')
zscore_df = r_to_pd(base.as_data_frame(ro.r("zscore_scores")))
zscore_df.index = list(base.rownames(ro.r("zscore_scores")))
```

## PLAGE Method (Tomfohr et al. 2005)

Pathway Level Analysis of Gene Expression. Uses SVD on standardized expression.

```python
ro.r('''
param <- plageParam(
    exprData = expr_mat,
    geneSets = gs_list,
    minSize = 5,
    maxSize = 500
)
plage_scores <- gsva(param, verbose = FALSE)
''')
plage_df = r_to_pd(base.as_data_frame(ro.r("plage_scores")))
plage_df.index = list(base.rownames(ro.r("plage_scores")))
```

## Method Selection Guide

| Method | `*Param()` | Best For | Characteristics |
|--------|-----------|----------|-----------------|
| GSVA | `gsvaParam()` | General pathway activity scoring | Non-parametric, kernel-based, most widely used |
| ssGSEA | `ssgseaParam()` | Single-sample scoring, deconvolution | Normalized enrichment, good for immune signatures |
| z-score | `zscoreParam()` | Quick exploration, simple interpretation | Fast, combined z-scores, easiest to interpret |
| PLAGE | `plageParam()` | SVD-based, variance-dominated signals | Captures dominant expression pattern via SVD |

## Using GeneSetCollection (Bioconductor)

```python
ro.r.assign("gmt_path", gmt_path)  # resolved from the reference inventory

ro.r('''
library(GSEABase)

# From a GMT file
gsc <- getGmt(gmt_path)

# Or build programmatically
gs1 <- GeneSet(c("GENE1", "GENE2", "GENE3"), setName="PathwayA")
gs2 <- GeneSet(c("GENE4", "GENE5", "GENE6"), setName="PathwayB")
gsc <- GeneSetCollection(list(gs1, gs2))

param <- gsvaParam(expr_mat, gsc)
scores <- gsva(param, verbose=FALSE)
''')
```

## Downstream Analysis of Scores

```python
# GSVA scores can be used as input to limma for differential pathway activity
ro.r.assign("scores", ro.r("gsva_scores"))
ro.r.assign("group", ro.StrVector(meta_df["condition"].tolist()))

ro.r('''
library(limma)
design <- model.matrix(~ group)
fit <- lmFit(scores, design)
fit <- eBayes(fit)
results <- topTable(fit, coef=2, number=Inf)
''')
limma_df = r_to_pd(ro.r("results"))
```

## Complete Workflow Example

```python
# Prepare expression matrix
expr_r = base.as_matrix(pd_to_r(expr_df))

# Load MSigDB hallmark gene sets from a GMT resolved per Input Preparation
ro.r.assign("gmt_path", gmt_path)
ro.r('gs_list <- readGMT(gmt_path, valueType="list")')

ro.r.assign("expr_mat", expr_r)

# Compute GSVA scores
ro.r('''
param <- gsvaParam(expr_mat, gs_list, kcdf="Gaussian", minSize=10, maxSize=500)
gsva_scores <- gsva(param, verbose=FALSE)
''')

scores_df = r_to_pd(base.as_data_frame(ro.r("gsva_scores")))
scores_df.index = list(base.rownames(ro.r("gsva_scores")))
```

## Gotchas

- GSVA 2.x uses parameter objects (`gsvaParam()`, `ssgseaParam()`, `zscoreParam()`, `plageParam()`). The legacy `gsva(expr, genesets, method="gsva")` syntax from GSVA 1.x is deprecated.
- Expression matrix must have genes as ROWS and samples as COLUMNS. This is standard R bioinformatics orientation.
- Gene names in the expression matrix must match gene names in the gene sets. Use `rownames(expr_mat)` to check. Unmatched genes are silently ignored.
- `kcdf="Gaussian"` is for continuous values (microarray, log-CPM). Using it on raw counts produces incorrect results. Use `kcdf="Poisson"` for counts.
- `minSize` filters gene sets by the number of genes that intersect with the expression matrix, not total gene set size. Small matrices may lose many gene sets.
- GSVA scores are not p-values. They are enrichment scores on a continuous scale. Use limma or a statistical test on scores to assess significance between groups.
- ssGSEA with `normalize=TRUE` bounds scores roughly between 0 and 1. Without normalization, scores scale with gene set size.
- PLAGE scores have arbitrary sign direction (SVD property). Focus on relative differences between samples, not absolute sign.
- For large matrices (>20k genes x >500 samples), GSVA can be memory-intensive. Consider using `kcdf="none"` for large sample sizes.
- `readGMT()` reads GMT files into either a named list or a GeneSetCollection. Use `valueType="list"` for simple list output.
