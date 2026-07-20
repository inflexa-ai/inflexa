# decoupler TF & Pathway Activity Inference API Reference

Python package for inferring transcription factor (TF) and pathway activities from omics data using prior knowledge networks. Uses CollecTRI regulons for TF activity and PROGENy models for pathway activity. Works on both AnnData objects and plain pandas DataFrames.

## Core Imports

```python
import decoupler as dc
import pandas as pd
import numpy as np
```

## Resource Loading

Never call `dc.op.collectri()`, `dc.op.progeny()`, `dc.get_progeny()`, or any other `dc.op.*()` loader: they fetch from the OmniPath web API, and there is no network egress. Load the network from a file already available to you.

**Resolve the file before you write the script.** Ask for the *dataset* by what it is, not by a path — reference data is provisioned per-environment, so the directory, the filename, and the format all vary and none of them are yours to assume:

| You need | Ask for | Standard sources |
|-|-|-|
| TF activity | A TF-target regulon network for your organism | CollecTRI; or DoRothEA filtered to confidence A-C |
| Pathway activity | Pathway responsive-gene weights for your organism | PROGENy (14 pathways) |

Then read it with the reader its format actually calls for — these circulate as CSV, TSV, and R `.rda` depending on the source, and a wrong-format read fails immediately. Match the organism too: a human regulon set over mouse counts runs happily and returns meaningless activities.

```python
import pandas as pd

# `regulon_path` and `pathway_path` are paths you resolved, not literals to copy.
collectri = pd.read_csv(regulon_path)
progeny = pd.read_csv(pathway_path)
```

### Network DataFrame Format

Every method below consumes the same long format:

| Column | Type | Description |
|-|-|-|
| `source` | str | Regulator name (TF for a regulon network, pathway for PROGENy) |
| `target` | str | Target gene symbol (HGNC for human, MGI for mouse) |
| `weight` | float | Regulatory weight. Regulons: +1 (activation) or -1 (repression). PROGENy: signed float reflecting regulatory strength. |

Column names vary by source — DoRothEA ships `tf`/`target`/`mor`, and some releases carry extra provenance columns. Inspect the frame after loading and rename into `source`/`target`/`weight` before passing it on:

```python
collectri = collectri.rename(columns={"tf": "source", "mor": "weight"})
collectri = collectri[["source", "target", "weight"]]
```

For reference, CollecTRI human is roughly 1,200 TFs over ~50k interactions, and PROGENy covers 14 pathways: Androgen, EGFR, Estrogen, Hypoxia, JAK-STAT, MAPK, NFkB, p53, PI3K, TGFb, TNFa, Trail, VEGF, WNT.

## dc.mt.ulm() -- Univariate Linear Model

Fast, recommended default for both TF and pathway activity inference. Fits a univariate linear model per source (TF or pathway) independently. Best when prior knowledge network includes weights.

```python
# Function signature (Method object, called as function)
dc.mt.ulm(
    data,           # AnnData | pd.DataFrame | tuple[np.ndarray, np.ndarray, np.ndarray]
    net,            # pd.DataFrame — network in long format (source, target, weight)
    tmin=5,         # int — minimum targets per source; sources with fewer are dropped
    layer=None,     # str | None — AnnData layer to use (None = .X)
    raw=False,      # bool — whether to use adata.raw
    empty=True,     # bool — remove empty observations/features
    bsize=250000,   # int — batch size for sparse data processing
    verbose=False,  # bool — display progress messages
)
# Returns: tuple[pd.DataFrame, pd.DataFrame] — (scores, adjusted_pvals)
#   When data is AnnData: stores in adata.obsm and returns AnnData reference
#   When data is DataFrame: returns (scores_df, pvals_df) directly
```

### AnnData Mode

```python
# Stores results directly in adata.obsm
dc.mt.ulm(data=adata, net=collectri)

# Results stored in:
#   adata.obsm["score_ulm"]  — activity scores (cells x sources)
#   adata.obsm["padj_ulm"]   — adjusted p-values (cells x sources)

# Extract as a standalone AnnData for scanpy plotting
score = dc.pp.get_obsm(adata=adata, key="score_ulm")
# score.X contains the activity scores, score.var_names are source names
```

### DataFrame Mode

```python
# mat: pd.DataFrame, shape (n_samples, n_genes) — genes as COLUMNS
acts, pvals = dc.mt.ulm(data=mat, net=collectri)
# acts:  pd.DataFrame (n_samples, n_sources) — activity scores
# pvals: pd.DataFrame (n_samples, n_sources) — adjusted p-values (BH)
```

