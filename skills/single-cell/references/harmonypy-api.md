# HarmonyPy API Reference

Batch effect correction for single-cell data via iterative clustering and
linear correction in PCA space. Python implementation of the Harmony algorithm.
Preserves biological variation while removing technical batch effects.

## Direct HarmonyPy Usage

### Basic Batch Correction

```python
import harmonypy as hm
import numpy as np
import pandas as pd

# Input: PCA embedding (cells x PCs) and metadata with batch info
# pca_embedding: np.ndarray or pd.DataFrame, shape (n_cells, n_pcs)
# meta_data: pd.DataFrame with batch column(s)

ho = hm.run_harmony(
    data_mat=pca_embedding,
    meta_data=meta_data,
    vars_use=["batch"],       # Column(s) in meta_data to correct for
)

# Access corrected PCA coordinates
corrected_pcs = ho.Z_corr.T  # Shape: (n_cells, n_pcs)
# Note: ho.Z_corr is (n_pcs, n_cells), transpose for standard orientation
```

### Advanced Parameters

```python
ho = hm.run_harmony(
    data_mat=pca_embedding,
    meta_data=meta_data,
    vars_use=["batch", "donor"],    # Multiple batch variables
    theta=[2.0, 3.0],              # Diversity penalty per variable (higher = stronger correction)
    lamb=[1.0, 1.5],              # Ridge regression penalty per variable
    sigma=0.1,                     # Width of soft kmeans clusters
    nclust=50,                     # Number of clusters (default: min(N/30, 100))
    max_iter_harmony=10,           # Max Harmony iterations
    max_iter_kmeans=20,            # Max kmeans iterations per Harmony iteration
    epsilon_harmony=1e-4,          # Convergence tolerance (Harmony)
    epsilon_cluster=1e-5,          # Convergence tolerance (clustering)
    tau=0,                         # Overclustering protection for small datasets
    block_size=0.05,               # Fraction of cells per update block
    random_state=42,               # Reproducibility seed
    verbose=True,
)
```

### Accessing Internal Results

```python
# Key attributes of the Harmony result object
ho.Z_orig      # Original PCA coordinates (n_pcs x n_cells)
ho.Z_corr      # Corrected PCA coordinates (n_pcs x n_cells)
ho.Z_cos       # Cosine-normalized coordinates
ho.Y           # Cluster centroids
ho.R           # Soft cluster assignments (n_clusters x n_cells)
ho.K           # Number of clusters
ho.W           # Regression coefficients per cluster

# Convergence diagnostics
print(f"Converged in {len(ho.objective_harmony)} iterations")
print(f"Final objective: {ho.objective_harmony[-1]:.4f}")
```

### Evaluating Integration Quality (LISI)

```python
# Compute LISI (Local Inverse Simpson Index)
lisi = hm.compute_lisi(ho.Z_corr.T, meta_data, ["batch"], perplexity=30)
mean_lisi = np.mean(lisi)
n_batches = meta_data["batch"].nunique()
print(f"Mean LISI: {mean_lisi:.2f} / {n_batches} (higher = better mixing)")
```

## Scanpy Integration

### Standard Scanpy + Harmony Workflow

```python
import scanpy as sc
import harmonypy as hm

# 1. Standard preprocessing
sc.pp.normalize_total(adata, target_sum=1e4)
sc.pp.log1p(adata)
sc.pp.highly_variable_genes(adata, n_top_genes=2000)
sc.pp.pca(adata, n_comps=50)

# 2. Extract PCA and metadata
pca_embedding = adata.obsm["X_pca"]
metadata = adata.obs[["batch"]].copy()

# 3. Run Harmony
ho = hm.run_harmony(pca_embedding, metadata, vars_use=["batch"], random_state=42)

# 4. Store corrected PCs
adata.obsm["X_pca_harmony"] = ho.Z_corr.T

# 5. Compute neighbors and UMAP on corrected space
sc.pp.neighbors(adata, use_rep="X_pca_harmony")
sc.tl.umap(adata)
sc.tl.leiden(adata)
```

### Using scanpy.external (Alternative API)

```python
import scanpy.external as sce

# One-liner: corrects PCA in place
sce.pp.harmony_integrate(
    adata,
    key="batch",         # Batch column in adata.obs
    basis="X_pca",       # Input representation
    adjusted_basis="X_pca_harmony",  # Output key in obsm
    max_iter_harmony=10,
)

# Then use corrected representation
sc.pp.neighbors(adata, use_rep="X_pca_harmony")
sc.tl.umap(adata)
```

## Multiple Batch Variables

```python
# Correct for multiple sources of variation simultaneously
ho = hm.run_harmony(
    pca_embedding,
    meta_data,
    vars_use=["dataset", "donor", "plate"],
    theta=[2.0, 3.0, 1.5],  # Different penalty per variable
    lamb=[1.0, 1.5, 0.5],
)

# Higher theta = stronger correction for that variable
# Higher lambda = more regularization (preserves more original structure)
```

## Exporting Results

```python
# Export corrected PCs to file
corrected = pd.DataFrame(
    ho.Z_corr.T,
    columns=[f"PC{i+1}" for i in range(ho.Z_corr.shape[0])],
    index=meta_data.index,
)
corrected.to_csv("harmonized_pcs.tsv", sep="\t")
```

## Gotchas

- **PCA first**: Harmony operates on PCA space, not raw expression. Always run PCA
  before Harmony. Using 30-50 PCs is standard.
- **Transpose convention**: `ho.Z_corr` has shape `(n_pcs, n_cells)`. Transpose
  with `.T` to get `(n_cells, n_pcs)` for storing in `adata.obsm`.
- **theta tuning**: `theta` controls correction strength. Default is 2 per variable.
  Increase for strong batch effects, decrease if over-correcting biological signal.
  Start with default and adjust if batches still cluster separately.
- **Not expression correction**: Harmony corrects the PCA embedding, not the gene
  expression matrix. Use the corrected embedding for neighbors/clustering/UMAP.
  For corrected expression, use methods like scVI or BBKNN.
- **Large datasets**: Harmony scales well. For >500k cells, increase `block_size`
  (e.g., 0.1) and consider reducing `nclust`.
- **Random state**: Set `random_state` for reproducibility. Results can vary slightly
  between runs without it.
- **scanpy.external**: The `sce.pp.harmony_integrate()` wrapper is convenient but
  offers fewer parameters than direct `hm.run_harmony()`.
- **Metadata alignment**: `meta_data` index must align with `data_mat` rows.
  When extracting from AnnData, ensure `adata.obs.index` matches.
