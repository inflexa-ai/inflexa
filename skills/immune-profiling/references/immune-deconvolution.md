# Immune Deconvolution Reference

Methods for estimating immune cell composition from bulk expression
data using the immunedeconv R package (via rpy2) and Python alternatives.

## Core Imports

```python
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import anndata as ad
```

## immunedeconv (R via rpy2)

immunedeconv is an R wrapper providing a unified interface to multiple
deconvolution methods: MCP-counter, xCell, EPIC, quanTIseq,
CIBERSORTx, and TIMER.

### Setup

```python
import rpy2.robjects as ro
from rpy2.robjects import pandas2ri
from rpy2.robjects.packages import importr

pandas2ri.activate()
immunedeconv = importr("immunedeconv")
```

### Running Deconvolution

```python
def run_deconvolution(expression_df, method="mcp_counter"):
    """
    Run immune deconvolution on a bulk expression matrix.

    Parameters
    ----------
    expression_df : DataFrame
        Genes (rows) x Samples (columns). Gene names as index.
        Must be TPM or FPKM for most methods (NOT raw counts).
    method : str
        One of: "mcp_counter", "xcell", "epic", "quantiseq",
        "cibersort", "cibersort_abs", "timer".

    Returns
    -------
    DataFrame
        Cell types (rows) x Samples (columns) with estimated
        proportions or scores.
    """
    with (ro.default_converter + pandas2ri.converter).context():
        r_expr = ro.conversion.get_conversion().py2rpy(expression_df)

    result = immunedeconv.deconvolute(r_expr, method=method)

    with (ro.default_converter + pandas2ri.converter).context():
        result_df = ro.conversion.get_conversion().rpy2py(result)

    result_df = result_df.set_index("cell_type")
    return result_df
```

### Method-Specific Notes

```python
def run_multi_method(expression_df, methods=None):
    """
    Run multiple deconvolution methods and return combined results.

    Parameters
    ----------
    expression_df : DataFrame
        Genes x Samples, TPM/FPKM normalized.
    methods : list of str, optional
        Methods to run. Default: ["mcp_counter", "xcell", "epic",
        "quantiseq"].

    Returns
    -------
    dict
        {method_name: DataFrame} for each method.
    """
    if methods is None:
        methods = ["mcp_counter", "xcell", "epic", "quantiseq"]

    results = {}
    for method in methods:
        try:
            results[method] = run_deconvolution(expression_df, method)
        except Exception as e:
            print(f"Warning: {method} failed: {e}")
    return results
```

### Expression Normalization Check

```python
def validate_expression_input(expression_df):
    """
    Validate expression matrix for deconvolution input.

    Deconvolution methods expect TPM, FPKM, or linear-scale
    expression values (NOT log-transformed, NOT raw counts).

    Returns
    -------
    dict
        Validation results with warnings.
    """
    checks = {}
    max_val = expression_df.max().max()
    min_val = expression_df.min().min()

    if max_val < 30:
        checks["warning"] = (
            "Max value < 30 — data may be log-transformed. "
            "Deconvolution requires linear-scale (TPM/FPKM)."
        )
    if min_val < 0:
        checks["warning"] = (
            "Negative values detected — data appears log-transformed. "
            "Exponentiate before deconvolution: 2**x or np.exp(x)."
        )
    if max_val > 1e6:
        checks["warning"] = (
            "Very high values — data may be raw counts. "
            "Convert to TPM/FPKM before deconvolution."
        )

    checks["n_genes"] = expression_df.shape[0]
    checks["n_samples"] = expression_df.shape[1]
    checks["value_range"] = (float(min_val), float(max_val))

    return checks
```

## Python-Only Alternatives

When R/rpy2 is unavailable or problematic:

### MCP-counter (Python reimplementation)

MCP-counter uses gene expression of marker genes. A simplified
Python version uses mean expression of marker gene sets:

```python
MCP_MARKERS = {
    "T cells": ["CD3D", "CD3E", "CD3G", "CD6", "SH2D1A", "TRAT1"],
    "CD8 T cells": ["CD8A", "CD8B"],
    "Cytotoxic lymphocytes": ["GZMA", "GZMB", "GZMH", "GZMK",
                               "GNLY", "PRF1", "KLRB1", "KLRD1"],
    "NK cells": ["NCAM1", "NKG7", "KLRC1", "KLRK1"],
    "B cells": ["CD19", "MS4A1", "CD79A", "CD79B", "BLK"],
    "Monocytes": ["CD14", "CSF1R", "CD68", "FCGR1A"],
    "Macrophages/Monocytes": ["CD163", "MRC1", "MSR1", "CD68"],
    "Dendritic cells": ["ITGAX", "CD1C", "CLEC9A", "FCER1A"],
    "Neutrophils": ["FCGR3B", "CXCR2", "CSF3R", "S100A12"],
    "Fibroblasts": ["COL1A1", "COL1A2", "FAP", "PDGFRA", "PDGFRB"],
    "Endothelial cells": ["PECAM1", "VWF", "CDH5", "PLVAP"],
}


def mcp_counter_python(expression_df, markers=None):
    """
    Simplified MCP-counter scoring in pure Python.

    Parameters
    ----------
    expression_df : DataFrame
        Genes (rows) x Samples (columns). Log-scale OK for this
        scoring approach (uses relative ranking).

    Returns
    -------
    DataFrame
        Cell type scores per sample.
    """
    if markers is None:
        markers = MCP_MARKERS

    scores = {}
    available_genes = set(expression_df.index)

    for cell_type, genes in markers.items():
        found = [g for g in genes if g in available_genes]
        if len(found) >= 2:
            scores[cell_type] = expression_df.loc[found].mean(axis=0)
        else:
            scores[cell_type] = pd.Series(
                np.nan, index=expression_df.columns,
            )

    return pd.DataFrame(scores).T
```

