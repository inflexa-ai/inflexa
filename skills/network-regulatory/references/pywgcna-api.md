# PyWGCNA API Reference

Python implementation of Weighted Gene Co-expression Network Analysis. Identifies modules of co-expressed genes, correlates modules with traits, and identifies hub genes. Memory-intensive: filter to top variable genes (<5000) before running.

## Core Imports

```python
import PyWGCNA
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
```

## WGCNA() Constructor

```python
# expr_df: genes as columns, samples as rows (standard pandas orientation)
# OR: genes as rows, samples as columns (PyWGCNA auto-detects and transposes if needed)

pyWGCNA = PyWGCNA.WGCNA(
    name="my_analysis",
    species="homo sapiens",       # "homo sapiens"|"mus musculus"|etc.
    geneExpPath=None,             # str | None — path to expression CSV (alternative to geneExpr)
    geneExpr=expr_df,             # pd.DataFrame | AnnData — expression data
    outputPath="wgcna_output/",   # str — output directory
    save=True,                    # bool — save figures and results
    figureType="png",             # "png"|"pdf"|"svg"
)
```

### Constructor Parameter Details

```python
PyWGCNA.WGCNA(
    name="analysis",              # str — analysis name (used in output file names)
    species="homo sapiens",       # str — species for gene ID mapping
    geneExpPath=None,             # str | None — CSV path; if given, data loaded from file
    geneExpr=None,                # pd.DataFrame | AnnData | None — expression data
    outputPath="",                # str — directory for output files (created if needed)
    networkType="unsigned",       # "unsigned"|"signed"|"signed hybrid"
    TOMType="unsigned",           # "unsigned"|"signed"
    save=True,                    # bool — whether to save figures to disk
    figureType="png",             # str — output figure format
    TPMcutoff=1,                  # numeric — min average TPM to keep a gene
    cut=None,                     # numeric | None — height threshold for sample outlier removal
    powers=None,                  # list[int] | None — soft-thresholding powers to test
    RsquaredCut=0.9,              # float — R-squared cutoff for scale-free fit
    MeanCut=100,                  # int — mean connectivity cutoff
    minModuleSize=50,             # int — minimum module size for dynamic tree cutting
    MEDissThres=0.2,              # float — module eigengene dissimilarity threshold for merging
)
```

## Data Preprocessing

Filter to top variable genes before WGCNA to manage memory and noise.

```python
# CRITICAL: Filter to top variable genes before WGCNA
# PyWGCNA can be very slow/memory-hungry with >5000 genes
n_top = 5000
gene_var = expr_df.var(axis=0).sort_values(ascending=False)
top_genes = gene_var.head(n_top).index.tolist()
expr_filtered = expr_df[top_genes]

pyWGCNA = PyWGCNA.WGCNA(
    name="analysis",
    species="homo sapiens",
    geneExpr=expr_filtered,
    outputPath="wgcna_output/",
)

# Built-in preprocessing: removes low-expression genes + outlier samples
pyWGCNA.preprocess()
# - Filters genes with mean expression < TPMcutoff
# - Removes outlier samples based on hierarchical clustering (if cut is set)
# - Generates sample dendrogram figure
```

## Soft-Thresholding Power Selection

```python
# findModules() handles power selection internally, but you can inspect it
# The power table is stored after findModules() runs
# Or call pickSoftThreshold directly:
power, sft = PyWGCNA.WGCNA.pickSoftThreshold(
    pyWGCNA.datExpr.to_df(),
    RsquaredCut=0.9,
    MeanCut=100,
    powerVector=list(range(1, 21)),
    networkType="unsigned",
)
print(f"Selected power: {power}")
print(sft)
# sft DataFrame columns:
#   Power         — soft-thresholding power
#   SFT.R.sq      — scale-free topology fit R-squared
#   slope          — slope of the log-log plot
#   truncated R.sq — truncated R-squared
#   mean(k)        — mean connectivity
#   median(k)      — median connectivity
#   max(k)         — maximum connectivity
```

## Finding Modules: findModules()

The core WGCNA pipeline: soft-thresholding, adjacency, TOM, clustering, and module merging.

