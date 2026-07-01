# PyDESeq2 API Reference

Pure Python implementation of the DESeq2 pipeline (v0.5.x). No R/rpy2 required.

## Critical: Input MUST Be Raw Integer Counts

PyDESeq2 expects unnormalized, non-transformed integer counts. Passing TPM, FPKM, or log-transformed values will produce invalid results silently.

## DeseqDataSet Construction

```python
from pydeseq2.dds import DeseqDataSet
from pydeseq2.ds import DeseqStats
from pydeseq2.default_inference import DefaultInference
import pandas as pd
import anndata as ad

# --- Option A: From pandas DataFrames ---
# counts_df: genes as columns, samples as rows (index = sample IDs)
# metadata: samples as rows (index = sample IDs), columns = factors
counts_df = pd.read_csv("counts.csv", index_col=0)   # shape: (n_samples, n_genes)
metadata = pd.read_csv("metadata.csv", index_col=0)   # shape: (n_samples, n_factors)

dds = DeseqDataSet(
    counts=counts_df,
    metadata=metadata,
    design="~condition",          # R-style formula string, OR use design_factors
)

# --- Option B: From AnnData ---
# adata.X must contain raw integer counts
# adata.obs must contain sample metadata
adata = ad.read_h5ad("counts.h5ad")
dds = DeseqDataSet(
    adata=adata,
    design_factors="condition",   # single factor name or list of names
)
```

### DeseqDataSet Constructor — Key Parameters

```python
DeseqDataSet(
    *,
    adata=None,                    # AnnData | None — if provided, counts/metadata ignored
    counts=None,                   # pd.DataFrame | None — samples x genes
    metadata=None,                 # pd.DataFrame | None — samples x factors
    design="~condition",           # str — R-style formula (ignored if design_factors set)
    design_factors=None,           # str | list[str] | None — column name(s) from metadata
    continuous_factors=None,       # list[str] | None — which factors are continuous
    ref_level=None,                # list[str] | None — ["factor_name", "reference_level"]
    refit_cooks=True,              # bool — refit genes with high Cook's distances
    n_cpus=None,                   # int | None — parallelism
    quiet=False,                   # bool — suppress progress messages
)
```

## Multi-Factor Designs

```python
# Two-factor design with interaction
dds = DeseqDataSet(
    counts=counts_df,
    metadata=metadata,
    design="~batch + condition",
    ref_level=["condition", "control"],  # set reference level
)

# With continuous covariate
dds = DeseqDataSet(
    counts=counts_df,
    metadata=metadata,
    design_factors=["age", "condition"],
    continuous_factors=["age"],
    ref_level=["condition", "control"],
)
```

## Running the Pipeline

```python
# --- One-shot pipeline (recommended) ---
dds.deseq2()
# Signature: dds.deseq2(alpha=0.05, lfc_threshold=0.0, cooks_filter=True,
#                        independent_filtering=True, format_results=True)

# --- Step-by-step (for custom control) ---
dds.fit_size_factors()
dds.fit_genewise_dispersions()
dds.fit_dispersion_trend()
dds.fit_dispersion_prior()
dds.fit_MAP_dispersions()
dds.fit_LFC()
dds.calculate_cooks()
dds.refit()
```

## Statistical Testing with DeseqStats

```python
# --- Basic two-group contrast ---
stat_res = DeseqStats(
    dds,
    contrast=["condition", "treated", "control"],  # [factor, numerator, denominator]
    alpha=0.05,
)
stat_res.summary()                    # runs Wald test, computes padj
results_df = stat_res.results_df      # pd.DataFrame with baseMean, log2FoldChange, etc.
```

### DeseqStats Constructor Signature

```python
DeseqStats(
    dds,                            # DeseqDataSet — must have completed deseq2()
    contrast=None,                  # list[str] | np.ndarray | None
    alpha=0.05,                     # float — significance threshold for padj
    cooks_filter=True,              # bool
    independent_filter=True,        # bool
    prior_LFC_var=None,             # np.ndarray | None — prior variance for LFCs
    lfc_null=0.0,                   # float — null hypothesis log2FC value
    alt_hypothesis=None,            # str | None — "greaterAbs"|"lessAbs"|"greater"|"less"
    inference=None,                 # Inference | None
    quiet=False,                    # bool
    n_cpus=None,                    # int | None
)
```

### Contrast Specification

```python
# List format: [factor_name, test_level, reference_level]
stat_res = DeseqStats(dds, contrast=["condition", "treated", "control"])

# NumPy array format: numeric contrast vector matching design matrix columns
import numpy as np
# Check column order first:
print(dds.obsm["design_matrix"].columns.tolist())
# e.g. ['intercept', 'condition_treated_vs_control']
contrast_vec = np.array([0, 1])  # test the second coefficient
stat_res = DeseqStats(dds, contrast=contrast_vec)
```

## LFC Shrinkage

```python
# Shrink LFCs using apeGLM-style Cauchy prior
# IMPORTANT: call summary() before lfc_shrink()
stat_res.summary()
stat_res.lfc_shrink(coeff="condition_treated_vs_control")  # must match a design column name

# Check available coefficient names:
print(dds.obsm["design_matrix"].columns.tolist())

# Access shrunk results (overwrites log2FoldChange and lfcSE in results_df)
shrunk_df = stat_res.results_df
```

### lfc_shrink() Signature

```python
stat_res.lfc_shrink(
    coeff=None,    # str — column name from dds.obsm["design_matrix"]
    adapt=True,    # bool — use MLE estimates to adapt prior (True recommended)
)
```

## LFC Threshold Testing

```python
# Test whether |log2FC| > 1 (not just != 0)
stat_res = DeseqStats(
    dds,
    contrast=["condition", "treated", "control"],
    lfc_null=1.0,              # null: |log2FC| <= 1
    alt_hypothesis="greaterAbs",  # alt: |log2FC| > 1
)
stat_res.summary()
```

## Extracting and Filtering Results

```python
results_df = stat_res.results_df

# Columns: baseMean, log2FoldChange, lfcSE, stat, pvalue, padj
sig = results_df[(results_df["padj"] < 0.05) & (results_df["log2FoldChange"].abs() > 1)]
sig_sorted = sig.sort_values("padj")

# Variance-stabilized counts for downstream (PCA, heatmaps)
dds.vst()
vst_counts = dds.layers["vst_counts"]  # np.ndarray, shape (n_samples, n_genes)
```

## Gotchas

- Counts matrix orientation: samples as ROWS, genes as COLUMNS (opposite of R DESeq2).
- `ref_level` takes a list `["factor", "level"]`, not a single string.
- `lfc_shrink()` requires a coefficient name from `dds.obsm["design_matrix"].columns`, not a contrast list.
- Call `summary()` before `lfc_shrink()` -- shrinkage requires Wald test results.
- `design_factors` overrides the `design` formula string if both are provided.
- For interaction terms, use the formula string: `design="~genotype + treatment + genotype:treatment"`.
- VST output is in `dds.layers["vst_counts"]`, not a separate object.
- When `format_results=True` in `deseq2()`, results for the last coefficient are stored on the DeseqDataSet; for custom contrasts, always create a separate DeseqStats.
