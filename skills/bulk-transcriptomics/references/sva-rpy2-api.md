# sva (Surrogate Variable Analysis) via rpy2 API Reference

sva for batch effect correction and surrogate variable estimation via rpy2. Use `ComBat_seq` for known batch correction on raw counts. Use `svaseq` for discovering unknown sources of variation in RNA-seq data.

## rpy2 Setup

```python
import pandas as pd
import numpy as np
import rpy2.robjects as ro
from rpy2.robjects import pandas2ri, Formula
from rpy2.robjects.conversion import localconverter
from rpy2.robjects.packages import importr

pandas2ri.activate()

sva = importr("sva")
stats = importr("stats")
base = importr("base")
edger = importr("edgeR")
```

## Conversion Helpers

```python
def pd_to_r(df):
    with localconverter(ro.default_converter + pandas2ri.converter):
        return ro.conversion.py2rpy(df)

def r_to_pd(r_obj):
    with localconverter(ro.default_converter + pandas2ri.converter):
        return ro.conversion.rpy2py(r_obj)

def pd_to_r_matrix(df):
    """Convert pandas DataFrame to R matrix (required by sva functions)."""
    r_df = pd_to_r(df)
    return base.as_matrix(r_df)
```

## ComBat_seq: Batch Correction for Raw Counts

Adjusts for known batch effects while preserving integer nature of count data. Output is directly compatible with DESeq2, edgeR, and limma-voom.

```python
# count_df: genes as rows, samples as columns (raw integer counts)
# batch: list of batch labels per sample, e.g. ["batch1","batch1","batch2","batch2"]
# group: list of biological condition labels per sample

count_matrix = pd_to_r_matrix(count_df)
batch_vec = ro.StrVector(batch)

# --- Basic: correct for batch only ---
adjusted_counts = sva.ComBat_seq(
    counts=count_matrix,
    batch=batch_vec,
)

# --- With biological condition preserved ---
group_vec = ro.StrVector(group)
adjusted_counts = sva.ComBat_seq(
    counts=count_matrix,
    batch=batch_vec,
    group=group_vec,
)

# Convert back to pandas
adj_df = r_to_pd(base.as_data_frame(adjusted_counts))
adj_df.index = count_df.index
adj_df.columns = count_df.columns
```

### ComBat_seq Signature

```python
sva.ComBat_seq(
    counts,                    # integer matrix, genes x samples (raw counts)
    batch,                     # vector/factor — batch labels per sample
    group=ro.NULL,             # vector/factor | NULL — biological condition
    covar_mod=ro.NULL,         # model matrix | NULL — additional covariates to preserve
    full_mod=True,             # bool — include group in the model
    shrink=False,              # bool — shrink parameter estimates
    shrink_disp=False,         # bool — shrink dispersion estimates
    gene_subset_n=ro.NULL,     # int | NULL — subset of genes for parameter estimation
)
# Returns: integer matrix of batch-adjusted counts (same dimensions as input)
```

### ComBat_seq with Additional Covariates

```python
# Preserve effects of multiple covariates beyond group
covar_df = metadata[["age", "sex"]]
covar_matrix = stats.model_matrix(Formula("~ age + sex"), data=pd_to_r(covar_df))

adjusted_counts = sva.ComBat_seq(
    counts=count_matrix,
    batch=batch_vec,
    group=group_vec,
    covar_mod=covar_matrix,
)
```

## svaseq: Surrogate Variables for RNA-seq

Estimates latent factors of unwanted variation (unknown batches, library prep effects, etc.) from RNA-seq count data.

```python
# count_df: genes as rows, samples as columns (raw integer counts)
# metadata: samples as rows, conditions as columns

count_matrix = pd_to_r_matrix(count_df)
metadata_r = pd_to_r(metadata)

# --- 1. Build model matrices ---
mod = stats.model_matrix(Formula("~ condition"), data=metadata_r)   # full model
mod0 = stats.model_matrix(Formula("~ 1"), data=metadata_r)          # null model

# --- 2. Estimate number of surrogate variables ---
n_sv = sva.num_sv(count_matrix, mod, method="be")
n_sv_val = int(n_sv[0])
print(f"Estimated surrogate variables: {n_sv_val}")

# --- 3. Run svaseq ---
if n_sv_val > 0:
    sv_obj = sva.svaseq(
        count_matrix,
        mod,
        mod0,
        n_sv=n_sv_val,
    )
    # Extract surrogate variable matrix
    sv_matrix = np.array(sv_obj.rx2("sv"))  # shape: (n_samples, n_sv)
else:
    sv_matrix = None
```

### svaseq Signature