## dc.mt.mlm() -- Multivariate Linear Model

Fits all sources simultaneously in a single multivariate model. Better when sources share many targets (reduces confounding). Slightly slower than ULM.

```python
dc.mt.mlm(
    data,           # AnnData | pd.DataFrame | tuple
    net,            # pd.DataFrame — network (source, target, weight)
    tmin=5,         # int — minimum targets per source
    layer=None,     # str | None — AnnData layer
    raw=False,      # bool — use adata.raw
    empty=True,     # bool — remove empty observations/features
    bsize=250000,   # int — batch size for sparse data
    verbose=False,  # bool — display progress
    tval=None,      # bool | None — return t-value (True) or coefficient (False)
)
# Returns: tuple[pd.DataFrame, pd.DataFrame] — (scores, adjusted_pvals)
```

### AnnData Mode

```python
dc.mt.mlm(data=adata, net=collectri)
# adata.obsm["score_mlm"]  — activity scores
# adata.obsm["padj_mlm"]   — adjusted p-values
```

### DataFrame Mode

```python
acts, pvals = dc.mt.mlm(data=mat, net=progeny)
# Same output format as ulm
```

## TF Activity Inference with CollecTRI

### Single-Cell Data (AnnData)

```python
import decoupler as dc
import pandas as pd
import scanpy as sc

# Load CollecTRI network
collectri = pd.read_csv(regulon_path)  # resolved + normalised per Resource Loading

# Check gene symbol overlap before running
overlap = set(adata.var_names) & set(collectri["target"])
print(f"Gene overlap: {len(overlap)} / {collectri['target'].nunique()} CollecTRI targets")

# Compute per-cell TF activities
dc.mt.ulm(data=adata, net=collectri)

# Extract scores as AnnData for scanpy plotting
tf_score = dc.pp.get_obsm(adata=adata, key="score_ulm")

# Rank TFs by variance across cells (most variable = most informative)
tf_var = pd.Series(
    tf_score.X.var(axis=0) if hasattr(tf_score.X, 'toarray') is False else tf_score.X.toarray().var(axis=0),
    index=tf_score.var_names,
).sort_values(ascending=False)
top_tfs = tf_var.head(20).index.tolist()

# Visualize top TFs on UMAP
sc.pl.umap(tf_score, color=top_tfs[:6], ncols=3, frameon=False,
           save="_tf_activity.png", show=False)

# Heatmap: mean TF activity per cluster
import matplotlib.pyplot as plt
import seaborn as sns

tf_acts = pd.DataFrame(
    tf_score.X if not hasattr(tf_score.X, 'toarray') else tf_score.X.toarray(),
    index=adata.obs_names,
    columns=tf_score.var_names,
)
tf_acts["cluster"] = adata.obs["leiden"].values
mean_tf = tf_acts.groupby("cluster")[top_tfs].mean()

fig, ax = plt.subplots(figsize=(12, 6))
sns.heatmap(mean_tf.T, cmap="RdBu_r", center=0, ax=ax,
            xticklabels=True, yticklabels=True)
ax.set_title("Mean TF Activity per Cluster (ULM)")
ax.set_ylabel("Transcription Factor")
ax.set_xlabel("Cluster")
fig.tight_layout()
fig.savefig("figures/tf_activity_heatmap.png", dpi=150, bbox_inches="tight")
plt.close(fig)
```

### Bulk RNA-seq Data (DataFrame)

```python
import decoupler as dc
import pandas as pd

# Load CollecTRI network
collectri = pd.read_csv(regulon_path)  # resolved + normalised per Resource Loading

# Expression matrix: samples as rows, genes as columns
expr = pd.read_csv("vst_counts.csv", index_col=0)

# Compute TF activities
tf_acts, tf_pvals = dc.mt.ulm(data=expr, net=collectri)

# Filter to significant TFs (any sample with padj < 0.05)
sig_mask = (tf_pvals < 0.05).any(axis=0)
tf_acts_sig = tf_acts.loc[:, sig_mask]
print(f"Significant TFs: {sig_mask.sum()} / {tf_acts.shape[1]}")

# Top differentially active TFs between conditions
# (assuming metadata with 'condition' column)
metadata = pd.read_csv("sample_metadata.csv", index_col=0)
group_a = metadata[metadata["condition"] == "treatment"].index
group_b = metadata[metadata["condition"] == "control"].index

mean_diff = tf_acts.loc[group_a].mean() - tf_acts.loc[group_b].mean()
top_up = mean_diff.sort_values(ascending=False).head(10)
top_down = mean_diff.sort_values(ascending=True).head(10)
```

