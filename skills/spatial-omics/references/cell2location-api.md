# cell2location API Reference

Bayesian model for spatial deconvolution: maps cell types from scRNA-seq reference onto spatial transcriptomics spots. Two-stage pipeline: (1) learn reference signatures, (2) decompose spatial spots.

## Import Convention

```python
import cell2location
import scanpy as sc
import numpy as np
import pandas as pd
```

## Stage 1: Reference Signature Estimation (RegressionModel)

Estimates cell type-specific gene expression signatures from scRNA-seq data using negative binomial regression, accounting for batch effects.

### The scRNA-seq Reference Must Be User-Supplied

cell2location cannot run without a matched scRNA-seq reference, and **no such reference ships with this environment or can be downloaded** (no network egress). The user must provide it.

The reference file must satisfy this contract:

| Requirement | Detail |
|-|-|
| Format | `.h5ad` (AnnData) |
| `.X` | **Raw integer counts** — not normalized, log-transformed, or scaled |
| Cell type column in `.obs` | Discrete annotation used to build signatures (`labels_key`) |
| Batch column in `.obs` | Sample/donor/10x-reaction identifier (`batch_key`), if the reference spans multiple batches |
| Tissue match | Same tissue type as the spatial data — a mismatched reference produces unreliable abundances |
| Gene identifiers | Same namespace (symbols vs Ensembl IDs) as the spatial data, or the gene intersection in Stage 2 collapses |

If no reference is available, report that as a blocker — do not fabricate one or proceed with a mismatched public dataset.

### Gene Filtering

```python
# Path supplied by the user; there is no default/bundled reference.
adata_ref = sc.read_h5ad(reference_h5ad_path)

# Inspect .obs to find the real cell type and batch column names before setup.
print(adata_ref.obs.columns.tolist())

# Filter genes: keep informative genes, remove low-quality
from cell2location.utils.filtering import filter_genes
selected = filter_genes(
    adata_ref,
    cell_count_cutoff=15,          # gene must be in >= 15 cells
    cell_percentage_cutoff2=0.05,  # gene in >= 5% of at least one cell type
    nonz_mean_cutoff=1.12          # mean expression in non-zero cells
)
adata_ref = adata_ref[:, selected].copy()
```

### Setup and Training

```python
# "sample" / "cell_type" below are PLACEHOLDERS. Substitute the actual column
# names present in adata_ref.obs — a name that is not there raises KeyError.
# If the reference has no batch structure, pass batch_key=None.
cell2location.models.RegressionModel.setup_anndata(
    adata=adata_ref,
    batch_key="sample",        # batch/sample column in .obs, or None
    labels_key="cell_type"     # cell type annotation column in .obs
)

reg_model = cell2location.models.RegressionModel(adata_ref)

reg_model.train(
    max_epochs=250,            # usually converges in 200-300 epochs
    batch_size=2500,           # cells per mini-batch
    train_size=1.0,            # use all data (no validation split)
    lr=0.002
)

# Check convergence.
# plot_history(n) SKIPS THE FIRST n EPOCHS of the ELBO curve — it is a start
# offset, not a percentage and not a window of the tail. Early epochs have huge
# loss values that flatten the informative part of the curve, so skip enough of
# them to see convergence: with max_epochs=250, ~20 is a reasonable offset.
reg_model.plot_history(20)     # plot ELBO from epoch 20 onward
reg_model.plot_QC()            # quality control visualization
```

### Export Reference Signatures

```python
adata_ref = reg_model.export_posterior(
    adata_ref,
    sample_kwargs={
        "num_samples": 1000,
        "batch_size": 2500
    },
    add_to_varm=["means", "stds", "q05", "q95"],
    scale_average_detection=True
)

# Key output: gene x cell_type matrix of mean expression signatures
inf_aver = adata_ref.varm["means_per_cluster_mu_fg"]
print(f"Reference signatures: {inf_aver.shape}")
# Expected: (n_genes, n_cell_types)

# Save reference with signatures for reuse
adata_ref.write("scRNA_reference_with_signatures.h5ad")
```

### What is in varm After Export