```python
pyWGCNA.findModules(
    kwargs_function={
        'cutreeHybrid': {
            'deepSplit': 2,          # 0-4: higher = more modules, smaller size
            'pamRespectsDendro': False,
        },
    }
)

# After findModules(), available attributes:
# pyWGCNA.power               — selected soft-thresholding power
# pyWGCNA.sft                 — power table DataFrame
# pyWGCNA.adjacency           — adjacency matrix (DataFrame)
# pyWGCNA.TOM                 — topological overlap matrix (DataFrame)
# pyWGCNA.geneTree            — hierarchical clustering linkage
# pyWGCNA.datExpr.var         — gene metadata including:
#   pyWGCNA.datExpr.var['moduleColors']  — final module color per gene
#   pyWGCNA.datExpr.var['moduleLabels']  — numeric module label per gene
# pyWGCNA.MEs                 — module eigengenes (samples x modules)

# Get module assignments
module_df = pyWGCNA.datExpr.var[['moduleColors']].copy()
module_df.columns = ['module']
module_counts = module_df['module'].value_counts()
print(module_counts)
```

### findModules() kwargs_function Options

```python
# Control sub-function parameters via kwargs_function dict
pyWGCNA.findModules(
    kwargs_function={
        'pickSoftThreshold': {
            'RsquaredCut': 0.85,     # lower R-squared threshold if 0.9 not reached
            'networkType': 'signed',
        },
        'adjacency': {},             # usually no custom params needed
        'TOMsimilarity': {
            'TOMType': 'signed',
        },
        'cutreeHybrid': {
            'deepSplit': 2,          # 0 (few large modules) to 4 (many small modules)
            'pamRespectsDendro': False,
            'minClusterSize': 50,    # override WGCNA.minModuleSize
        },
        'mergeCloseModules': {
            'cutHeight': 0.25,       # override WGCNA.MEDissThres
        },
    }
)
```

## Module-Trait Correlation

Correlate module eigengenes with clinical/experimental traits.

```python
# trait_df: samples as rows, traits as columns (numeric values)
# Categorical variables must be encoded as numeric (0/1 dummy variables)

# Option A: using built-in method
pyWGCNA.updateSampleInfo(sampleInfo=trait_df)
# This stores traits in pyWGCNA.datExpr.obs

# Compute module-trait correlations manually
from scipy import stats as scipy_stats

MEs = pyWGCNA.MEs  # samples x modules (e.g., MEblue, MEturquoise, ...)
trait_df = trait_df.loc[MEs.index]  # align samples

corr_matrix = pd.DataFrame(index=MEs.columns, columns=trait_df.columns, dtype=float)
pval_matrix = pd.DataFrame(index=MEs.columns, columns=trait_df.columns, dtype=float)

for me in MEs.columns:
    for trait in trait_df.columns:
        mask = ~(MEs[me].isna() | trait_df[trait].isna())
        r, p = scipy_stats.pearsonr(MEs.loc[mask, me], trait_df.loc[mask, trait])
        corr_matrix.loc[me, trait] = r
        pval_matrix.loc[me, trait] = p

# Heatmap of module-trait correlations
import seaborn as sns
fig, ax = plt.subplots(figsize=(10, 8))
sns.heatmap(corr_matrix.astype(float), cmap="RdBu_r", center=0, annot=True, fmt=".2f", ax=ax)
ax.set_title("Module-Trait Correlations")
fig.tight_layout()
fig.savefig("module_trait_heatmap.png", dpi=150, bbox_inches="tight")
plt.close(fig)
```

## Hub Gene Identification

Hub genes have high module membership (correlation with module eigengene) and high gene significance (correlation with trait of interest).