### From DESeq2 Log2FoldChange (Single Contrast)

```python
# Create a 1-row matrix from DESeq2 results
deseq_results = pd.read_csv("deseq_results.csv", index_col=0)
lfc = deseq_results["log2FoldChange"].to_frame().T
lfc.index = ["contrast"]

# Infer TF activity from the contrast
tf_acts, tf_pvals = dc.mt.ulm(data=lfc, net=collectri)

# Rank TFs by activity score
tf_ranking = tf_acts.iloc[0].sort_values(ascending=False)
sig_tfs = tf_ranking[tf_pvals.iloc[0] < 0.05]
```

## Pathway Activity Inference with PROGENy

### Single-Cell Data (AnnData)

```python
import decoupler as dc
import pandas as pd

# Load PROGENy network
progeny = pd.read_csv(pathway_path)  # resolved + normalised per Resource Loading

# Compute per-cell pathway activities
dc.mt.mlm(data=adata, net=progeny)

# Extract as AnnData for plotting
pw_score = dc.pp.get_obsm(adata=adata, key="score_mlm")

# Visualize selected pathways on UMAP
import scanpy as sc
sc.pl.umap(pw_score, color=["JAK-STAT", "NFkB", "MAPK", "p53"],
           ncols=2, frameon=False, save="_pathway_activity.png", show=False)

# Mean pathway activity per cluster
pw_df = pd.DataFrame(
    pw_score.X if not hasattr(pw_score.X, 'toarray') else pw_score.X.toarray(),
    index=adata.obs_names,
    columns=pw_score.var_names,
)
pw_df["cluster"] = adata.obs["leiden"].values
mean_pw = pw_df.groupby("cluster").mean()
```

### Bulk RNA-seq Data (DataFrame)

```python
import decoupler as dc
import pandas as pd

# Load PROGENy network
progeny = pd.read_csv(pathway_path)  # resolved + normalised per Resource Loading

# Expression matrix: samples as rows, genes as columns
expr = pd.read_csv("vst_counts.csv", index_col=0)

# Compute pathway activities (MLM recommended for PROGENy — shared targets)
pw_acts, pw_pvals = dc.mt.mlm(data=expr, net=progeny)

# Filter significant pathways
sig_mask = (pw_pvals < 0.05).any(axis=0)
pw_acts_sig = pw_acts.loc[:, sig_mask]

# Bar plot for a single sample or contrast
import matplotlib.pyplot as plt

sample_acts = pw_acts.iloc[0].sort_values()
fig, ax = plt.subplots(figsize=(6, 5))
colors = ["#e74c3c" if v > 0 else "#3498db" for v in sample_acts]
ax.barh(sample_acts.index, sample_acts.values, color=colors)
ax.set_xlabel("Activity Score")
ax.set_title("Pathway Activities (PROGENy + MLM)")
ax.axvline(0, color="black", linewidth=0.5)
fig.tight_layout()
fig.savefig("figures/pathway_activity_bar.png", dpi=150, bbox_inches="tight")
plt.close(fig)
```

## dc.pp.get_obsm() -- Extract Results from AnnData

Extracts activity scores from `adata.obsm` into a standalone AnnData object suitable for scanpy plotting functions.

```python
dc.pp.get_obsm(
    adata,          # AnnData — source object
    key="score_ulm" # str — obsm key to extract
)
# Returns: AnnData with scores in .X and source names in .var_names
```

## Combining TF and Pathway Activity

A common network-regulatory workflow: infer both TF and pathway activities, then correlate them to identify pathway-regulating TFs.

