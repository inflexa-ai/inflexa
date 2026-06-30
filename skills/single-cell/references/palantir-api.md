# Palantir API Reference

Trajectory analysis by modeling differentiation as a stochastic process on a
low-dimensional manifold. Computes pseudotime, fate probabilities, and gene
expression trends along lineages.

## Preprocessing

```python
import palantir
import scanpy as sc

# Load data
adata = sc.read_h5ad("single_cell_data.h5ad")

# Palantir-specific preprocessing
sc.pp.normalize_per_cell(adata)
palantir.preprocess.log_transform(adata)
sc.pp.highly_variable_genes(adata, n_top_genes=1500, flavor="cell_ranger")
sc.pp.pca(adata)
```

## Diffusion Maps

Required before running Palantir trajectory inference.

```python
# Compute diffusion maps (stores in adata.obsm["X_diffmap"])
palantir.utils.run_diffusion_maps(adata, n_components=10)

# Determine multiscale space (refined diffusion components)
# Stores in adata.obsm["X_palantir_multiscale"]
palantir.utils.determine_multiscale_space(adata)
```

## Running Palantir

### Core Trajectory Inference

```python
import pandas as pd

# Define a start cell (e.g., stem cell or progenitor)
start_cell = "AACGTTGCAGTCGT-1"

# Option 1: Auto-detect terminal states
pr_res = palantir.core.run_palantir(
    adata,
    early_cell=start_cell,
    num_waypoints=500,   # Number of waypoints for Markov chain (default 1200)
    knn=30,              # Nearest neighbors for graph construction
    n_jobs=-1,           # Parallel processing
    seed=42,
)

# Option 2: Provide known terminal states
terminal_states = pd.Series(
    ["Erythroid", "Monocyte", "Dendritic"],
    index=["cell_001", "cell_002", "cell_003"],  # Cell barcodes
)

pr_res = palantir.core.run_palantir(
    adata,
    early_cell=start_cell,
    terminal_states=terminal_states,
    num_waypoints=500,
    knn=30,
    n_jobs=-1,
    seed=42,
)
```

### Accessing Results

```python
# Results stored in AnnData
adata.obs["palantir_pseudotime"]          # Pseudotime (0 to 1)
adata.obs["palantir_entropy"]             # Differentiation potential
adata.obsm["palantir_fate_probabilities"] # Fate probability matrix (cells x fates)

# Also accessible from the returned result object
pr_res.pseudotime       # pd.Series: pseudotime per cell
pr_res.entropy          # pd.Series: entropy per cell
pr_res.branch_probs     # pd.DataFrame: fate probabilities (cells x branches)
```

## Terminal State Selection

```python
# Identify terminal states automatically
terminal_states, excluded = palantir.core.identify_terminal_states(
    ms_data,           # Multiscale diffusion components (DataFrame)
    early_cell=start_cell,
    knn=30,
    num_waypoints=1200,
)
# Returns: (np.ndarray of terminal cell IDs, pd.Index of excluded boundary cells)
```

## Gene Expression Trends

Compute how genes change along each differentiation branch over pseudotime.
Requires the `mellon` package (dependency of palantir).

```python
# Step 1: Select branch cells (assigns cells to lineages)
palantir.presults.select_branch_cells(adata)

# Step 2: Compute gene trends using imputed expression
gene_trends = palantir.presults.compute_gene_trends(
    adata,
    expression_key="MAGIC_imputed_data",  # Use imputed data for smooth trends
    masks_key="branch_masks",
    gene_trend_key="palantir_gene_trends",
)
# Results stored in:
#   adata.varm["palantir_gene_trends_{branch}"]   - trend values (genes x pseudotime grid)
#   adata.uns["palantir_gene_trends_{branch}_pseudotime"] - pseudotime grid values

# Step 3: Visualize
genes = ["CD34", "GATA1", "MPO", "IRF8"]
palantir.plot.plot_gene_trends(adata, genes)

# Heatmap visualization with z-score scaling
palantir.plot.plot_gene_trend_heatmaps(adata, genes, scaling="z-score")
```

## Imputation with MAGIC

Palantir often uses MAGIC-imputed data for smoother gene trends.

```python
import magic

# Impute expression (stores in adata.obsm["MAGIC_imputed_data"] or layers)
magic_op = magic.MAGIC()
adata.obsm["MAGIC_imputed_data"] = magic_op.fit_transform(
    adata, genes="all_genes"
)
```

## Visualization

```python
# Plot pseudotime on embedding
palantir.plot.plot_palantir_results(adata, s=3)

# Plot fate probabilities for each lineage
palantir.plot.plot_terminal_state_probs(adata)

# Highlight terminal states
palantir.plot.highlight_cells_on_umap(adata, terminal_states.index)
```

## Standard Workflow

```python
import palantir
import scanpy as sc
import pandas as pd

# 1. Preprocess
sc.pp.normalize_per_cell(adata)
palantir.preprocess.log_transform(adata)
sc.pp.highly_variable_genes(adata, n_top_genes=1500, flavor="cell_ranger")
sc.pp.pca(adata)

# 2. Diffusion maps
palantir.utils.run_diffusion_maps(adata, n_components=10)
palantir.utils.determine_multiscale_space(adata)

# 3. UMAP for visualization
sc.pp.neighbors(adata)
sc.tl.umap(adata)

# 4. Run Palantir
start_cell = "BARCODE-1"
pr_res = palantir.core.run_palantir(adata, early_cell=start_cell, num_waypoints=500)

# 5. Gene trends
palantir.presults.select_branch_cells(adata)
palantir.presults.compute_gene_trends(adata, expression_key="MAGIC_imputed_data")
palantir.plot.plot_gene_trends(adata, ["CD34", "GATA1", "MPO"])
```

## Gotchas

- **Start cell selection**: The start cell significantly affects pseudotime ordering.
  Choose a known progenitor or stem cell. Verify by checking its position in
  diffusion component space.
- **Terminal states**: If not provided, Palantir auto-detects them from the Markov
  chain stationary distribution. Manual specification is recommended when biology
  is known.
- **num_waypoints**: Lower values (500) speed computation but reduce resolution.
  Default is 1200. For large datasets (>50k cells), 500 is usually sufficient.
- **Imputed data for trends**: Gene trends are much smoother with MAGIC-imputed data.
  Raw counts produce noisy trends.
- **AnnData storage**: Recent Palantir versions store all results directly in the
  AnnData object (obs, obsm, varm, uns). The returned result object mirrors this.
- **Diffusion maps first**: Always run `run_diffusion_maps` and
  `determine_multiscale_space` before `run_palantir`.
