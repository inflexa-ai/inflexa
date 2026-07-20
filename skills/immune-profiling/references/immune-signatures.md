# Immune Signature Scoring Reference

Curated immune gene signatures, scoring methods, checkpoint
expression analysis, and TCR/BCR diversity metrics.

## Core Imports

```python
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import anndata as ad
```

## Immune Signature Definitions

### Tumor Inflammation Signature (TIS, 18-gene)

Validated IO response predictor across tumor types (Ayers et al.,
J Clin Invest, 2017).

```python
TIS_GENES = [
    "CCL5", "CD27", "CD274", "CD276", "CD8A", "CMKLR1", "CXCL9",
    "CXCR6", "HLA-DQA1", "HLA-DRB1", "HLA-E", "IDO1", "LAG3",
    "NKG7", "PDCD1LG2", "PSMB10", "STAT1", "TIGIT",
]
```

### Interferon-Gamma Signature (6-gene, expanded 10-gene)

```python
IFNG_6_GENES = ["CXCL10", "CXCL9", "HLA-DRA", "IDO1", "IFNG", "STAT1"]

IFNG_10_GENES = [
    "CXCL10", "CXCL9", "HLA-DRA", "IDO1", "IFNG", "STAT1",
    "CCR5", "CXCL11", "GZMA", "PRF1",
]
```

### Cytolytic Activity (CYT)

Geometric mean of GZMA and PRF1 (Rooney et al., Cell, 2015).

```python
CYT_GENES = ["GZMA", "PRF1"]
```

### T Cell Exhaustion Signature

```python
EXHAUSTION_GENES = [
    "PDCD1", "LAG3", "HAVCR2", "TIGIT", "CTLA4", "TOX", "ENTPD1",
]
```

### Immune Checkpoint Panel

```python
CHECKPOINT_GENES = {
    "Inhibitory": [
        "PDCD1",      # PD-1
        "CD274",      # PD-L1
        "PDCD1LG2",   # PD-L2
        "CTLA4",
        "LAG3",
        "HAVCR2",     # TIM-3
        "TIGIT",
        "VSIR",       # VISTA
        "IDO1",
        "BTLA",
    ],
    "Stimulatory": [
        "TNFRSF9",    # 4-1BB
        "TNFRSF4",    # OX40
        "ICOS",
        "CD28",
        "CD40LG",
        "TNFRSF18",   # GITR
    ],
}
```

### M1/M2 Macrophage Polarization

```python
M1_GENES = ["NOS2", "TNF", "IL1B", "IL6", "CD80", "CD86", "IRF5"]
M2_GENES = ["MRC1", "CD163", "MSR1", "ARG1", "IL10", "TGFB1", "IRF4"]
```

## Signature Scoring Methods

### Mean Z-Score

```python
def score_signature_zscore(expression_df, gene_list, signature_name):
    """
    Score samples using mean z-score of signature genes.

    Parameters
    ----------
    expression_df : DataFrame
        Genes (rows) x Samples (columns). Log-transformed expression.
    gene_list : list of str
        Gene symbols in the signature.
    signature_name : str
        Name for the resulting score column.

    Returns
    -------
    Series
        Per-sample signature scores.
    """
    available = [g for g in gene_list if g in expression_df.index]
    if len(available) < 2:
        raise ValueError(
            f"Only {len(available)}/{len(gene_list)} signature genes "
            f"found in expression data"
        )

    subset = expression_df.loc[available]
    zscored = subset.subtract(subset.mean(axis=1), axis=0).divide(
        subset.std(axis=1), axis=0,
    )
    scores = zscored.mean(axis=0)
    scores.name = signature_name
    return scores
```

### Cytolytic Activity (Geometric Mean)

```python
def score_cytolytic_activity(expression_df):
    """
    Compute CYT score as geometric mean of GZMA and PRF1.
    Input must be linear-scale (TPM/FPKM), NOT log-transformed.
    """
    for gene in CYT_GENES:
        if gene not in expression_df.index:
            raise ValueError(f"{gene} not found in expression data")

    gzma = expression_df.loc["GZMA"].clip(lower=1e-6)
    prf1 = expression_df.loc["PRF1"].clip(lower=1e-6)
    cyt = np.sqrt(gzma * prf1)
    cyt.name = "CYT_score"
    return cyt
```

### ssGSEA via gseapy

