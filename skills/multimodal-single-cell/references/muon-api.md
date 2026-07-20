# Muon API Reference

Multimodal omics analysis framework built around MuData. Extends scanpy for multi-modal workflows (CITE-seq, Multiome, etc.).

## Import Convention

```python
import muon as mu
from muon import atac as ac
from muon import prot as pt
import scanpy as sc
```

## MuData Creation and I/O

```python
# Load 10x Multiome (RNA + ATAC from Cell Ranger ARC)
mdata = mu.read_10x_h5("filtered_feature_bc_matrix.h5")

# Load from .h5mu file
mdata = mu.read("dataset.h5mu")

# Save
mdata.write("dataset.h5mu")
```

## Preprocessing: mu.pp

### intersect_obs — Restrict to Shared Cells

After per-modality QC filtering, cells may differ across modalities. This synchronizes them.

```python
# Keep only cells present in ALL modalities
mu.pp.intersect_obs(mdata)
```

### Filter Observations by Modality Metrics

```python
# Filter using a modality-prefixed column from .obs
mu.pp.filter_obs(mdata, 'rna:pct_counts_mt', lambda x: x < 20)
mu.pp.filter_obs(mdata, 'rna:n_genes_by_counts', lambda x: (x > 200) & (x < 5000))
mu.pp.filter_obs(mdata, 'atac:n_genes_by_counts', lambda x: (x > 500) & (x < 20000))
```

### Multimodal Neighbors (WNN)

Builds a joint neighbor graph weighting each modality per cell (Weighted Nearest Neighbors).

```python
# Requires per-modality neighbors computed first
# (X_lsi here has already had component 0 removed — see the ATAC module below)
sc.pp.neighbors(mdata.mod['rna'], n_neighbors=15, n_pcs=30)
sc.pp.neighbors(mdata.mod['atac'], use_rep='X_lsi', n_neighbors=15)

# Joint multimodal neighbors
mu.pp.neighbors(mdata, n_neighbors=15)
```

## Protein Module: mu.prot

For CITE-seq / ADT data. Access via `mu.prot` or `from muon import prot as pt`.

```python
adt = mdata.mod['adt']  # or mdata.mod['prot']

# CLR normalization (standard for ADT)
# The kwarg is `axis`, NOT `margin` — `margin=` raises TypeError.
# axis=0 (default): normalize per-feature, across cells — the standard for ADT
# axis=1: normalize per-cell, across features
mu.prot.pp.clr(adt, axis=0)

# DSB normalization (requires empty droplets)
# mu.prot.pp.dsb(adt, empty_droplets)  # if empty drops available
```

## ATAC Module: mu.atac (aliased as ac)

For scATAC-seq / Multiome ATAC modality.

```python
atac = mdata.mod['atac']

# TF-IDF normalization
ac.pp.tfidf(atac, scale_factor=1e4)

# Latent Semantic Indexing (dimensionality reduction for ATAC)
ac.tl.lsi(atac, n_comps=50)
# Result stored in atac.obsm['X_lsi'] — ac.tl.lsi RETAINS component 0.
#
# IMPORTANT: component 0 correlates with sequencing depth, not biology.
# `n_pcs=49` does NOT drop it — that keeps components 0..48. To actually
# exclude it you must slice the representation:
atac.obsm['X_lsi'] = atac.obsm['X_lsi'][:, 1:]
atac.varm['LSI'] = atac.varm['LSI'][:, 1:]
atac.uns['lsi']['stdev'] = atac.uns['lsi']['stdev'][1:]
# Downstream now uses the depth component-free representation:
#   sc.pp.neighbors(atac, use_rep='X_lsi', n_neighbors=15)

# Peak annotation: link peaks to genes
ac.tl.add_peak_annotation_gene_names(
    mdata,
    gene_names=None,       # Uses RNA modality var_names if None
    join_on='gene_ids'
)
```

## Tools: mu.tl

### MOFA (Multi-Omics Factor Analysis)

Unsupervised factor analysis decomposing shared and modality-specific variation.

```python
mu.tl.mofa(
    mdata,
    n_factors=15,
    use_var='highly_variable',   # Only HVGs/HVPs per modality
    use_obs='intersection',      # Cells present in all modalities
    n_iterations=1000,
    convergence_mode='fast',
    save_data=True,
    outfile='mofa_model.hdf5'
)

# Results:
#   mdata.obsm['X_mofa']  — cell embeddings (n_cells x n_factors)
#   mdata.varm['LFs']     — feature loadings (n_features x n_factors)
#   mdata.uns['mofa']['variance']  — variance explained per factor per view
```

