# decoupler Enrichment/Activity Inference API Reference

Python package for inferring biological activities (pathway, TF, kinase) from omics data. Works on both AnnData objects and plain pandas DataFrames. Part of the scverse ecosystem.

## Core Imports

```python
import decoupler as dc
import pandas as pd
import numpy as np
```

## Resource Loading

Never call `dc.op.progeny()`, `dc.op.collectri()`, `dc.op.ksn_omnipath()`, `dc.get_progeny()`, or any other `dc.op.*()` loader: they fetch from the OmniPath web API, and there is no network egress. Load the network from a file already available to you.

**Resolve the file before you write the script.** Ask for the *dataset* by what it is, not by a path — reference data is provisioned per-environment, so the directory, the filename, and the format all vary and none of them are yours to assume:

| You need | Ask for | Standard sources |
|-|-|-|
| Pathway activity | Pathway responsive-gene weights for your organism | PROGENy (14 pathways) |
| TF activity | A TF-target regulon network for your organism | CollecTRI; or DoRothEA filtered to confidence A-C |
| Kinase activity | A kinase-substrate network for your organism | OmniPath enzyme-substrate; PhosphoSitePlus |

Then read it with the reader its format actually calls for — these circulate as CSV, TSV, and R `.rda` depending on the source, and a wrong-format read fails immediately. Match the organism too: a human regulon set over mouse counts runs happily and returns meaningless activities. A kinase-substrate network is the least commonly provisioned of the three: confirm one is in the inventory before planning a kinase-activity step, rather than discovering its absence mid-script.

Pathway-weight and regulon files are frequently distributed as R `.rda` (this is
how PROGENy and DoRothEA are published), which pandas cannot open — those need
rpy2. Check the format the inventory reports and pick the reader from it:

```python
import pandas as pd
import rpy2.robjects as ro
from rpy2.robjects import pandas2ri


def read_rda_frame(path: str) -> pd.DataFrame:
    """Load the data frame an R .rda holds (PROGENy, DoRothEA) into pandas."""
    names = list(ro.r["load"](path))  # load() returns the names it created
    with (ro.default_converter + pandas2ri.converter).context():
        return ro.conversion.get_conversion().rpy2py(ro.r[names[0]])


# `pathway_path` and `regulon_path` are paths you resolved, not literals to copy.
# PROGENy is published as .rda — read_csv on it fails outright.
progeny = read_rda_frame(pathway_path)
# CollecTRI is CSV; if you resolved DoRothEA instead, it is .rda — use read_rda_frame.
collectri = pd.read_csv(regulon_path)
```

### Network DataFrame Format

Every method below consumes the same long format:

| Column | Type | Description |
|-|-|-|
| `source` | str | Regulator name (pathway for PROGENy, TF for a regulon network, kinase for a KSN) |
| `target` | str | Target gene symbol (HGNC for human, MGI for mouse) |
| `weight` | float | Regulatory weight. Regulons: +1 (activation) or -1 (repression). PROGENy: signed float reflecting regulatory strength. |

Column names vary by source — DoRothEA ships `tf`/`target`/`mor`, PROGENy releases often carry an extra `p_value` column, and some releases add provenance columns. Inspect the frame after loading and rename into `source`/`target`/`weight` before passing it on:

```python
collectri = collectri.rename(columns={"tf": "source", "mor": "weight"})
collectri = collectri[["source", "target", "weight"]]
```

### Hand-Built Networks

Any DataFrame with `source`, `target`, `weight` columns works as a network:

```python
custom_net = pd.DataFrame({
    "source": ["PathA", "PathA", "PathB", "PathB"],
    "target": ["GENE1", "GENE2", "GENE3", "GENE4"],
    "weight": [1.0, -0.5, 0.8, 1.2],
})
```

## Activity Inference Methods

All methods share a common interface. They accept either an AnnData object or a pandas DataFrame as input.

### dc.run_ulm() — Univariate Linear Model

Fast, recommended default. Estimates activity by fitting a linear model per source.

