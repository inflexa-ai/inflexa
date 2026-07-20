# Squidpy API Reference

Spatial single-cell analysis toolkit. Provides graph-based spatial statistics, ligand-receptor interaction testing, and spatial visualizations built on top of AnnData and scanpy.

## Import Convention

```python
import squidpy as sq
import scanpy as sc
```

## Spatial Graph: sq.gr.spatial_neighbors

Builds a spatial connectivity graph from cell coordinates. This is the foundation for all spatial statistics.

```python
sq.gr.spatial_neighbors(
    adata,
    coord_type="generic",      # "generic" (coordinates in .obsm) or "grid" (Visium)
    spatial_key="spatial",     # key in .obsm holding coordinates
    n_neighs=6,                # number of nearest neighbors (for generic)
    n_rings=1,                 # number of hexagonal rings (for Visium grid)
    delaunay=False,            # use Delaunay triangulation instead of kNN
    set_diag=False             # include self-loops
)
# Results stored in:
#   adata.obsp['spatial_connectivities']  — binary adjacency
#   adata.obsp['spatial_distances']       — distance weights
```

### Coord Type Options

| coord_type | Use case |
|------------|----------|
| `"generic"` | Any spatial coordinates (MERFISH, Xenium, Slide-seq, etc.) |
| `"grid"` | Regular grid layouts (Visium spots) |

### For Visium Data

```python
# Visium spots have hexagonal grid topology
sq.gr.spatial_neighbors(adata, coord_type="grid", n_rings=1)
# n_rings=1: immediate neighbors only (6 neighbors per spot)
# n_rings=2: extend to second ring (18 neighbors)
```

## Neighborhood Enrichment: sq.gr.nhood_enrichment

Tests whether pairs of cell types co-localize (enrichment) or repel (depletion) more than expected by chance. Uses permutation testing.

```python
sq.gr.nhood_enrichment(
    adata,
    cluster_key="cell_type",   # column in .obs with cell type labels
    n_perms=1000,              # number of permutations
    seed=42
)
# Results stored in:
#   adata.uns['cell_type_nhood_enrichment']['zscore']  — z-score matrix (cell types x cell types)
#   adata.uns['cell_type_nhood_enrichment']['count']   — observed neighbor counts

# Plot
sq.pl.nhood_enrichment(adata, cluster_key="cell_type")
```

## Co-occurrence: sq.gr.co_occurrence

Measures spatial co-occurrence of cell types as a function of distance. Unlike nhood_enrichment (binary neighbor/not), this captures distance-dependent patterns.

```python
sq.gr.co_occurrence(
    adata,
    cluster_key="cell_type",
    spatial_key="spatial",
    interval=50,               # distance bin width (in coordinate units)
    n_splits=None              # split computation for memory efficiency
)
# Results stored in:
#   adata.uns['cell_type_co_occurrence']

# Plot
sq.pl.co_occurrence(
    adata,
    cluster_key="cell_type",
    clusters=["T_cell", "B_cell"],    # specific types to plot (optional)
    figsize=(8, 4)
)
```

## Spatial Autocorrelation: sq.gr.spatial_autocorr

Measures spatial autocorrelation of continuous variables (gene expression). Supports Moran's I and Geary's C — both are global statistics; Geary's C is built on squared pairwise differences, so it responds more strongly to short-range variation.

```python
# Moran's I (default) — values near 1 = strong spatial clustering
sq.gr.spatial_autocorr(
    adata,
    mode="moran",              # "moran" or "geary"
    genes=None,                # list of genes to test (None = all in .var)
    n_perms=100,               # permutations for p-value (None = analytical)
    n_jobs=4                   # parallel jobs
)
# Results stored in adata.uns['moranI'] (DataFrame):
#   columns: I, pval_norm, var_norm, pval_z_sim, pval_sim, var_sim
#   index: gene names

# Top spatially variable genes
moranI = adata.uns['moranI']
top_svg = moranI.sort_values('I', ascending=False).head(20)
print(top_svg[['I', 'pval_sim']])

# Geary's C — values near 0 = strong spatial clustering (inverted vs Moran)
sq.gr.spatial_autocorr(adata, mode="geary")
# Results in adata.uns['gearyC']
```

### Moran's I vs Geary's C

- **Moran's I**: Global measure. Range [-1, 1]. I > 0 = positive autocorrelation (clustering). I ~ 0 = random. I < 0 = dispersed.
- **Geary's C**: Global measure, but weighted by squared differences between neighbours, so it is more sensitive to short-range variation than Moran's I. Range [0, 2]. C < 1 = positive autocorrelation. C ~ 1 = random. C > 1 = negative autocorrelation.

## Ligand-Receptor Interaction: sq.gr.ligrec — NOT AVAILABLE

**`sq.gr.ligrec()` cannot run in this environment. Do not write code that calls it.**

Two independent blockers, both fatal:

