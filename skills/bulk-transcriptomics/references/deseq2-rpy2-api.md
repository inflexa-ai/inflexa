# DESeq2 via rpy2 API Reference

R DESeq2 called from Python via rpy2. Prefer this over PyDESeq2 when you need: apeglm shrinkage with lfcThreshold, complex interaction contrasts, or LRT testing.

## rpy2 Setup Boilerplate

```python
import numpy as np
import pandas as pd
import rpy2.robjects as ro
from rpy2.robjects import pandas2ri, Formula
from rpy2.robjects.conversion import localconverter
from rpy2.robjects.packages import importr

# Activate pandas <-> R DataFrame conversion
pandas2ri.activate()

# Import R packages
deseq2 = importr("DESeq2")
stats = importr("stats")
base = importr("base")
grdevices = importr("grDevices")
```

## pandas to R Conversion Patterns

```python
# Convert pandas DataFrame -> R data.frame
def pd_to_r(df):
    with localconverter(ro.default_converter + pandas2ri.converter):
        return ro.conversion.py2rpy(df)

# Convert R object -> pandas DataFrame
def r_to_pd(r_obj):
    with localconverter(ro.default_converter + pandas2ri.converter):
        return ro.conversion.rpy2py(r_obj)

# Convert R matrix/DataFrame to pandas (for DESeq2 results)
def deseq2_results_to_pd(r_res):
    # as.data.frame() ensures proper conversion from S4 DESeqResults
    r_df = base.as_data_frame(r_res)
    df = r_to_pd(r_df)
    df.index = list(base.rownames(r_res))
    return df
```

## DESeqDataSetFromMatrix

```python
# count_df: genes as rows, samples as columns (standard bioinformatics orientation)
# col_data: samples as rows, columns = experimental factors
count_matrix = pd_to_r(count_df.T) if count_df.shape[0] < count_df.shape[1] else pd_to_r(count_df)
col_data_r = pd_to_r(col_data)

# Ensure count matrix is integer
count_matrix = base.as_matrix(count_matrix)
count_matrix = ro.r("function(x) { storage.mode(x) <- 'integer'; x }")(count_matrix)

dds = deseq2.DESeqDataSetFromMatrix(
    countData=count_matrix,      # integer matrix, genes x samples
    colData=col_data_r,          # data.frame, samples x factors
    design=Formula("~ condition"),  # R formula object
)
```

### Setting Reference Level

```python
# Set reference level BEFORE running DESeq()
dds.slots["colData"] = ro.r('''
    function(dds, factor_name, ref_level) {
        colData(dds)[[factor_name]] <- relevel(factor(colData(dds)[[factor_name]]), ref=ref_level)
        colData(dds)
    }
''')(dds, "condition", "control")

# Or more directly:
ro.r.assign("dds", dds)
ro.r('dds$condition <- relevel(factor(dds$condition), ref="control")')
dds = ro.r("dds")
```

## Running DESeq

```python
# Standard Wald test (default)
dds = deseq2.DESeq(dds)                          # test="Wald", fitType="parametric"

# Likelihood ratio test (for multi-level factors, time series)
dds = deseq2.DESeq(dds, test="LRT", reduced=Formula("~ 1"))

# With parallelization
biocparallel = importr("BiocParallel")
dds = deseq2.DESeq(dds, parallel=True, BPPARAM=biocparallel.MulticoreParam(4))
```

## Extracting Results

```python
# Check available coefficient names
result_names = list(deseq2.resultsNames(dds))
# e.g. ['Intercept', 'condition_treated_vs_control']

# Basic results (last coefficient by default)
res = deseq2.results(dds, alpha=0.05)

# Specific contrast: character vector form
res = deseq2.results(
    dds,
    contrast=ro.StrVector(["condition", "treated", "control"]),
    alpha=0.05,
)

# Named coefficient
res = deseq2.results(dds, name="condition_treated_vs_control", alpha=0.05)
```

### results() Key Parameters

```python
res = deseq2.results(
    dds,
    contrast=ro.StrVector(["factor", "numerator", "denominator"]),  # OR name=
    name=None,                  # str — coefficient name from resultsNames(dds)
    lfcThreshold=0,             # float — test |LFC| > threshold (not a filter)
    altHypothesis="greaterAbs", # "greaterAbs"|"lessAbs"|"greater"|"less"
    alpha=0.1,                  # float — FDR cutoff for independent filtering
    independentFiltering=True,  # bool
    pAdjustMethod="BH",        # str — "BH", "bonferroni", "holm", etc.
)
```

