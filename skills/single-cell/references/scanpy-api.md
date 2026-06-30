# Scanpy API Reference

Core API for single-cell analysis with scanpy. AnnData-centric: most functions
modify `adata` in-place by default.

## Preprocessing (sc.pp)

### Filtering

```python
import scanpy as sc

# Filter cells by minimum genes expressed or total counts
sc.pp.filter_cells(adata, min_genes=200)
sc.pp.filter_cells(adata, min_counts=1000)
sc.pp.filter_cells(adata, max_genes=5000)

# Filter genes by minimum cells expressing
sc.pp.filter_genes(adata, min_cells=3)
sc.pp.filter_genes(adata, min_counts=10)

# Non-inplace: returns (bool_mask, counts_array)
gene_mask, n_cells = sc.pp.filter_genes(adata, min_cells=3, inplace=False)
```

### Normalization and Log Transform

```python
# Normalize total counts per cell (inplace by default)
sc.pp.normalize_total(adata, target_sum=1e4)

# Log-transform (inplace). Operates on adata.X
sc.pp.log1p(adata)

# To normalize a specific layer:
sc.pp.normalize_total(adata, target_sum=1e4, layer="raw_counts")
sc.pp.log1p(adata, layer="raw_counts")
```

### Highly Variable Genes

```python
# Identify HVGs (adds adata.var["highly_variable"])
sc.pp.highly_variable_genes(adata, n_top_genes=2000)

# Seurat v3 flavor (expects raw counts)
sc.pp.highly_variable_genes(adata, n_top_genes=2000, flavor="seurat_v3")

# Cell Ranger flavor
sc.pp.highly_variable_genes(adata, n_top_genes=1500, flavor="cell_ranger")

# Batch-aware HVG selection
sc.pp.highly_variable_genes(adata, n_top_genes=2000, batch_key="batch")

# Subset to HVGs only (destructive - loses other genes)
adata = adata[:, adata.var.highly_variable].copy()
```

### PCA and Neighbors

```python
# PCA (stores in adata.obsm["X_pca"], adata.varm["PCs"])
sc.pp.pca(adata, n_comps=50, svd_solver="arpack")

# Use specific layer for PCA
sc.pp.pca(adata, n_comps=50, layer="log_normalized")

# Compute neighbor graph (stores in adata.obsp["distances"], adata.obsp["connectivities"])
sc.pp.neighbors(adata, n_neighbors=15, n_pcs=50)

# Use a custom representation (e.g., scVI latent space)
sc.pp.neighbors(adata, use_rep="X_scVI", n_neighbors=15)
```

### Doublet Detection (Scrublet)

```python
# Run on raw counts (before normalization)
sc.pp.scrublet(adata, expected_doublet_rate=0.06)
# Adds: adata.obs["predicted_doublet"], adata.obs["doublet_score"]

# Simulate doublets separately for more control
adata_sim = sc.pp.scrublet_simulate_doublets(adata)
sc.pp.scrublet(adata, adata_sim=adata_sim)

# Filter predicted doublets
adata = adata[~adata.obs["predicted_doublet"]].copy()
```

## Tools (sc.tl)

### Clustering

```python
# Leiden clustering (requires neighbors computed)
sc.tl.leiden(adata, resolution=1.0)
sc.tl.leiden(adata, resolution=0.5, key_added="leiden_0.5")

# Louvain clustering
sc.tl.louvain(adata, resolution=1.0)
```

### Embeddings

```python
# UMAP (requires neighbors)
sc.tl.umap(adata, min_dist=0.5)

# t-SNE (can use X_pca directly)
sc.tl.tsne(adata, n_pcs=50, perplexity=30)
```

### Differential Expression

```python
# Rank genes per group (default: Wilcoxon)
sc.tl.rank_genes_groups(adata, groupby="leiden", method="wilcoxon")
sc.tl.rank_genes_groups(adata, groupby="leiden", method="t-test")

# Pairwise comparison
sc.tl.rank_genes_groups(
    adata, groupby="cell_type",
    groups=["CD4_T"], reference="CD8_T",
    method="wilcoxon"
)

# Use raw counts for DE
sc.tl.rank_genes_groups(adata, groupby="leiden", use_raw=True)
```

### Dendrogram and PAGA

```python
# Dendrogram of clusters (used by dotplot, matrixplot, etc.)
sc.tl.dendrogram(adata, groupby="leiden")

# PAGA graph abstraction
sc.tl.paga(adata, groups="leiden")
```

## Plotting (sc.pl)

### Embeddings

```python
# UMAP colored by cluster or gene
sc.pl.umap(adata, color=["leiden", "CD3E", "MS4A1"], save="_markers.png")

# Multi-panel with custom settings
sc.pl.umap(adata, color="leiden", legend_loc="on data",
           frameon=False, title="Cell clusters")
```

### Gene Expression Plots

```python
# Dotplot: fraction expressing vs mean expression
sc.pl.dotplot(adata, var_names=["CD3E", "MS4A1", "LYZ"], groupby="leiden")

# Dotplot with gene groups
marker_genes = {
    "T cells": ["CD3D", "CD3E", "IL7R"],
    "B cells": ["CD79A", "CD79B", "MS4A1"],
    "Myeloid": ["CST3", "LYZ", "CD14"],
}
sc.pl.dotplot(adata, var_names=marker_genes, groupby="leiden",
              standard_scale="var", dendrogram=True)

# Stacked violin
sc.pl.stacked_violin(adata, var_names=["CD3E", "MS4A1", "LYZ"],
                      groupby="leiden", dendrogram=True)

# Matrix plot (heatmap of mean expression)
sc.pl.matrixplot(adata, var_names=marker_genes, groupby="leiden",
                 standard_scale="var", dendrogram=True, cmap="Blues")
```

### DE Results Visualization

```python
# Plot top DE genes per group
sc.pl.rank_genes_groups(adata, n_genes=10, save="_de.png")

# Dotplot of DE results
sc.pl.rank_genes_groups_dotplot(adata, n_genes=5)

# With log fold change coloring
sc.pl.rank_genes_groups_dotplot(
    adata, n_genes=4,
    values_to_plot="logfoldchanges",
    cmap="bwr", vmin=-4, vmax=4,
    min_logfoldchange=1.5,
    colorbar_title="log fold change",
)

# Stacked violin of DE results
sc.pl.rank_genes_groups_stacked_violin(adata, n_genes=3)
```

## Gotchas

- **inplace default**: Most `pp` functions modify `adata` in-place. Use `copy=True` to
  get a modified copy instead.
- **Raw counts**: `scrublet`, `highly_variable_genes(flavor="seurat_v3")`, and
  `rank_genes_groups(use_raw=True)` expect unnormalized counts.
- **Layer handling**: Functions default to `adata.X`. Use `layer=` parameter to
  target a specific layer. Store raw counts in `adata.layers["counts"]` or
  `adata.raw = adata.copy()` before normalization.
- **String dtype**: Categorical columns in `adata.obs` must be actual categoricals
  for `leiden`/`louvain` grouping. Convert with `adata.obs["col"] = adata.obs["col"].astype("category")`.
- **neighbors required**: `umap`, `leiden`, `louvain`, `paga` all require
  `sc.pp.neighbors()` to have been called first.
- **Saving plots**: Pass `save="_suffix.png"` to plotting functions. Files go to
  `./figures/` by default. Set `sc.settings.figdir` to change.
- **Memory**: For large datasets, consider using `sc.pp.pca(adata, chunked=True)` and
  sparse matrix formats.
