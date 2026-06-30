# limma via rpy2 API Reference

limma for differential expression via rpy2. Use voom for RNA-seq counts. limma excels at complex experimental designs, repeated measures (via duplicateCorrelation), and microarray data.

## rpy2 Setup

```python
import pandas as pd
import numpy as np
import rpy2.robjects as ro
from rpy2.robjects import pandas2ri, Formula
from rpy2.robjects.conversion import localconverter
from rpy2.robjects.packages import importr

pandas2ri.activate()

limma = importr("limma")
edger = importr("edgeR")
stats = importr("stats")
base = importr("base")
```

## Conversion Helpers

```python
def pd_to_r(df):
    with localconverter(ro.default_converter + pandas2ri.converter):
        return ro.conversion.py2rpy(df)

def r_to_pd(r_obj):
    with localconverter(ro.default_converter + pandas2ri.converter):
        return ro.conversion.rpy2py(r_obj)
```

## voom + limma Pipeline (RNA-seq Counts)

```python
# count_df: genes as rows, samples as columns (integer counts)
# metadata: samples as rows, design factors as columns
count_matrix = pd_to_r(count_df)
metadata_r = pd_to_r(metadata)

# --- 1. Create DGEList and normalize ---
dge = edger.DGEList(counts=count_matrix)
keep = edger.filterByExpr(dge, design=None, group=ro.StrVector(metadata["condition"]))
dge = dge.rx(keep, True)
dge = edger.calcNormFactors(dge, method="TMM")

# --- 2. Design matrix ---
design = stats.model_matrix(Formula("~ 0 + condition"), data=metadata_r)
ro.r.assign("design", design)
ro.r('colnames(design) <- gsub("condition", "", colnames(design))')
design = ro.r("design")

# --- 3. voom transformation ---
v = limma.voom(dge, design, plot=False)

# --- 4. Fit linear model ---
fit = limma.lmFit(v, design)

# --- 5. Define and apply contrasts ---
contrast_matrix = limma.makeContrasts(
    **{"treat-ctrl": "treat - ctrl"},
    levels=design,
)
fit2 = limma.contrasts_fit(fit, contrast_matrix)

# --- 6. Empirical Bayes moderation ---
fit2 = limma.eBayes(fit2)

# --- 7. Extract results ---
top = limma.topTable(fit2, coef="treat - ctrl", number=ro.r("Inf"), sort_by="P")
top_df = r_to_pd(top)
```

## Key Function Signatures

### voom

```python
v = limma.voom(
    counts,                    # DGEList | matrix — raw counts
    design=None,               # design matrix | None
    lib_size=None,             # library sizes | None (computed from DGEList if None)
    normalize_method="none",   # "none" | "scale" | "quantile" | "cyclicloess"
    span=0.5,                  # float — loess span for mean-variance trend
    plot=False,                # bool — plot mean-variance trend
    save_plot=False,           # bool — save plot coordinates
)
# Returns an EList with: E (log2-CPM), weights (precision weights), design, genes
```

### voomWithQualityWeights (Heterogeneous Sample Quality)

```python
# Drop-in replacement for voom; adds per-sample quality weights
v = limma.voomWithQualityWeights(counts, design, plot=False)
```

### lmFit

```python
fit = limma.lmFit(
    v,                         # EList (from voom) | matrix | ExpressionSet
    design=None,               # design matrix (taken from object if None)
    block=None,                # factor for blocking/repeated measures
    correlation=None,          # float — inter-duplicate correlation (from duplicateCorrelation)
    weights=None,              # matrix of precision weights | None
    method="ls",               # "ls" (least squares) | "robust"
)
```

### makeContrasts

```python
# Named contrasts using keyword arguments
contrast_matrix = limma.makeContrasts(
    **{
        "treat-ctrl": "treat - ctrl",
        "drugA-drugB": "drugA - drugB",
    },
    levels=design,
)

# Single contrast as positional string
contrast_matrix = limma.makeContrasts("treat - ctrl", levels=design)
```

### contrasts.fit

```python
fit2 = limma.contrasts_fit(
    fit,                       # MArrayLM from lmFit
    contrasts=contrast_matrix, # contrast matrix from makeContrasts
)
```

### eBayes