```python
# Module membership: correlation of each gene's expression with its module eigengene
expr = pyWGCNA.datExpr.to_df()  # samples x genes
MEs = pyWGCNA.MEs
module_colors = pyWGCNA.datExpr.var['moduleColors']

# For a specific module (e.g., "blue")
target_module = "blue"
module_genes = module_colors[module_colors == target_module].index.tolist()

# Module membership = cor(gene, ME_module)
me_col = f"ME{target_module}"
mm = pd.Series(index=module_genes, dtype=float)
for gene in module_genes:
    r, _ = scipy_stats.pearsonr(expr[gene], MEs[me_col])
    mm[gene] = abs(r)

# Gene significance = cor(gene, trait)
trait_values = trait_df["response"]  # numeric trait
gs = pd.Series(index=module_genes, dtype=float)
for gene in module_genes:
    mask = ~trait_values.isna()
    r, _ = scipy_stats.pearsonr(expr.loc[mask, gene], trait_values[mask])
    gs[gene] = abs(r)

# Hub genes: high MM AND high GS
hub_df = pd.DataFrame({"module_membership": mm, "gene_significance": gs})
hub_genes = hub_df[(hub_df["module_membership"] > 0.8) & (hub_df["gene_significance"] > 0.3)]
hub_genes = hub_genes.sort_values("module_membership", ascending=False)
```

## Exporting Module Networks

```python
# Export edges within a module for visualization in Cytoscape or NetworkX
target_module = "blue"
module_genes = module_colors[module_colors == target_module].index.tolist()

# Get TOM submatrix for module genes
tom_sub = pyWGCNA.TOM.loc[module_genes, module_genes]

# Convert to edge list
edges = []
for i, gene1 in enumerate(module_genes):
    for j, gene2 in enumerate(module_genes):
        if i < j and tom_sub.loc[gene1, gene2] > 0.1:  # threshold TOM
            edges.append({
                "source": gene1,
                "target": gene2,
                "weight": tom_sub.loc[gene1, gene2],
            })
edge_df = pd.DataFrame(edges)

# To NetworkX
import networkx as nx
G = nx.from_pandas_edgelist(edge_df, "source", "target", ["weight"])
```

## Complete Workflow Example

```python
import PyWGCNA
import pandas as pd
import numpy as np

# Load and filter expression data
expr_df = pd.read_csv("vst_counts.csv", index_col=0)  # samples x genes
gene_var = expr_df.var(axis=0).sort_values(ascending=False)
expr_filtered = expr_df[gene_var.head(5000).index]

# Initialize and run WGCNA
pyWGCNA = PyWGCNA.WGCNA(
    name="analysis",
    species="homo sapiens",
    geneExpr=expr_filtered,
    outputPath="wgcna_output/",
    networkType="signed",
    minModuleSize=30,
    MEDissThres=0.25,
)
pyWGCNA.preprocess()
pyWGCNA.findModules()

# Module assignments
modules = pyWGCNA.datExpr.var[['moduleColors']]
print(modules['moduleColors'].value_counts())

# Module eigengenes
MEs = pyWGCNA.MEs
```

## Gotchas

- Filter to <5000 genes before running. WGCNA computes an N x N correlation matrix and TOM. With 20k genes, this requires ~3.2 GB RAM for the correlation matrix alone.
- Expression data should be normalized and variance-stabilized (e.g., VST, log-CPM). Do NOT use raw counts.
- `networkType="signed"` distinguishes positive and negative correlations. `"unsigned"` uses absolute correlation. Signed is generally preferred for biological interpretation.
- The `grey` module contains unassigned genes. It is expected and should be excluded from downstream analysis.
- `deepSplit` in `cutreeHybrid` controls module granularity: 0 = few large modules, 4 = many small modules. Start with 2 (default).
- `MEDissThres` controls module merging: lower values merge more aggressively. 0.2 means modules with eigengene correlation > 0.8 are merged.
- Power table column names use `SFT.R.sq` (not `R.squared`). The selected power has `SFT.R.sq > RsquaredCut` with the lowest mean connectivity.
- If no power achieves `RsquaredCut`, PyWGCNA selects the power with the highest `SFT.R.sq`. This may indicate the data is not well-suited for WGCNA (too few samples, too noisy, or wrong normalization).
- The `datExpr` attribute is an AnnData-like object. Use `.to_df()` to get the expression DataFrame and `.var` for gene-level metadata.
- `MEs` (module eigengenes) have column names like `MEblue`, `MEturquoise`. The `ME` prefix is always present.
- PyWGCNA saves figures to `outputPath/figures/` when `save=True`. Set `save=False` to suppress file I/O.
- For reproducibility, set `numpy.random.seed()` before running, though the core pipeline is largely deterministic.