| Key | Shape | Description |
|-----|-------|-------------|
| `means_per_cluster_mu_fg` | (genes, cell_types) | Mean foreground expression per cell type (main output) |
| `stds_per_cluster_mu_fg` | (genes, cell_types) | Standard deviation |
| `q05_per_cluster_mu_fg` | (genes, cell_types) | 5th percentile (lower bound) |
| `q95_per_cluster_mu_fg` | (genes, cell_types) | 95th percentile (upper bound) |

## Stage 2: Spatial Mapping (Cell2location)

Decomposes spatial spots into cell type abundances using the reference signatures.

### Prepare Spatial Data

```python
adata_vis = sc.read_visium("path/to/spaceranger_output/")
# or
adata_vis = sc.read_h5ad("spatial_data.h5ad")

# Remove mitochondrial genes (they confound spatial mapping)
adata_vis.var["mt"] = adata_vis.var_names.str.startswith("MT-")
adata_vis = adata_vis[:, ~adata_vis.var["mt"]].copy()

# Intersect genes between reference and spatial data
intersect = np.intersect1d(adata_vis.var_names, inf_aver.index)
adata_vis = adata_vis[:, intersect].copy()
inf_aver = inf_aver.loc[intersect, :].copy()
print(f"Shared genes: {len(intersect)}")
```

### Setup and Training

```python
# batch_key must name a column that exists in adata_vis.obs. Visium output read
# via sc.read_visium() has NO "sample" column — passing one raises KeyError.
# Use None for a single slide, or add the column yourself when combining slides.
cell2location.models.Cell2location.setup_anndata(
    adata=adata_vis,
    batch_key=None        # or an existing .obs column when mapping multiple slides
)

mod = cell2location.models.Cell2location(
    adata_vis,
    cell_state_df=inf_aver,       # reference signatures from Stage 1
    N_cells_per_location=30,      # expected cells per spot (CRITICAL)
    detection_alpha=200            # within-slide technical variability
)

mod.train(
    max_epochs=30000,             # typically converges in 15k-30k
    batch_size=None,              # full batch for Visium-sized data
    train_size=1.0,
    lr=0.002
)

# Check convergence — argument is a start offset (epochs to skip), see Stage 1.
# With max_epochs=30000, skip far more than 20 to see the informative tail.
mod.plot_history(1000)            # ELBO from epoch 1000 onward
```

### Critical Hyperparameters

| Parameter | Guidance |
|-----------|----------|
| `N_cells_per_location` | Estimate from histology (count nuclei in a spot). Visium: 5-30. Slide-seq: 1-5. Visium HD 8um: 1-3. |
| `detection_alpha` | Technical variability. 200 = low variability (uniform slides). 20 = high variability (heterogeneous). |

### Export Cell Type Abundances

```python
adata_vis = mod.export_posterior(
    adata_vis,
    sample_kwargs={
        "num_samples": 1000,
        "batch_size": adata_vis.n_obs
    },
    add_to_obsm=["means", "stds", "q05", "q95"]
)

# Results in adata_vis.obsm:
print(adata_vis.obsm["means_cell_abundance_w_sf"].shape)
# (n_spots, n_cell_types)
```

### What is in obsm After Export

| Key | Shape | Description |
|-----|-------|-------------|
| `means_cell_abundance_w_sf` | (spots, cell_types) | Mean absolute cell abundance per spot (main result) |
| `stds_cell_abundance_w_sf` | (spots, cell_types) | Standard deviation |
| `q05_cell_abundance_w_sf` | (spots, cell_types) | 5th percentile (lower bound) |
| `q95_cell_abundance_w_sf` | (spots, cell_types) | 95th percentile (upper bound) |

## Visualization

```python
# Spatial plot of specific cell types
from cell2location.utils import select_slide

# Add cell type abundances to .obs for plotting
adata_vis.obs[adata_vis.uns['mod']['factor_names']] = \
    adata_vis.obsm['means_cell_abundance_w_sf']

# Plot with scanpy's spatial function
sc.pl.spatial(
    adata_vis,
    color=["T_cells", "B_cells", "Macrophages"],
    cmap="magma",
    size=1.3,
    ncols=3,
    vmin=0,
    img_key="hires"
)
```

## Save / Load