```python
fit2 = limma.eBayes(
    fit2,                      # MArrayLM from contrasts.fit or lmFit
    proportion=0.01,           # float — expected proportion of DE genes
    stdev_coef_lim=ro.FloatVector([0.1, 4]),  # bounds on std dev coefficients
    trend=False,               # bool — model variance trend on abundance
    robust=False,              # bool — robust empirical Bayes
)
```

### topTable

```python
top = limma.topTable(
    fit2,                      # MArrayLM after eBayes
    coef=None,                 # str | int | vector — coefficient(s) or contrast name
    number=ro.r("Inf"),        # int — max rows to return (Inf = all)
    genelist=None,             # data.frame of gene annotation | None
    adjust_method="BH",        # "BH" | "bonferroni" | "holm" | etc.
    sort_by="B",               # "logFC" | "AveExpr" | "t" | "P" | "p" | "B" | "none"
    resort_by=None,            # secondary sort
    p_value=1.0,               # float — cutoff for adjusted p-value
    lfc=0,                     # float — minimum |logFC| cutoff (post-hoc filter, NOT a test)
    confint=False,             # bool | float — confidence intervals for logFC
)
# Result columns: logFC, AveExpr, t, P.Value, adj.P.Val, B
```

## Repeated Measures / Blocking (duplicateCorrelation)

```python
# For subjects measured multiple times (e.g., paired samples, time series)
# Must run voom TWICE: first without correlation, then with

# First pass: voom without blocking
v_tmp = limma.voom(dge, design, plot=False)

# Estimate intra-block correlation
block_factor = ro.FactorVector(metadata["patient_id"])
corfit = limma.duplicateCorrelation(v_tmp, design, block=block_factor)
consensus_corr = corfit.rx2("consensus.correlation")[0]

# Second pass: voom WITH blocking correlation
v = limma.voom(dge, design, plot=False, block=block_factor, correlation=consensus_corr)

# Fit with blocking
fit = limma.lmFit(v, design, block=block_factor, correlation=consensus_corr)
fit2 = limma.contrasts_fit(fit, contrast_matrix)
fit2 = limma.eBayes(fit2)
```

## Microarray Pipeline (No voom)

```python
# For log2-transformed microarray data (e.g., from RMA normalization)
# expr_matrix: genes as rows, samples as columns, already log2-scale

expr_r = pd_to_r(expr_df)
design = stats.model_matrix(Formula("~ 0 + condition"), data=metadata_r)

fit = limma.lmFit(expr_r, design)
contrast_matrix = limma.makeContrasts(**{"treat-ctrl": "treat - ctrl"}, levels=design)
fit2 = limma.contrasts_fit(fit, contrast_matrix)
fit2 = limma.eBayes(fit2)

top = limma.topTable(fit2, coef="treat - ctrl", number=ro.r("Inf"))
```

## Multi-Factor Design with Interaction

```python
design = stats.model_matrix(
    Formula("~ 0 + genotype:treatment"),
    data=metadata_r,
)
# Column names: genotypeWT:treatmentCtrl, genotypeWT:treatmentDrug, etc.
# Rename for cleaner contrasts:
ro.r.assign("design", design)
ro.r('colnames(design) <- gsub("genotype|treatment", "", colnames(design))')
ro.r('colnames(design) <- gsub(":", ".", colnames(design))')
design = ro.r("design")

# Interaction contrast
contrast_matrix = limma.makeContrasts(
    **{"interaction": "(Mut.Drug - Mut.Ctrl) - (WT.Drug - WT.Ctrl)"},
    levels=design,
)
```

## Gotchas

- `voom` requires raw counts (not log-transformed). Pass a DGEList or integer matrix.
- `topTable` with `lfc=` is a post-hoc filter, NOT a statistical test. Use `treat()` for threshold-based testing.
- `duplicateCorrelation` requires running voom twice: once to get initial weights, then again with the estimated correlation.
- `makeContrasts` level names must exactly match design matrix column names. Use `ro.r('colnames(design)')` to verify.
- The `contrasts_fit` function in rpy2 maps to R's `contrasts.fit` (dot replaced by underscore).
- `eBayes(trend=True)` is recommended for RNA-seq data processed with voom.
- For RNA-seq, always start from raw counts through the voom pathway. Do not pass DESeq2 normalized counts to limma.
- `topTable` `sort.by` maps to `sort_by` in rpy2 (dot to underscore conversion).