## Visualization

### Deconvolution Results Heatmap

```python
def plot_deconvolution_heatmap(deconv_df, group_labels=None,
                                method_name="Deconvolution"):
    """
    Heatmap of immune cell proportions/scores across samples.

    Parameters
    ----------
    deconv_df : DataFrame
        Cell types (rows) x Samples (columns).
    group_labels : dict, optional
        {sample_name: group_label} for column annotation.
    method_name : str
        Name of the deconvolution method (for title).
    """
    import seaborn as sns

    fig, ax = plt.subplots(
        figsize=(max(12, len(deconv_df.columns) * 0.4), 8),
    )

    if group_labels:
        order = sorted(
            deconv_df.columns,
            key=lambda s: group_labels.get(s, ""),
        )
        deconv_df = deconv_df[order]

    sns.heatmap(
        deconv_df, cmap="YlOrRd", ax=ax, xticklabels=True,
        yticklabels=True, linewidths=0.5,
    )
    ax.set_title(f"Immune Cell Composition ({method_name})")
    ax.set_xlabel("Samples")
    ax.set_ylabel("Cell Type")
    plt.xticks(rotation=90, fontsize=7)
    plt.tight_layout()
    return fig
```

### Stacked Bar Plot

```python
def plot_deconvolution_stacked(deconv_df, group_labels=None):
    """
    Stacked bar plot of immune cell fractions per sample.
    Only meaningful for methods returning fractions (EPIC, quanTIseq).
    """
    fig, ax = plt.subplots(figsize=(max(12, len(deconv_df.columns) * 0.3), 6))

    df_t = deconv_df.T
    if group_labels:
        df_t["_group"] = df_t.index.map(
            lambda s: group_labels.get(s, ""),
        )
        df_t = df_t.sort_values("_group").drop(columns=["_group"])

    df_t.plot(kind="bar", stacked=True, ax=ax, width=0.85)
    ax.set_ylabel("Fraction")
    ax.set_xlabel("Sample")
    ax.legend(bbox_to_anchor=(1.05, 1), loc="upper left", fontsize=7)
    ax.set_title("Immune Cell Fractions")
    plt.xticks(rotation=90, fontsize=7)
    plt.tight_layout()
    return fig
```

### Method Comparison

```python
def plot_method_comparison(results_dict, cell_type="CD8 T cells"):
    """
    Compare a specific cell type across deconvolution methods.

    Parameters
    ----------
    results_dict : dict
        {method_name: DataFrame} from run_multi_method.
    cell_type : str
        Cell type to compare (must exist in at least some methods).
    """
    fig, axes = plt.subplots(
        1, len(results_dict), figsize=(5 * len(results_dict), 4),
        sharey=False,
    )
    if len(results_dict) == 1:
        axes = [axes]

    for ax, (method, df) in zip(axes, results_dict.items()):
        matching = [ct for ct in df.index if cell_type.lower() in ct.lower()]
        if matching:
            values = df.loc[matching[0]]
            ax.bar(range(len(values)), values.values, alpha=0.7)
            ax.set_title(f"{method}\n({matching[0]})")
            ax.set_xlabel("Sample")

    fig.suptitle(f"Method Comparison: {cell_type}", fontsize=13)
    plt.tight_layout()
    return fig
```

## Storing Results in AnnData

```python
def store_deconvolution_in_adata(adata, deconv_df, method_name):
    """
    Store deconvolution results in AnnData .obs columns.

    Parameters
    ----------
    adata : AnnData
        Must have sample IDs matching deconv_df columns.
    deconv_df : DataFrame
        Cell types (rows) x Samples (columns).
    method_name : str
        Method name prefix for column names.

    Returns
    -------
    AnnData
        Updated with deconvolution scores in .obs.
    """
    for cell_type in deconv_df.index:
        col_name = f"{method_name}_{cell_type}".replace(" ", "_").replace(
            "/", "_",
        )
        adata.obs[col_name] = deconv_df.loc[cell_type].reindex(
            adata.obs_names,
        ).values
    return adata
```

## Gotchas

- **Input normalization**: Most methods require TPM or FPKM, NOT raw
  counts and NOT log-transformed values. Always check with
  `validate_expression_input()` before running.
- **Gene ID format**: immunedeconv expects HGNC gene symbols. If your
  data uses Ensembl IDs, convert first (biomaRt or pymart).
- **Species**: All reference signatures are human. For mouse data,
  convert gene symbols to human orthologs first (babelgene).
- **Batch effects**: Deconvolution is sensitive to batch effects.
  Apply batch correction BEFORE deconvolution, or include batch as a
  covariate in downstream statistical models.
- **Interpretation**: MCP-counter and xCell return scores, not
  fractions. EPIC and quanTIseq return fractions. Do not compare
  absolute values across methods.
- **Small sample sizes**: With < 10 samples, deconvolution results
  are unreliable. Report this limitation.