```python
def score_signatures_ssgsea(expression_df, signatures_dict):
    """
    Score multiple signatures using ssGSEA via gseapy.

    Parameters
    ----------
    expression_df : DataFrame
        Genes (rows) x Samples (columns).
    signatures_dict : dict
        {signature_name: [gene_list]}.

    Returns
    -------
    DataFrame
        Signatures (rows) x Samples (columns) with NES scores.
    """
    import gseapy

    result = gseapy.ssgsea(
        data=expression_df,
        gene_sets=signatures_dict,
        outdir=None,
        no_plot=True,
        min_size=3,
    )
    return result.res2d.pivot(
        index="Term", columns="Name", values="NES",
    )
```

### decoupler Scoring

```python
def score_signatures_decoupler(adata, signatures_dict,
                                method="ulm"):
    """
    Score signatures using decoupler's run_ulm or run_mlm.

    Parameters
    ----------
    adata : AnnData
        Expression data (samples x genes).
    signatures_dict : dict
        {signature_name: [gene_list]}.
    method : str
        "ulm" for univariate linear model, "mlm" for multivariate.

    Returns
    -------
    AnnData
        Updated in place: decoupler writes the scores and p-values into
        .obsm (keyed per method, e.g. "ulm_estimate" / "ulm_pvals").
        Check the keys after the call rather than assuming a name.
    """
    import decoupler as dc

    net = []
    for sig_name, genes in signatures_dict.items():
        for gene in genes:
            net.append({"source": sig_name, "target": gene, "weight": 1.0})
    net_df = pd.DataFrame(net)

    if method == "ulm":
        dc.run_ulm(adata, net=net_df, source="source", target="target",
                    weight="weight", use_raw=False)
    else:
        dc.run_mlm(adata, net=net_df, source="source", target="target",
                    weight="weight", use_raw=False)

    return adata
```

## Scoring Multiple Signatures at Once

```python
def score_all_immune_signatures(expression_df):
    """
    Score a panel of standard immune signatures.

    Parameters
    ----------
    expression_df : DataFrame
        Genes (rows) x Samples (columns). Log-transformed.

    Returns
    -------
    DataFrame
        Samples (rows) x Signatures (columns).
    """
    signatures = {
        "TIS": TIS_GENES,
        "IFNg_6": IFNG_6_GENES,
        "IFNg_10": IFNG_10_GENES,
        "Exhaustion": EXHAUSTION_GENES,
        "M1_macrophage": M1_GENES,
        "M2_macrophage": M2_GENES,
    }

    scores = {}
    for name, genes in signatures.items():
        try:
            scores[name] = score_signature_zscore(
                expression_df, genes, name,
            )
        except ValueError as e:
            print(f"Warning: {name} — {e}")

    return pd.DataFrame(scores)
```

## Checkpoint Expression Visualization

```python
def plot_checkpoint_heatmap(expression_df, group_labels,
                             checkpoints=None):
    """
    Heatmap of checkpoint gene expression across samples.

    Parameters
    ----------
    expression_df : DataFrame
        Genes (rows) x Samples (columns).
    group_labels : dict
        {sample: group} for annotation.
    checkpoints : dict, optional
        {category: [genes]}. Default: CHECKPOINT_GENES.
    """
    import seaborn as sns

    if checkpoints is None:
        checkpoints = CHECKPOINT_GENES

    all_genes = []
    gene_categories = {}
    for cat, genes in checkpoints.items():
        for g in genes:
            if g in expression_df.index:
                all_genes.append(g)
                gene_categories[g] = cat

    if not all_genes:
        raise ValueError("No checkpoint genes found in expression data")

    subset = expression_df.loc[all_genes]
    zscored = subset.subtract(subset.mean(axis=1), axis=0).divide(
        subset.std(axis=1), axis=0,
    )

    col_order = sorted(
        zscored.columns, key=lambda s: group_labels.get(s, ""),
    )
    zscored = zscored[col_order]

    fig, ax = plt.subplots(
        figsize=(max(10, len(col_order) * 0.35), len(all_genes) * 0.4 + 2),
    )
    sns.heatmap(
        zscored, cmap="RdBu_r", center=0, ax=ax, xticklabels=True,
        yticklabels=True, linewidths=0.5,
    )
    ax.set_title("Immune Checkpoint Expression (z-scored)")
    plt.xticks(rotation=90, fontsize=7)
    plt.tight_layout()
    return fig
```

## TCR/BCR Repertoire Diversity Metrics

