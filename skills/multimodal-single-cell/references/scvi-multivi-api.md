# scvi-tools: MultiVI API Reference

Joint probabilistic model for RNA + ATAC (Multiome) data. Also handles mosaic integration where some cells have only one modality.

## Import

```python
import scvi
import scanpy as sc
from mudata import MuData
```

## Data Setup

### With MuData (Preferred for Multiome)

```python
# mdata.mod['rna'] = AnnData with RNA counts
# mdata.mod['atac'] = AnnData with ATAC peak counts

scvi.model.MULTIVI.setup_mudata(
    mdata,
    rna_layer=None,          # layer in rna mod (None = .X)
    atac_layer=None,         # layer in atac mod (None = .X)
    batch_key="batch",       # batch column in .obs (or None)
    modalities={
        "rna_layer": "rna",
        "atac_layer": "atac",
        "batch_key": "rna"   # which mod holds the batch column
    }
)
```

### With AnnData (Single Object) — DEPRECATED

`setup_anndata` is deprecated for MULTIVI as of scvi-tools 1.4; prefer `setup_mudata` above. Use this path only for a pre-concatenated single AnnData.

```python
# adata.X = concatenated [RNA genes | ATAC peaks], in that order

scvi.model.MULTIVI.setup_anndata(
    adata,
    batch_key="batch",
    layer=None
)

# setup_anndata does NOT record the gene/peak boundary. On the AnnData path
# n_genes and n_regions are REQUIRED at construction — they define the split.
# Omitting them raises: with MuData they can be inferred from summary_stats,
# with a plain AnnData there is nothing to infer from and setup asserts.
model = scvi.model.MULTIVI(
    adata,
    n_genes=n_rna_features,       # size of the leading RNA block
    n_regions=n_atac_features     # size of the trailing ATAC block
)
```

## Model Initialization

```python
model = scvi.model.MULTIVI(
    mdata,
    n_latent=20,
    n_genes=mdata.mod['rna'].n_vars,      # number of RNA features
    n_regions=mdata.mod['atac'].n_vars     # number of ATAC peaks
)
```

### Key Constructor Parameters

| Parameter | Default | Notes |
|-----------|---------|-------|
| `n_latent` | 20 | Latent dimensions; 10-30 typical |
| `n_genes` | required | Number of RNA features (genes) |
| `n_regions` | required | Number of ATAC features (peaks) |
| `n_hidden` | 256 | Hidden layer size |
| `n_layers_encoder` | 2 | Encoder depth |
| `n_layers_decoder` | 2 | Decoder depth |
| `region_factors` | True | Learn region-specific scaling factors |

## Training

```python
model.train(
    max_epochs=500,       # 300-500 typical
    train_size=0.9,
    batch_size=256,
    early_stopping=True
)

# Monitor convergence
model.history["elbo_train"].plot()
```

## Latent Representation

Joint embedding integrating RNA + ATAC. Use for clustering, UMAP, trajectory analysis.

```python
latent = model.get_latent_representation()
mdata.obsm["X_multiVI"] = latent

# Downstream clustering
sc.pp.neighbors(mdata, use_rep="X_multiVI")
sc.tl.umap(mdata)
sc.tl.leiden(mdata, resolution=0.8)
```

## Normalized Gene Expression

Denoised RNA expression from the joint model.

```python
rna_normalized = model.get_normalized_expression(
    modality="expression",    # "expression" for RNA
    n_samples=25,
    return_mean=True
)
# DataFrame (cells x genes)
```

## Accessibility Estimates

Imputed / denoised chromatin accessibility from the joint model.

```python
accessibility = model.get_accessibility_estimates(
    n_samples=25,
    return_mean=True
)
# DataFrame (cells x peaks)
# Values represent estimated accessibility probabilities

# Store in AnnData for visualization
mdata.mod['atac'].layers["imputed"] = accessibility.values
```

## Cross-Modality Imputation

MultiVI can impute one modality from the other. This is particularly useful for mosaic integration where some cells lack one modality.