1. The `omnipath` Python package is **not installed**. `sq.gr.ligrec` imports it, so the call fails at import time — before any parameter is even read.
2. Even with the package present, its interaction resources (CellPhoneDB, CellChatDB) are fetched from a **web API**, and there is no network egress.

There is no drop-in offline substitute: no ligand-receptor pair resource ships in the reference data catalog, and the squidpy entry point is unusable regardless of how interactions are supplied.

If ligand-receptor analysis is requested, **report the blocker** rather than silently substituting a different analysis. If the user supplies their own ligand-receptor pair table (a DataFrame with source/target gene columns), a permutation test can be implemented directly against the expression matrix and the spatial graph — but state the assumptions and that it is not a validated CellPhoneDB run.

Spatially-aware co-localization questions that do **not** need an LR database are fully supported offline — use `sq.gr.nhood_enrichment()` and `sq.gr.co_occurrence()` above.

## Plotting: sq.pl

### Spatial Scatter

Main plotting function for spatial data. Works with Visium, Slide-seq, MERFISH, Xenium, etc.

```python
# Color by gene expression
sq.pl.spatial_scatter(
    adata,
    color="Cd8a",
    spatial_key="spatial",     # key in .obsm
    shape=None,                # None = auto-detect, "circle", "hex"
    size=1.0,                  # point/spot size
    cmap="viridis",
    figsize=(8, 8),
    save="spatial_cd8a.png"
)

# Color by cluster labels
sq.pl.spatial_scatter(
    adata,
    color="cell_type",
    spatial_key="spatial",
    palette="tab20",
    legend_loc="right margin",
    figsize=(10, 8)
)

# Multiple panels
sq.pl.spatial_scatter(
    adata,
    color=["cell_type", "Cd8a", "Cd4"],
    ncols=3,
    figsize=(18, 6)
)
```

### Neighborhood Enrichment Plot

```python
sq.pl.nhood_enrichment(
    adata,
    cluster_key="cell_type",
    method="average",          # linkage method for dendrogram
    cmap="coolwarm",
    vmin=-50, vmax=50,
    figsize=(6, 6)
)
```

## Complete Visium Workflow

```python
import squidpy as sq
import scanpy as sc

# Load Visium data
adata = sc.read_visium("path/to/spaceranger_output/")
adata.var_names_make_unique()

# Standard preprocessing
sc.pp.filter_genes(adata, min_cells=10)
sc.pp.normalize_total(adata, target_sum=1e4)
sc.pp.log1p(adata)
sc.pp.highly_variable_genes(adata, n_top_genes=3000)
sc.pp.pca(adata)
sc.pp.neighbors(adata)
sc.tl.umap(adata)
sc.tl.leiden(adata, resolution=0.5, key_added="clusters")

# Build spatial graph
sq.gr.spatial_neighbors(adata, coord_type="grid", n_rings=1)

# Spatial statistics
sq.gr.nhood_enrichment(adata, cluster_key="clusters", n_perms=1000)
sq.gr.co_occurrence(adata, cluster_key="clusters")
sq.gr.spatial_autocorr(adata, mode="moran", n_perms=100, n_jobs=4)

# NOTE: no ligand-receptor step here — sq.gr.ligrec is unavailable offline (see above)

# Visualization
sq.pl.spatial_scatter(adata, color="clusters", figsize=(8, 8))
sq.pl.nhood_enrichment(adata, cluster_key="clusters")
sq.pl.spatial_scatter(adata, color=adata.uns['moranI'].head(4).index.tolist())
```

## Gotchas

- Always call `sq.gr.spatial_neighbors()` before any spatial statistic function. Without a spatial graph, all `sq.gr.*` functions will fail.
- `sc.read_visium()` is deprecated in current scanpy; it still works but warns and names `sq.read.visium()` as the replacement. Prefer `sq.read.visium()` for new code — squidpy is installed.
- `sq.gr.moran()` is **deprecated**. Use `sq.gr.spatial_autocorr(mode="moran")` instead.
- `coord_type="grid"` is for Visium (hexagonal grid). Use `"generic"` for all other technologies (MERFISH, Xenium, Slide-seq).
- `sq.gr.ligrec()` is **unavailable**: the `omnipath` package is not installed and cannot be installed (no network egress), and its interaction resources are web-fetched. Report the blocker instead of attempting the call. See the ligrec section above.
- `use_raw=True` in `spatial_autocorr` uses `adata.raw.X`. If `.raw` is not set, this silently uses `.X` in older versions but may error in newer ones.
- `n_perms=None` in `spatial_autocorr` uses analytical p-values (faster but less accurate for small datasets). Use permutation-based p-values (`n_perms=100+`) for publication results.
- `sq.pl.spatial_scatter` requires coordinates in `adata.obsm['spatial']` (default key). For non-standard keys, pass `spatial_key=`.