```python
# Save model
mod.save("cell2location_model/", overwrite=True)

# Load model
mod = cell2location.models.Cell2location.load(
    "cell2location_model/", adata_vis
)

# Save results
adata_vis.write("spatial_with_cell2location.h5ad")
```

## Complete Two-Stage Workflow

```python
import cell2location
import scanpy as sc
import numpy as np
from cell2location.utils.filtering import filter_genes

# === Stage 1: Reference signatures ===
# reference_h5ad_path is supplied by the user; batch/label column names are read
# off the actual reference, not assumed.
adata_ref = sc.read_h5ad(reference_h5ad_path)
selected = filter_genes(adata_ref, cell_count_cutoff=15,
                        cell_percentage_cutoff2=0.05, nonz_mean_cutoff=1.12)
adata_ref = adata_ref[:, selected].copy()

cell2location.models.RegressionModel.setup_anndata(
    adata_ref, batch_key="sample", labels_key="cell_type"
)
reg_model = cell2location.models.RegressionModel(adata_ref)
reg_model.train(max_epochs=250, batch_size=2500, train_size=1.0, lr=0.002)

adata_ref = reg_model.export_posterior(
    adata_ref,
    sample_kwargs={"num_samples": 1000, "batch_size": 2500},
    scale_average_detection=True
)
inf_aver = adata_ref.varm["means_per_cluster_mu_fg"]

# === Stage 2: Spatial mapping ===
adata_vis = sc.read_visium("spatial_output/")
adata_vis.var["mt"] = adata_vis.var_names.str.startswith("MT-")
adata_vis = adata_vis[:, ~adata_vis.var["mt"]].copy()

intersect = np.intersect1d(adata_vis.var_names, inf_aver.index)
adata_vis = adata_vis[:, intersect].copy()
inf_aver = inf_aver.loc[intersect, :].copy()

cell2location.models.Cell2location.setup_anndata(adata_vis, batch_key=None)
mod = cell2location.models.Cell2location(
    adata_vis, cell_state_df=inf_aver,
    N_cells_per_location=15, detection_alpha=200
)
mod.train(max_epochs=30000, batch_size=None, train_size=1.0, lr=0.002)

adata_vis = mod.export_posterior(
    adata_vis,
    sample_kwargs={"num_samples": 1000, "batch_size": adata_vis.n_obs},
    add_to_obsm=["means", "stds", "q05", "q95"]
)

adata_vis.write("spatial_deconvolution_results.h5ad")
mod.save("cell2location_model/", overwrite=True)
```

## Gotchas

- The scRNA-seq reference is **user-supplied**. None is bundled and none can be downloaded. Without one, cell2location cannot run — report the blocker.
- `batch_key` must name a column that actually exists in `.obs`. `"sample"` is a placeholder, not a real default: `sc.read_visium()` output has no such column and passing it raises `KeyError`. Verify against `adata.obs.columns` first, or pass `None`.
- `plot_history(n)` skips the **first** `n` epochs — it is a start offset, not "the last n%" and not a tail window. Scale it to `max_epochs` (e.g. ~20 for a 250-epoch regression fit, ~1000 for a 30k-epoch mapping fit).
- cell2location expects **raw counts** (not normalized). Do not pass log-transformed or scaled data.
- Always remove mitochondrial genes from spatial data before mapping. They are highly expressed but uninformative for cell type deconvolution.
- Gene intersection between reference and spatial data is mandatory. Mismatched gene sets cause silent errors or poor results.
- `N_cells_per_location` is the most impactful hyperparameter. Overestimating it leads to over-deconvolution; underestimating it misses cell types. Estimate from histology when possible.
- `detection_alpha=200` is a good default for most Visium datasets. Lower it (e.g., 20) for datasets with high technical variability across the slide.
- Training 30k epochs with full batch on Visium (~5k spots) takes ~30 min on GPU. Use `accelerator="gpu"` if available.
- `export_posterior()` samples from the posterior. More samples (`num_samples`) gives more stable estimates but takes longer. 1000 is standard.
- The `_w_sf` suffix in obsm keys stands for "with size factor" (accounts for total mRNA per spot).
- Use `filter_genes()` from `cell2location.utils.filtering` for the reference. Scanpy's `highly_variable_genes` selects for variability, not informativeness per cell type -- they serve different purposes.
