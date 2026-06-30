# scVelo API Reference

RNA velocity analysis using spliced/unspliced transcript dynamics. Estimates
future cell states by modeling transcriptional kinetics. Requires spliced and
unspliced count layers in AnnData.

## Data Requirements

scVelo requires both spliced and unspliced count matrices, typically generated
by velocyto or STARsolo/alevin-fry. These must be stored as layers in the
AnnData object.

```python
import scvelo as scv
import scanpy as sc

# Load data with spliced/unspliced layers
adata = scv.read("data.h5ad")
# Expected: adata.layers["spliced"], adata.layers["unspliced"]

# Merge spliced/unspliced from a loom file into existing AnnData
ldata = scv.read("velocyto_output.loom", cache=True)
adata = scv.utils.merge(adata, ldata)

# Verify layers exist
print(adata.layers.keys())  # Should show 'spliced' and 'unspliced'

# Check proportions of spliced/unspliced
scv.pl.proportions(adata, groupby="cell_type")
```

## Preprocessing

```python
# Filter genes, normalize, select HVGs (operates on spliced and unspliced)
scv.pp.filter_and_normalize(
    adata,
    min_shared_counts=20,   # Minimum combined spliced+unspliced counts
    n_top_genes=2000,        # Number of highly variable genes
    retain_genes=None,       # List of genes to keep regardless of filtering
    subset_highly_variable=True,
    log=True,
)

# Compute moments (means and uncentered variances)
# Required for velocity estimation
scv.pp.moments(
    adata,
    n_pcs=30,        # PCs for neighbor computation
    n_neighbors=30,  # Neighbors for moment calculation
)
```

## Velocity Estimation

### Stochastic Mode (Default)

```python
# Stochastic model: uses first and second moments
scv.tl.velocity(adata, mode="stochastic")
```

### Dynamical Mode (Recommended)

```python
# Dynamical model: infers full transcriptional dynamics per gene
# More accurate but slower; recovers latent time, rates, states
scv.tl.recover_dynamics(adata, n_jobs=-1)
scv.tl.velocity(adata, mode="dynamical")

# Access recovered kinetic parameters
scv.tl.latent_time(adata)  # Inferred latent time in adata.obs["latent_time"]
```

### Deterministic Mode

```python
# Simple steady-state ratio model (fastest, least accurate)
scv.tl.velocity(adata, mode="deterministic")
```

## Velocity Graph and Embedding

```python
# Compute velocity graph (cell transition probabilities)
scv.tl.velocity_graph(adata)

# Project velocities onto embedding
scv.tl.velocity_embedding(adata, basis="umap")
```

## Visualization

```python
# Streamline plot (most common)
scv.pl.velocity_embedding_stream(
    adata,
    basis="umap",
    color="cell_type",
    save="velocity_stream.png",
)

# Grid arrows
scv.pl.velocity_embedding_grid(
    adata,
    basis="umap",
    color="cell_type",
    arrow_length=3,
    arrow_size=2,
)

# Individual cell arrows
scv.pl.velocity_embedding(
    adata,
    basis="umap",
    arrow_length=3,
    arrow_size=2,
    dpi=120,
)

# Velocity of individual genes (phase portraits)
scv.pl.velocity(adata, var_names=["Cpe", "Gnao1", "Ins2", "Adk"])

# Speed and coherence
scv.tl.velocity_confidence(adata)
scv.pl.scatter(adata, color="velocity_confidence", cmap="coolwarm")
```

## Additional Analysis

### Velocity Pseudotime

```python
# Pseudotime derived from velocity graph
scv.tl.velocity_pseudotime(adata)
scv.pl.scatter(adata, color="velocity_pseudotime", cmap="gnuplot")
```

### PAGA with Velocity

```python
# Combine trajectory abstraction with velocity
scv.tl.paga(adata, groups="cell_type")
scv.pl.paga(
    adata,
    basis="umap",
    size=50,
    alpha=0.1,
    min_edge_width=2,
    node_size_scale=1.5,
)
```

### Differential Kinetics

```python
# Identify genes with cluster-specific kinetics (dynamical mode only)
scv.tl.differential_kinetic_test(adata, groupby="cell_type")
top_genes = adata.var.loc[adata.var["fit_diff_kinetics"], "fit_pval_kinetics"].sort_values()
```

## Standard Workflow

```python
import scvelo as scv

# 1. Load data with spliced/unspliced layers
adata = scv.read("data_with_velocity.h5ad")

# 2. Preprocess
scv.pp.filter_and_normalize(adata, min_shared_counts=20, n_top_genes=2000)
scv.pp.moments(adata, n_pcs=30, n_neighbors=30)

# 3. Estimate velocity (dynamical model recommended)
scv.tl.recover_dynamics(adata, n_jobs=-1)
scv.tl.velocity(adata, mode="dynamical")

# 4. Build velocity graph
scv.tl.velocity_graph(adata)

# 5. Visualize
scv.pl.velocity_embedding_stream(adata, basis="umap", color="cell_type")

# 6. Latent time
scv.tl.latent_time(adata)
scv.pl.scatter(adata, color="latent_time", cmap="gnuplot")
```

## Gotchas

- **Spliced/unspliced required**: Without both layers, velocity cannot be computed.
  Use velocyto, STARsolo, or alevin-fry to quantify spliced/unspliced reads.
- **Gene filtering**: `filter_and_normalize` applies to both layers simultaneously.
  It filters genes with insufficient shared counts across both layers.
- **Moments before velocity**: `scv.pp.moments()` must be called before
  `scv.tl.velocity()`. It computes the neighbor graph and moments internally.
- **Dynamical mode**: Requires `scv.tl.recover_dynamics()` before
  `scv.tl.velocity(mode="dynamical")`. This step is slow but gives the best results.
- **Sparse data**: scVelo handles sparse matrices, but very sparse unspliced
  layers (common in droplet-based data) can produce noisy velocity estimates.
- **Embedding required**: Ensure UMAP or t-SNE is computed before visualization.
  Use `basis="umap"` or `basis="tsne"` in plotting functions.
- **Memory**: For large datasets, `recover_dynamics` can be memory-intensive.
  Use `n_jobs` for parallelization across genes.
- **scVelo vs. velocyto**: scVelo provides the analytical framework; velocyto
  provides the initial spliced/unspliced quantification from BAM files.