```python
# On a pandas DataFrame (genes as columns, samples as rows)
# mat: pd.DataFrame, shape (n_samples, n_genes)
# net: pd.DataFrame with 'source', 'target', 'weight' columns

acts, pvals = dc.mt.ulm(data=mat, net=progeny)
# acts: pd.DataFrame (n_samples, n_sources) — activity scores
# pvals: pd.DataFrame (n_samples, n_sources) — p-values

# Filter significant activities
sig_mask = pvals < 0.05
acts_filtered = acts.where(sig_mask)

# On AnnData (stores results in adata.obsm)
dc.mt.ulm(data=adata, net=progeny)
# Results stored in:
#   adata.obsm["ulm_estimate"]  — activity scores
#   adata.obsm["ulm_pvals"]    — p-values
```

### dc.run_mlm() — Multivariate Linear Model

Fits all sources simultaneously. Better when sources share many targets.

```python
acts, pvals = dc.mt.mlm(data=mat, net=progeny)
# Same output format as ulm

# On AnnData
dc.mt.mlm(data=adata, net=progeny)
# adata.obsm["mlm_estimate"], adata.obsm["mlm_pvals"]
```

### dc.run_wsum() — Weighted Sum

Simple weighted sum of target gene values. Fast, no p-values from model (uses permutation).

```python
acts, pvals = dc.mt.wsum(data=mat, net=progeny, times=1000)
# times: number of permutations for p-value estimation

# On AnnData
dc.mt.wsum(data=adata, net=progeny, times=1000)
# adata.obsm["wsum_estimate"], adata.obsm["wsum_pvals"]
```

### Running Multiple Methods

```python
# Run several methods and combine results
results = {}
for method_name, method_fn in [("ulm", dc.mt.ulm), ("mlm", dc.mt.mlm), ("wsum", dc.mt.wsum)]:
    acts, pvals = method_fn(data=mat, net=progeny)
    results[method_name] = {"acts": acts, "pvals": pvals}

# Consensus: average across methods
consensus_acts = pd.concat(
    [results[m]["acts"] for m in results], axis=0
).groupby(level=0).mean()
```

## Pathway Activity Analysis (PROGENy)

```python
# Load PROGENy network
progeny = read_rda_frame(pathway_path)  # PROGENy is .rda; see Resource Loading
# 14 pathways: Androgen, EGFR, Estrogen, Hypoxia, JAK-STAT, MAPK,
#              NFkB, p53, PI3K, TGFb, TNFa, Trail, VEGF, WNT

# Compute pathway activities
pw_acts, pw_pvals = dc.mt.ulm(data=mat, net=progeny)

# Filter significant pathways
sig_mask = (pw_pvals.T < 0.05).iloc[:, 0]
pw_acts_sig = pw_acts.loc[:, sig_mask]
```

## Transcription Factor Activity (CollecTRI)

```python
# Load CollecTRI network
collectri = pd.read_csv(regulon_path)  # resolved + normalised per Resource Loading

# Compute TF activities
tf_acts, tf_pvals = dc.mt.ulm(data=mat, net=collectri)

# Top variable TFs across samples
tf_var = tf_acts.var(axis=0).sort_values(ascending=False)
top_tfs = tf_var.head(20).index.tolist()
```

## Working with DataFrames (Non-AnnData)

decoupler works seamlessly with plain pandas DataFrames. The input matrix must have samples as rows and genes as columns.

```python
# From a DESeq2-style results table (one sample = one contrast)
# Create a 1-row matrix from log2FoldChange values
lfc = deseq_results["log2FoldChange"].to_frame().T
lfc.index = ["contrast"]

# Run pathway inference on the contrast
pw_acts, pw_pvals = dc.mt.ulm(data=lfc, net=progeny)

# From a multi-sample expression matrix
# expr_df: samples as rows, genes as columns
expr_df = pd.read_csv("expression.csv", index_col=0)
pw_acts, pw_pvals = dc.mt.ulm(data=expr_df, net=progeny)
```