```python
sva.svaseq(
    dat,                       # matrix — raw count matrix, genes x samples
    mod,                       # model matrix — full model (includes biological variable)
    mod0=ro.NULL,              # model matrix — null model (intercept only, or without bio var)
    n_sv=ro.NULL,              # int | NULL — number of SVs (estimated if NULL)
    controls=ro.NULL,          # numeric vector | NULL — probability each gene is a control
    method="irw",              # "irw" (iteratively reweighted) | "two-step" | "supervised"
    vfilter=ro.NULL,           # int | NULL — filter to this many most variable genes
    B=5,                       # int — number of iterations for irw method
    numSVmethod="be",          # "be" (Buja-Eyuboglu) | "leek"
    constant=1,                # int — added to counts before log transform
)
# Returns a list with: sv (matrix of surrogate variables), pprob.gam, pprob.b, n.sv
```

### num.sv Signature

```python
n_sv = sva.num_sv(
    dat,                       # matrix — expression/count data
    mod,                       # model matrix — full model
    method="be",               # "be" (Buja-Eyuboglu) | "leek"
    vfilter=ro.NULL,           # int | NULL — filter to most variable genes
    B=20,                      # int — number of permutations for "be" method
    seed=ro.NULL,              # int | NULL — random seed
)
# Returns integer: estimated number of surrogate variables
```

## Integrating Surrogate Variables with DE Analysis

### With DESeq2

```python
deseq2 = importr("DESeq2")

# Add SVs to column data
for i in range(n_sv_val):
    metadata[f"SV{i+1}"] = sv_matrix[:, i]

col_data_r = pd_to_r(metadata)
count_matrix_int = pd_to_r_matrix(count_df)

# Include SVs in the DESeq2 design formula
sv_terms = " + ".join([f"SV{i+1}" for i in range(n_sv_val)])
formula_str = f"~ {sv_terms} + condition"

dds = deseq2.DESeqDataSetFromMatrix(
    countData=count_matrix_int,
    colData=col_data_r,
    design=Formula(formula_str),
)
dds = deseq2.DESeq(dds)
res = deseq2.results(dds, name=deseq2.resultsNames(dds)[-1])  # last coefficient
```

### With limma-voom or edgeR

```python
# Append SVs to the design matrix (works for both limma-voom and edgeR)
sv_r = pd_to_r(pd.DataFrame(sv_matrix, columns=[f"SV{i+1}" for i in range(n_sv_val)]))
design_with_sv = base.cbind(design, sv_r)

# limma-voom: v = limma.voom(dge, design_with_sv); fit = limma.lmFit(v, design_with_sv)
# edgeR: fit = edger.glmQLFit(dge, design_with_sv, robust=True)
# Then test contrasts on the biological coefficients only
```

## ComBat (for Log-Transformed Data)

For microarray or already-normalized data (NOT raw counts -- use ComBat_seq for counts).

```python
# expr_matrix: genes x samples, log2-scale (e.g., from RMA)
expr_r = pd_to_r_matrix(expr_df)
batch_vec = ro.StrVector(batch)

# Design matrix for biological condition to preserve
mod = stats.model_matrix(Formula("~ condition"), data=pd_to_r(metadata))

adjusted_expr = sva.ComBat(
    dat=expr_r,
    batch=batch_vec,
    mod=mod,
    par_prior=True,     # True = parametric empirical Bayes (default, recommended)
    mean_only=False,     # True = only adjust mean, not variance
)

adj_expr_df = r_to_pd(base.as_data_frame(adjusted_expr))
adj_expr_df.index = expr_df.index
adj_expr_df.columns = expr_df.columns
```

## Gotchas

- `ComBat_seq` expects raw integer counts. `ComBat` (without `_seq`) expects log-transformed continuous data.
- `ComBat_seq` output preserves integer counts and is directly compatible with DESeq2/edgeR.
- `svaseq` applies an internal log transform (`log(counts + constant)`). Do NOT pre-transform the input.
- The `group` parameter in `ComBat_seq` protects biological signal. Omitting it risks removing real biological variation along with batch effects.
- `num_sv` in rpy2 maps to R's `num.sv` (dot to underscore). Similarly `ComBat_seq` maps from R's `ComBat_seq`.
- For designs with confounded batch and condition (all samples of one condition in one batch), neither ComBat_seq nor svaseq can fully separate the effects. Check for confounding before correction.
- `svaseq` can return 0 surrogate variables. Always check `n_sv` before proceeding.
- Model matrices (`mod`, `mod0`) must have the same number of rows (samples) as columns in the count matrix.
- The `controls` parameter in `svaseq` enables supervised SV estimation when negative control genes (e.g., housekeeping genes) are known.