```python
import decoupler as dc
import pandas as pd
import numpy as np
from scipy import stats as scipy_stats

# Load networks
collectri = pd.read_csv(regulon_path)  # resolved + normalised per Resource Loading
progeny = pd.read_csv(pathway_path)  # resolved + normalised per Resource Loading

# Compute both on the same expression data
expr = pd.read_csv("vst_counts.csv", index_col=0)
tf_acts, tf_pvals = dc.mt.ulm(data=expr, net=collectri)
pw_acts, pw_pvals = dc.mt.mlm(data=expr, net=progeny)

# Filter to significant
sig_tfs = tf_acts.columns[(tf_pvals < 0.05).any(axis=0)]
sig_pws = pw_acts.columns[(pw_pvals < 0.05).any(axis=0)]

# Correlate TF activities with pathway activities
corr_matrix = pd.DataFrame(
    index=sig_tfs, columns=sig_pws, dtype=float
)
pval_matrix = pd.DataFrame(
    index=sig_tfs, columns=sig_pws, dtype=float
)

for tf in sig_tfs:
    for pw in sig_pws:
        r, p = scipy_stats.pearsonr(tf_acts[tf], pw_acts[pw])
        corr_matrix.loc[tf, pw] = r
        pval_matrix.loc[tf, pw] = p

# Top TF-pathway associations
import matplotlib.pyplot as plt
import seaborn as sns

fig, ax = plt.subplots(figsize=(8, 12))
sns.heatmap(corr_matrix.astype(float), cmap="RdBu_r", center=0,
            annot=True, fmt=".2f", ax=ax,
            xticklabels=True, yticklabels=True)
ax.set_title("TF-Pathway Activity Correlation")
fig.tight_layout()
fig.savefig("figures/tf_pathway_correlation.png", dpi=150, bbox_inches="tight")
plt.close(fig)
```

## Method Selection: ULM vs MLM

| | ULM | MLM |
|-|-|-|
| Model | One linear model per source (univariate) | All sources in one model (multivariate) |
| Speed | Faster | Slightly slower |
| Shared targets | Does not account for overlap | Accounts for shared targets between sources |
| Best for | TF activity with CollecTRI (sparse targets per TF) | Pathway activity with PROGENy (many shared pathway genes) |
| obsm keys | `score_ulm`, `padj_ulm` | `score_mlm`, `padj_mlm` |

**Rule of thumb**: Use `dc.mt.ulm()` for CollecTRI TF activity. Use `dc.mt.mlm()` for PROGENy pathway activity. Both work for either, but these pairings are the most robust defaults.

## Gotchas

- **Gene orientation**: Input DataFrame must have genes as COLUMNS and samples as ROWS. This is transposed from typical bioinformatics convention. If you load a genes-as-rows matrix, transpose it first: `mat = mat.T`.
- **Gene symbol matching**: Gene symbols in the expression data must match the network's `target` column. Use HGNC symbols for human. Always check overlap: `len(set(mat.columns) & set(net["target"]))`. Low overlap (<20% of network targets) indicates a symbol mismatch problem.
- **No network access**: Never call `dc.op.collectri()`, `dc.op.progeny()`, or any other `dc.op.*()` loader. They query the OmniPath web API, and egress is blocked — the call fails outright. Load from a resolved file instead, with the reader its format calls for.
- **Network absent from the environment**: If no regulon or pathway-weight file resolves, say so and stop that branch of the analysis. Do not substitute a different network, and do not fabricate one from a marker list — a plausible-looking activity score computed against invented priors is worse than a missing result.
- **tmin parameter**: Sources (TFs or pathways) with fewer than `tmin` targets present in your data are silently dropped. If a TF is missing from results, check how many of its targets are in your gene list. Lower `tmin` (e.g., `tmin=3`) to recover sparse TFs, but results become less reliable.
- **AnnData obsm key naming**: In decoupler >=2.x, obsm keys follow the pattern `score_{method}` and `padj_{method}` (e.g., `score_ulm`, `padj_ulm`). Older versions used `{method}_estimate` and `{method}_pvals`. This project uses decoupler >=2.1.2 -- always use the `score_` / `padj_` prefix.
- **CollecTRI weights are directional**: +1 means the TF activates the target, -1 means repression. A positive activity score means the TF's activation targets are up and/or its repression targets are down.
- **PROGENy weights are signed floats**: Positive weight means the gene is upregulated when the pathway is active. The magnitude reflects confidence/effect size.
- **Sparse AnnData**: decoupler handles sparse matrices (CSR/CSC) internally. No need to convert to dense. For very large single-cell datasets (>100k cells), consider running on pseudobulk profiles to reduce noise and compute time.
- **Running ULM on AnnData does not return a tuple**: When `data` is AnnData, results are stored in `adata.obsm` in-place. Use `dc.pp.get_obsm()` to extract. When `data` is a DataFrame, results are returned as `(scores, pvals)`.
- **p-values are BH-adjusted**: ULM and MLM return adjusted p-values (Benjamini-Hochberg). These are `padj`, not raw p-values.
- **Multiple runs overwrite obsm**: Running `dc.mt.ulm()` twice on the same AnnData overwrites `score_ulm` / `padj_ulm`. If you need results from multiple networks, extract after each run or use DataFrame mode.