```python
# For cells with only RNA: impute their ATAC accessibility
accessibility_imputed = model.get_accessibility_estimates(
    n_samples=25,
    return_mean=True
)

# For cells with only ATAC: impute their RNA expression
rna_imputed = model.get_normalized_expression(
    modality="expression",
    n_samples=25,
    return_mean=True
)
```

## Differential Accessibility

```python
da_results = model.differential_accessibility(
    groupby="cell_type",
    group1="celltype_A",
    group2="celltype_B"
)
# Returns DataFrame with: proba_da, lfc_mean, lfc_median, bayes_factor, etc.
```

## Differential Expression (RNA)

```python
de_results = model.differential_expression(
    groupby="cell_type",
    group1="celltype_A",
    group2="celltype_B"
)
```

## Save / Load

```python
model.save("multivi_model/")
model = scvi.model.MULTIVI.load("multivi_model/", adata=mdata)
```

## Complete Multiome Workflow

```python
import scvi
import scanpy as sc
import muon as mu
from muon import atac as ac

# Load 10x Multiome data
mdata = mu.read_10x_h5("multiome_filtered.h5")

# RNA preprocessing (keep raw counts in .X)
rna = mdata.mod['rna']
sc.pp.filter_genes(rna, min_cells=3)
sc.pp.highly_variable_genes(rna, n_top_genes=4000, flavor="seurat_v3")
rna = rna[:, rna.var['highly_variable']].copy()
mdata.mod['rna'] = rna

# ATAC preprocessing
atac = mdata.mod['atac']
sc.pp.filter_genes(atac, min_cells=10)

# Sync cells
mu.pp.intersect_obs(mdata)

# Setup and train MultiVI
scvi.model.MULTIVI.setup_mudata(
    mdata,
    rna_layer=None,
    atac_layer=None,
    batch_key="batch",
    modalities={"rna_layer": "rna", "atac_layer": "atac", "batch_key": "rna"}
)

model = scvi.model.MULTIVI(
    mdata,
    n_latent=20,
    n_genes=mdata.mod['rna'].n_vars,
    n_regions=mdata.mod['atac'].n_vars
)
model.train(max_epochs=500, early_stopping=True)

# Extract results
mdata.obsm["X_multiVI"] = model.get_latent_representation()

sc.pp.neighbors(mdata, use_rep="X_multiVI")
sc.tl.umap(mdata)
sc.tl.leiden(mdata, resolution=0.8)

# Get denoised outputs
rna_norm = model.get_normalized_expression(modality="expression", n_samples=25)
atac_imp = model.get_accessibility_estimates(n_samples=25)

model.save("multivi_model/")
```

## Mosaic Integration

MultiVI handles datasets where not all cells have both modalities. For example, integrating a scRNA-seq dataset with a scATAC-seq dataset (unpaired).

```python
# Create MuData where some cells have RNA only, some ATAC only
# MultiVI handles the missing modality during training
# The model learns a shared latent space and can impute the missing modality
```

The model uses the presence/absence of each modality per cell during training. Cells with both modalities provide the strongest training signal; cells with only one modality benefit from the learned cross-modal relationships.

## Gotchas

- MultiVI expects **raw integer counts** in `.X` for both RNA and ATAC. Do not pass normalized data.
- `n_genes` and `n_regions` must exactly match the number of RNA and ATAC features in your data. Set them **after** all feature filtering/HVG selection — a stale count silently misaligns the gene/peak split and corrupts every downstream output. Pass them explicitly rather than relying on MuData inference.
- `setup_anndata` is deprecated for MULTIVI (scvi-tools 1.4+); use `setup_mudata` with a MuData object.
- For MuData, `setup_mudata()` requires the `modalities` dict mapping each data field to its modality name.
- `get_accessibility_estimates()` returns probabilities (0-1 range), not raw counts.
- `get_normalized_expression(modality="expression")` — the `modality` parameter selects RNA vs. ATAC output.
- GPU training is strongly recommended for large datasets: `model.train(..., accelerator="gpu")`.
- When loading a saved model, you must pass the same AnnData/MuData object used for training (or one with identical var_names).
- For mosaic integration, cells missing a modality should have all-zero values in the missing modality's feature space.