## LFC Shrinkage with apeglm

```python
# apeglm requires coef= (coefficient name or index), NOT contrast=
res_shrunk = deseq2.lfcShrink(
    dds,
    coef="condition_treated_vs_control",  # must match resultsNames(dds)
    type="apeglm",
)

# apeglm with lfcThreshold (test H0: |LFC| <= threshold with shrinkage)
res_shrunk = deseq2.lfcShrink(
    dds,
    coef="condition_treated_vs_control",
    type="apeglm",
    lfcThreshold=1.0,   # s-values returned instead of p-values
    svalue=True,
)
```

### lfcShrink() Key Parameters

```python
deseq2.lfcShrink(
    dds,
    coef=None,         # str | int — coefficient name/index; REQUIRED for apeglm
    contrast=None,     # StrVector — only works with type="ashr" or "normal"
    type="apeglm",     # "apeglm" (preferred) | "ashr" | "normal"
    lfcThreshold=0,    # float — test against this threshold
    svalue=False,      # bool — return s-values instead of p-values
    apeAdapt=True,     # bool — adapt prior using MLE estimates
)
```

### When to Use Which Shrinkage Type

- `apeglm`: Best default. Requires `coef=`. Cannot use `contrast=`.
- `ashr`: Supports `contrast=`. Use when you need arbitrary contrasts with shrinkage.
- `normal`: Legacy method. Supports both `coef=` and `contrast=`.

## Converting Results to pandas

```python
# Extract results as pandas DataFrame
res_df = deseq2_results_to_pd(res)
# Columns: baseMean, log2FoldChange, lfcSE, stat, pvalue, padj

# Filter significant genes
sig = res_df[(res_df["padj"] < 0.05) & (res_df["log2FoldChange"].abs() > 1)]
sig = sig.sort_values("padj")
```

## Normalized and Transformed Counts

```python
# Normalized counts (for visualization, NOT for DE input)
norm_counts_r = deseq2.counts_DESeqDataSet(dds, normalized=True)
norm_df = r_to_pd(base.as_data_frame(norm_counts_r))
norm_df.index = list(base.rownames(norm_counts_r))

# VST (variance stabilizing transformation)
vsd = deseq2.vst(dds, blind=False)
vst_mat = ro.r("function(x) assay(x)")(vsd)
vst_df = r_to_pd(base.as_data_frame(vst_mat))
vst_df.index = list(base.rownames(vst_mat))

# rlog (slower but better for small sample sizes, n < 20)
rld = deseq2.rlog(dds, blind=False)
```

## Multi-Factor and Interaction Designs

```python
# Two-factor with interaction
dds = deseq2.DESeqDataSetFromMatrix(
    countData=count_matrix,
    colData=col_data_r,
    design=Formula("~ genotype + treatment + genotype:treatment"),
)
dds = deseq2.DESeq(dds)

# Test interaction term
print(list(deseq2.resultsNames(dds)))
# ['Intercept', 'genotype_mutant_vs_wt', 'treatment_drug_vs_ctrl',
#  'genotypemutant.treatmentdrug']
res_interaction = deseq2.results(dds, name="genotypemutant.treatmentdrug")

# For arbitrary contrasts with shrinkage, use ashr:
res_shrunk = deseq2.lfcShrink(
    dds,
    contrast=ro.StrVector(["treatment", "drug", "ctrl"]),
    type="ashr",
)
```

## Gotchas

- `apeglm` only works with `coef=`, never with `contrast=`. Use `ashr` for contrast-based shrinkage.
- Count matrix in R is genes-as-rows (opposite of PyDESeq2 which expects genes-as-columns).
- Always call `relevel()` to set the reference BEFORE `DESeq()`. Changing after requires re-running.
- `lfcThreshold` in `results()` performs a statistical test against the threshold. It does NOT post-hoc filter by fold change.
- `storage.mode` of count matrix must be "integer". Floats will cause a hard error.
- `resultsNames()` returns names like `condition_B_vs_A` (factor_level_vs_reference). The exact naming depends on factor levels.
- Memory: rpy2 holds R objects in R's memory space. Call `ro.r("gc()")` after large analyses.
- `Formula("~ condition")` requires `from rpy2.robjects import Formula`.
