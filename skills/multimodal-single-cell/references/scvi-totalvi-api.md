# scvi-tools: TOTALVI API Reference

Joint probabilistic model for CITE-seq data (RNA + surface protein). Handles modality-specific noise, protein background correction, and batch effects.

## Import

```python
import scvi
import scanpy as sc
```

## Data Setup

### With AnnData (Single Object)

Protein counts stored in `adata.obsm`. This is the standard CITE-seq layout.

```python
# adata.X = RNA counts (cells x genes)
# adata.obsm["protein_expression"] = protein counts (cells x proteins)
# adata.uns["protein_names"] = list of protein names (optional)

scvi.model.TOTALVI.setup_anndata(
    adata,
    batch_key="batch",                              # batch column in .obs (or None)
    protein_expression_obsm_key="protein_expression",
    protein_names_uns_key="protein_names"            # optional
)
```

### With MuData

```python
scvi.model.TOTALVI.setup_mudata(
    mdata,
    rna_layer=None,              # layer in mdata['rna'] (None = .X)
    protein_layer=None,          # layer in mdata['prot'] (None = .X)
    batch_key="batch",
    modalities={
        "rna_layer": "rna",
        "protein_layer": "prot",
        "batch_key": "rna"       # which modality holds the batch column
    }
)
```

## Model Initialization

```python
model = scvi.model.TOTALVI(
    adata,
    n_latent=20,                            # latent space dimensions
    gene_likelihood="zinb",                  # zero-inflated negative binomial (default)
    latent_distribution="normal",            # "normal" or "ln" (log-normal)
    empirical_protein_background_prior=True  # learn background from data (recommended)
)
```

### Key Constructor Parameters

| Parameter | Default | Notes |
|-----------|---------|-------|
| `n_latent` | 20 | Latent dimensions; 10-30 typical |
| `gene_likelihood` | `"zinb"` | `"zinb"`, `"nb"`, or `"poisson"` |
| `empirical_protein_background_prior` | `True` | Uses data to set protein background prior; set True for best results |
| `n_hidden` | 256 | Hidden layer size |
| `n_layers_encoder` | 2 | Encoder depth |
| `n_layers_decoder` | 1 | Decoder depth |

## Training

```python
model.train(
    max_epochs=400,       # 400 is a good default; monitor ELBO for convergence
    train_size=0.9,       # fraction for training (rest for validation)
    batch_size=256,
    early_stopping=True,
    plan_kwargs={"lr": 4e-3}
)

# Check convergence
model.history["elbo_train"].plot()
```

## Latent Representation

Joint embedding integrating RNA + protein information. Use for clustering, UMAP, etc.

```python
adata.obsm["X_totalVI"] = model.get_latent_representation()

# Downstream: neighbors, UMAP, clustering
sc.pp.neighbors(adata, use_rep="X_totalVI")
sc.tl.umap(adata)
sc.tl.leiden(adata, resolution=0.8)
```

## Normalized Expression (Denoised)

Returns denoised RNA and/or protein expression values.

```python
# Get both RNA and protein normalized expression
rna_norm, protein_norm = model.get_normalized_expression(
    n_samples=25,                   # Monte Carlo samples for posterior mean
    return_mean=True,
    transform_batch=["batch_0"],    # correct to this batch (optional)
)
# rna_norm: DataFrame (cells x genes)
# protein_norm: DataFrame (cells x proteins)

# Get only denoised protein expression
_, protein_denoised = model.get_normalized_expression(
    n_samples=25,
    return_mean=True,
)
```

## Protein Foreground Probability

Separates true protein signal from ambient background. Returns probability that each protein measurement reflects true surface expression (foreground) vs. technical noise (background).

```python
protein_fg_prob = model.get_protein_foreground_probability(
    n_samples=1,
    return_mean=True,
    return_numpy=True
)
# Shape: (n_cells, n_proteins)
# Values near 1.0 = likely true signal
# Values near 0.0 = likely background noise

# Use as a binary mask at threshold 0.5
import numpy as np
fg_mask = protein_fg_prob > 0.5
```

### Why This Matters

ADT data has a characteristic bimodal distribution per antibody: a background peak (cells that do not express the protein) and a foreground peak (cells that do). totalVI explicitly models this mixture, giving you a principled way to classify each cell-protein measurement.

## Differential Expression

```python
# RNA differential expression between cell types
de_rna = model.differential_expression(
    groupby="cell_type",
    group1="B_cells",
    group2="T_cells"
)
# Returns DataFrame with columns: proba_de, lfc_mean, lfc_median, bayes_factor, etc.

# Protein differential expression
de_protein = model.differential_expression(
    groupby="cell_type",
    group1="B_cells",
    group2="T_cells",
    protein_prior_count=0.1    # regularization for protein DE
)
```

## Imputing Missing Proteins Across Batches

When batches have different antibody panels, totalVI can impute missing proteins.

```python
# Impute proteins by conditioning on a batch that has them
_, imputed_protein = model.get_normalized_expression(
    n_samples=25,
    return_mean=True,
    transform_batch=["batch_with_full_panel"]
)
```

## Save / Load

```python
model.save("totalvi_model/")
model = scvi.model.TOTALVI.load("totalvi_model/", adata=adata)
```

## Complete CITE-seq Workflow

```python
import scvi
import scanpy as sc

adata = sc.read_h5ad("cite_seq.h5ad")

# Standard RNA preprocessing (totalVI uses raw counts internally)
sc.pp.filter_genes(adata, min_cells=3)
sc.pp.highly_variable_genes(adata, n_top_genes=4000, flavor="seurat_v3")
adata = adata[:, adata.var['highly_variable']].copy()

# Setup (raw counts in .X, protein in .obsm)
scvi.model.TOTALVI.setup_anndata(
    adata,
    batch_key="batch",
    protein_expression_obsm_key="protein_expression"
)

model = scvi.model.TOTALVI(adata, n_latent=20, empirical_protein_background_prior=True)
model.train(max_epochs=400, early_stopping=True)

# Outputs
adata.obsm["X_totalVI"] = model.get_latent_representation()
rna_norm, protein_norm = model.get_normalized_expression(n_samples=25)
fg_prob = model.get_protein_foreground_probability(n_samples=1, return_mean=True)

sc.pp.neighbors(adata, use_rep="X_totalVI")
sc.tl.umap(adata)
sc.tl.leiden(adata, resolution=0.8)

model.save("totalvi_model/")
```

## Gotchas

- totalVI expects **raw integer counts** in `adata.X`, not normalized/log-transformed data. Run HVG selection on raw counts using `flavor="seurat_v3"`.
- `setup_anndata()` must be called before model creation. It registers data fields internally.
- `empirical_protein_background_prior=True` is strongly recommended. Without it, the model uses a default prior that may not match your panel.
- `get_normalized_expression()` returns a tuple `(rna, protein)`. Do not unpack as a single value.
- Protein names in `.uns` are optional but helpful for interpreting DE results.
- For MuData workflows, use `setup_mudata()` with the `modalities` dict specifying which MuData mod holds each data type.
- Training on GPU is significantly faster: `model.train(..., accelerator="gpu")`.
