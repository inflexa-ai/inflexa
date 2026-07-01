# edgeR via rpy2 API Reference

edgeR for differential expression via rpy2. Preferred over DESeq2 for small sample sizes (n < 3 per group) and when quasi-likelihood F-tests are desired.

## rpy2 Setup

```python
import pandas as pd
import numpy as np
import rpy2.robjects as ro
from rpy2.robjects import pandas2ri, Formula
from rpy2.robjects.conversion import localconverter
from rpy2.robjects.packages import importr

pandas2ri.activate()

edger = importr("edgeR")
stats = importr("stats")
base = importr("base")
limma = importr("limma")
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

## Standard QL F-test Pipeline

```python
# count_df: genes as rows, samples as columns (pd.DataFrame, integer counts)
# group: list/array of group labels per sample, e.g. ["ctrl","ctrl","treat","treat"]

count_matrix = pd_to_r(count_df)
group_vec = ro.StrVector(group)

# --- 1. Create DGEList ---
dge = edger.DGEList(
    counts=count_matrix,
    group=group_vec,
)

# --- 2. Filter low-expression genes ---
keep = edger.filterByExpr(dge)
dge = dge.rx(keep, True)  # R: dge[keep, ]

# --- 3. Normalize (TMM by default) ---
dge = edger.calcNormFactors(dge, method="TMM")

# --- 4. Design matrix ---
design = stats.model_matrix(Formula("~ 0 + group"), data=ro.DataFrame({"group": group_vec}))
# Rename columns: "group" prefix is auto-added
ro.r.assign("design", design)
ro.r('colnames(design) <- gsub("group", "", colnames(design))')
design = ro.r("design")

# --- 5. Estimate dispersions + fit QL model ---
# edgeR v4: glmQLFit estimates dispersions automatically
fit = edger.glmQLFit(dge, design, robust=True)

# --- 6. Test contrast ---
contrast = limma.makeContrasts(
    **{"treat-ctrl": "treat - ctrl"},
    levels=design,
)
qlf = edger.glmQLFTest(fit, contrast=contrast)

# --- 7. Extract results ---
top = edger.topTags(qlf, n=ro.r("Inf"), sort_by="PValue")
top_df = r_to_pd(base.as_data_frame(top))
top_df.index = list(ro.r("rownames")(top.rx2("table")))
```

## DGEList Constructor

```python
edger.DGEList(
    counts=count_matrix,      # integer matrix, genes x samples
    group=group_vec,          # factor/character vector of group labels
    lib_size=None,            # numeric vector | None (computed from colSums if None)
    norm_factors=None,        # numeric vector | None
    samples=None,             # data.frame of sample info | None
    genes=None,               # data.frame of gene info | None
    remove_zeros=False,       # bool — remove genes with zero counts in all samples
)
```

## Key Function Signatures

### filterByExpr

```python
keep = edger.filterByExpr(
    dge,                      # DGEList
    design=None,              # design matrix | None (uses dge$samples$group if None)
    group=None,               # group factor | None
    lib_size=None,            # library sizes | None
    min_count=10,             # int — minimum count threshold
    min_total_count=15,       # int — minimum total count across samples
    large_n=10,               # int — definition of "large" group
    min_prop=0.7,             # float — minimum proportion of samples in smallest group
)
```

### calcNormFactors

```python
dge = edger.calcNormFactors(
    dge,
    method="TMM",             # "TMM" | "TMMwsp" | "RLE" | "upperquartile" | "none"
)
```

### glmQLFit (edgeR v4 -- estimates dispersions automatically)

```python
fit = edger.glmQLFit(
    dge,                      # DGEList (with or without prior estimateDisp)
    design,                   # design matrix
    robust=True,              # bool — robust estimation of prior df (recommended)
    abundance_trend=True,     # bool — model QL dispersion trend on abundance
)
# In edgeR v4, glmQLFit handles dispersion estimation internally.
# Explicit estimateDisp() is no longer required but still works.
```

### Legacy Dispersion Estimation (pre-v4 or explicit control)

```python
dge = edger.estimateDisp(dge, design, robust=True)
# Runs estimateGLMCommonDisp, estimateGLMTrendedDisp, estimateGLMTagwiseDisp
```

### glmQLFTest

```python
qlf = edger.glmQLFTest(
    fit,                      # DGEGLM from glmQLFit
    coef=None,                # int | str | vector — coefficient(s) to test
    contrast=None,            # numeric vector/matrix — contrast to test
    poisson_bound=True,       # bool — bound QL dispersion by Poisson limit
)
# Specify either coef= or contrast=, not both.
```

### topTags

```python
top = edger.topTags(
    qlf,                      # DGEQLF result
    n=ro.r("Inf"),            # number of genes to return (Inf = all)
    adjust_method="BH",       # "BH" | "bonferroni" | "holm" | etc.
    sort_by="PValue",         # "PValue" | "logFC" | "logCPM" | "F" | "none"
    p_value=1.0,              # float — only return genes with p <= this
)
# Result columns: logFC, logCPM, F, PValue, FDR
```

## Multi-Factor Designs

```python
# Two-factor design
metadata_r = pd_to_r(metadata)
design = stats.model_matrix(Formula("~ 0 + condition + batch"), data=metadata_r)
ro.r.assign("design", design)
ro.r('colnames(design) <- gsub("condition", "", colnames(design))')
design = ro.r("design")

fit = edger.glmQLFit(dge, design, robust=True)

# Test condition effect adjusting for batch
contrast = limma.makeContrasts(
    **{"treat-ctrl": "treat - ctrl"},
    levels=design,
)
qlf = edger.glmQLFTest(fit, contrast=contrast)
```

## Classic Exact Test (Two-Group Only)

```python
# Simpler but limited to exactly two groups, no covariates
dge = edger.DGEList(counts=count_matrix, group=group_vec)
dge = edger.calcNormFactors(dge)
dge = edger.estimateDisp(dge)

et = edger.exactTest(dge, pair=ro.StrVector(["ctrl", "treat"]))
top = edger.topTags(et, n=ro.r("Inf"))
```

## Extracting Normalized Counts

```python
# CPM (counts per million) — for visualization
cpm_mat = edger.cpm(dge, log=False, normalized_lib_sizes=True)
cpm_df = r_to_pd(base.as_data_frame(cpm_mat))
cpm_df.index = list(ro.r("rownames")(cpm_mat))

# logCPM
logcpm_mat = edger.cpm(dge, log=True, prior_count=2)
```

## Gotchas

- edgeR v4 `glmQLFit` estimates dispersions automatically; explicit `estimateDisp()` is optional but still supported.
- `filterByExpr` should be called BEFORE `calcNormFactors`. Filtering after normalization wastes computation.
- `makeContrasts` from limma is used with edgeR. The levels must match design matrix column names exactly.
- When using `Formula("~ 0 + group")`, column names get prefixed with the variable name (e.g., "groupctrl"). Rename them for cleaner contrast syntax.
- `topTags` returns a TopTags object. Access the table via `top.rx2("table")` for row names, or convert the whole object with `as.data.frame`.
- edgeR's count matrix is genes-as-rows, samples-as-columns (standard R orientation).
- For paired designs, include the pairing factor in the design matrix: `~ 0 + condition + patient`.
- edgeR is often preferred for small sample sizes (2-3 per group) where DESeq2 shrinkage can be overly conservative.