### UMAP and Leiden Clustering

```python
mu.tl.umap(mdata)
mu.tl.leiden(mdata, resolution=0.5, key_added='leiden')
```

## Plotting: mu.pl

```python
mu.pl.umap(mdata, color=['leiden', 'rna:CD3E', 'rna:CD14'])
mu.pl.mofa(mdata, color='leiden')
```

## Complete CITE-seq Workflow

```python
import muon as mu
import scanpy as sc

mdata = mu.read("cite_seq.h5mu")

# RNA preprocessing
rna = mdata.mod['rna']
sc.pp.filter_cells(rna, min_genes=200)
sc.pp.filter_genes(rna, min_cells=3)
rna.var['mt'] = rna.var_names.str.startswith('MT-')
sc.pp.calculate_qc_metrics(rna, qc_vars=['mt'], inplace=True)
mu.pp.filter_obs(mdata, 'rna:pct_counts_mt', lambda x: x < 20)
sc.pp.normalize_total(rna, target_sum=1e4)
sc.pp.log1p(rna)
sc.pp.highly_variable_genes(rna, n_top_genes=3000)
sc.pp.pca(rna, n_comps=50)

# Protein preprocessing
adt = mdata.mod['adt']
mu.prot.pp.clr(adt, axis=0)

# Sync cells, build joint graph, embed, cluster
mu.pp.intersect_obs(mdata)
sc.pp.neighbors(rna, n_neighbors=15, n_pcs=30)
mu.pp.neighbors(mdata, n_neighbors=15)
mu.tl.umap(mdata)
mu.tl.leiden(mdata, resolution=0.5, key_added='leiden')
mdata.write("cite_seq_processed.h5mu")
```

## Complete Multiome Workflow

```python
import muon as mu
from muon import atac as ac
import scanpy as sc

mdata = mu.read_10x_h5("multiome_filtered.h5")

# RNA
rna = mdata.mod['rna']
sc.pp.filter_cells(rna, min_genes=200)
sc.pp.normalize_total(rna, target_sum=1e4)
sc.pp.log1p(rna)
sc.pp.highly_variable_genes(rna, n_top_genes=3000)
sc.pp.pca(rna, n_comps=50)

# ATAC
atac = mdata.mod['atac']
ac.pp.tfidf(atac, scale_factor=1e4)
ac.tl.lsi(atac, n_comps=50)
# Drop LSI component 0 (sequencing depth, not biology)
atac.obsm['X_lsi'] = atac.obsm['X_lsi'][:, 1:]
atac.varm['LSI'] = atac.varm['LSI'][:, 1:]
atac.uns['lsi']['stdev'] = atac.uns['lsi']['stdev'][1:]

mu.pp.intersect_obs(mdata)
sc.pp.neighbors(rna, n_neighbors=15, n_pcs=30)
sc.pp.neighbors(atac, use_rep='X_lsi', n_neighbors=15)
mu.pp.neighbors(mdata, n_neighbors=15)
mu.tl.umap(mdata)
mu.tl.leiden(mdata, resolution=0.5, key_added='leiden')

# MOFA for interpretable factor decomposition
mu.tl.mofa(mdata, n_factors=15, use_var='highly_variable', outfile='mofa.hdf5')
mdata.write("multiome_processed.h5mu")
```

## Gotchas

- `mu.pp.intersect_obs(mdata)` modifies `mdata` in-place. Call it AFTER per-modality QC but BEFORE computing neighbors.
- MOFA requires the `mofapy2` package, which is **already installed**. Do not attempt `pip install`; there is no network egress, and an install would fail for a package that is already present.
- The first LSI component from `ac.tl.lsi()` captures sequencing depth, not biology, and `ac.tl.lsi()` does **not** drop it for you. Lowering `n_pcs` does not exclude it either (`n_pcs=49` keeps components 0..48). Slice it off explicitly: `atac.obsm['X_lsi'] = atac.obsm['X_lsi'][:, 1:]` (and the matching `varm['LSI']` / `uns['lsi']['stdev']`) before computing neighbors.
- `mu.pp.filter_obs()` uses modality-prefixed column names (e.g., `'rna:pct_counts_mt'`), not bare column names.
- `mu.prot.pp.clr()` takes `axis=`, not `margin=`. `axis=0` (the default) normalizes per-feature across cells and is the standard for ADT; `axis=1` normalizes per-cell and can over-correct.