```python
def compute_repertoire_diversity(clonotype_counts):
    """
    Compute repertoire diversity metrics from clonotype frequencies.

    Parameters
    ----------
    clonotype_counts : array-like
        Number of cells per clonotype (e.g., [50, 30, 10, 5, 5]).

    Returns
    -------
    dict
        Diversity metrics.
    """
    counts = np.asarray(clonotype_counts, dtype=float)
    counts = counts[counts > 0]
    total = counts.sum()
    freqs = counts / total
    n_clonotypes = len(counts)

    shannon = -np.sum(freqs * np.log2(freqs))
    max_entropy = np.log2(n_clonotypes) if n_clonotypes > 1 else 1
    evenness = shannon / max_entropy if max_entropy > 0 else 0

    simpson = np.sum(freqs ** 2)
    inv_simpson = 1 / simpson if simpson > 0 else 0

    sorted_counts = np.sort(counts)[::-1]
    cumulative = np.cumsum(sorted_counts) / total
    gini = (n_clonotypes + 1) / n_clonotypes - 2 * np.sum(
        (np.arange(1, n_clonotypes + 1) * sorted_counts),
    ) / (n_clonotypes * total)

    top1_fraction = sorted_counts[0] / total
    top10_fraction = sorted_counts[:10].sum() / total if n_clonotypes >= 10 else 1.0

    return {
        "n_clonotypes": n_clonotypes,
        "total_cells": int(total),
        "shannon_entropy": float(shannon),
        "normalized_entropy": float(evenness),
        "simpson_index": float(simpson),
        "inverse_simpson": float(inv_simpson),
        "gini_index": float(max(0, gini)),
        "top1_clonal_fraction": float(top1_fraction),
        "top10_clonal_fraction": float(top10_fraction),
    }
```

### Repertoire Overlap

```python
def repertoire_overlap(clonotypes_a, clonotypes_b, metric="jaccard"):
    """
    Compute repertoire overlap between two samples.

    Parameters
    ----------
    clonotypes_a, clonotypes_b : set or dict
        Sets of clonotype IDs, or dicts {clonotype: count}.
    metric : str
        "jaccard" or "morisita_horn".

    Returns
    -------
    float
        Overlap score (0 = no overlap, 1 = identical).
    """
    if isinstance(clonotypes_a, dict):
        set_a = set(clonotypes_a.keys())
        set_b = set(clonotypes_b.keys())
    else:
        set_a = set(clonotypes_a)
        set_b = set(clonotypes_b)

    if metric == "jaccard":
        intersection = len(set_a & set_b)
        union = len(set_a | set_b)
        return intersection / union if union > 0 else 0.0

    elif metric == "morisita_horn":
        if not isinstance(clonotypes_a, dict):
            raise ValueError("morisita_horn requires count dicts")
        shared = set_a & set_b
        if not shared:
            return 0.0
        total_a = sum(clonotypes_a.values())
        total_b = sum(clonotypes_b.values())
        sum_ab = sum(
            clonotypes_a.get(c, 0) * clonotypes_b.get(c, 0) for c in shared
        )
        sum_a2 = sum(v ** 2 for v in clonotypes_a.values())
        sum_b2 = sum(v ** 2 for v in clonotypes_b.values())
        denom = (sum_a2 / total_a ** 2 + sum_b2 / total_b ** 2) * total_a * total_b
        return 2 * sum_ab / denom if denom > 0 else 0.0

    raise ValueError(f"Unknown metric: {metric}")
```

## Gotchas

- **Log scale for z-score signatures**: Use log-transformed expression
  for z-score-based signature scoring. Use linear scale for CYT
  (geometric mean).
- **Gene symbol synonyms**: Some signatures use non-standard symbols.
  HAVCR2 = TIM-3, PDCD1 = PD-1, CD274 = PD-L1. Always check for
  both official and alias symbols.
- **Signature size**: If < 50% of signature genes are found in your
  data, the score is unreliable. Report the fraction found.
- **ssGSEA normalization**: gseapy's ssGSEA NES values are not
  directly comparable across datasets with different gene counts.
  Z-score within dataset before cross-study comparison.
- **TCR diversity is sample-size dependent**: Shannon entropy and
  richness increase with sequencing depth. Downsample to equal
  depth before comparing samples.
- **M1/M2 polarization**: The M1/M2 dichotomy is a simplification.
  In vivo macrophages exist on a spectrum. Report scores as
  "M1-like" and "M2-like" tendencies, not definitive classifications.