## Visualization

```python
import matplotlib.pyplot as plt

# Heatmap of pathway activities
fig, ax = plt.subplots(figsize=(10, 6))
import seaborn as sns
sns.heatmap(pw_acts.T, cmap="RdBu_r", center=0, ax=ax,
            xticklabels=True, yticklabels=True)
ax.set_title("Pathway Activity Scores (ULM)")
fig.tight_layout()
fig.savefig("pathway_activity_heatmap.png", dpi=150, bbox_inches="tight")
plt.close(fig)

# Bar plot for a single sample
sample_acts = pw_acts.iloc[0].sort_values()
fig, ax = plt.subplots(figsize=(6, 8))
colors = ["#e74c3c" if v > 0 else "#3498db" for v in sample_acts]
ax.barh(sample_acts.index, sample_acts.values, color=colors)
ax.set_xlabel("Activity Score")
ax.set_title("Pathway Activities")
fig.tight_layout()
fig.savefig("pathway_activity_bar.png", dpi=150, bbox_inches="tight")
plt.close(fig)
```

## Custom Networks for Enrichment

Use decoupler for standard gene set enrichment by encoding gene sets as a network with uniform weights.

```python
# Convert gene sets (dict) to decoupler network format
gene_sets = {
    "Apoptosis": ["CASP3", "CASP9", "BAX", "BCL2", "TP53"],
    "Cell_Cycle": ["CDK1", "CDK2", "CCNB1", "CCND1", "RB1"],
    "EMT": ["VIM", "CDH2", "SNAI1", "TWIST1", "ZEB1"],
}

rows = []
for source, targets in gene_sets.items():
    for target in targets:
        rows.append({"source": source, "target": target, "weight": 1.0})
custom_net = pd.DataFrame(rows)

# Run enrichment
acts, pvals = dc.mt.ulm(data=mat, net=custom_net)
```

## Complete Workflow Example

```python
import decoupler as dc
import pandas as pd

# Load expression matrix (samples x genes)
expr = pd.read_csv("vst_counts.csv", index_col=0)

# Pathway activity
progeny = read_rda_frame(pathway_path)  # PROGENy is .rda; see Resource Loading
pw_acts, pw_pvals = dc.mt.ulm(data=expr, net=progeny)

# TF activity
collectri = pd.read_csv(regulon_path)  # resolved + normalised per Resource Loading
tf_acts, tf_pvals = dc.mt.ulm(data=expr, net=collectri)

# Filter significant
pw_sig = pw_acts.loc[:, (pw_pvals < 0.05).any(axis=0)]
tf_sig = tf_acts.loc[:, (tf_pvals < 0.05).any(axis=0)]
```

## Gotchas

- Input DataFrame must have genes as COLUMNS and samples as ROWS. This is transposed from typical bioinformatics convention (genes as rows).
- Gene symbols in the expression matrix must match gene symbols in the network. Use HGNC symbols for human data. Check overlap with `set(mat.columns) & set(net["target"])`.
- `dc.mt.ulm()` and `dc.mt.mlm()` return analytical p-values. `dc.mt.wsum()` returns permutation-based p-values (controlled by `times` parameter).
- When used with AnnData, results are stored in `adata.obsm` with keys like `"ulm_estimate"`, `"ulm_pvals"`. When used with DataFrames, results are returned directly as a tuple.
- PROGENy weights are signed (positive = activation, negative = repression). The activity score direction reflects pathway activation/repression.
- CollecTRI weights are +1 (activation) or -1 (repression). This is critical for correct TF activity inference.
- For sparse AnnData (e.g., single-cell), decoupler handles sparse matrices internally. No need to convert to dense first.
- `dc.op.progeny()` and `dc.op.collectri()` query the OmniPath web API and require internet access. In sandbox environments, always load a network resolved from the reference inventory, using the reader its format calls for — formats vary by source, so do not assume one.
- For large single-cell datasets, consider running on pseudobulk profiles rather than individual cells to reduce noise and compute time.
