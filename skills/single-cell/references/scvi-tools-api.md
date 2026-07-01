# scvi-tools API Reference

Deep probabilistic models for single-cell omics. Core model: SCVI for
dimensionality reduction, batch correction, and denoising. SOLO for doublet
detection.

## SCVI Model

### Setup AnnData

```python
import scvi
import scanpy as sc

# Register data fields (call once before model creation)
scvi.model.SCVI.setup_anndata(
    adata,
    layer=None,           # Use adata.X; or "counts" for adata.layers["counts"]
    batch_key="batch",    # Column in obs for batch correction (optional)
    labels_key="labels",  # Column in obs for cell type labels (optional)
    categorical_covariate_keys=["donor", "condition"],  # Additional categoricals
    continuous_covariate_keys=["percent_mito", "n_counts"],  # Continuous covariates
)
```

### Initialize and Train

```python
# Initialize model
model = scvi.model.SCVI(
    adata,
    n_latent=10,            # Latent space dimensions (default 10)
    n_hidden=128,           # Hidden layer size (default 128)
    n_layers=1,             # Number of hidden layers (default 1)
    dropout_rate=0.1,       # Dropout rate (default 0.1)
    dispersion="gene",      # "gene", "gene-batch", "gene-label", "gene-cell"
    gene_likelihood="zinb",  # "zinb", "nb", "poisson"
    latent_distribution="normal",  # "normal" or "ln" (logistic normal)
)

# Train
model.train(
    max_epochs=400,
    batch_size=128,
    train_size=0.9,
    early_stopping=True,
    check_val_every_n_epoch=10,
)
```

### Extract Results

```python
# Latent representation (cells x n_latent)
adata.obsm["X_scVI"] = model.get_latent_representation()

# Use for downstream scanpy analysis
sc.pp.neighbors(adata, use_rep="X_scVI")
sc.tl.umap(adata)
sc.tl.leiden(adata)

# Normalized (denoised) expression
adata.layers["scvi_normalized"] = model.get_normalized_expression(
    library_size=1e4,       # Scale to this total count
    n_samples=25,           # Monte Carlo samples for averaging
    return_numpy=True,
)

# Differential expression (Bayesian)
de_results = model.differential_expression(
    groupby="cell_type",
    group1="CD4 T cells",
    group2="CD8 T cells",
    mode="change",          # "change", "vanilla"
)
# Returns DataFrame: proba_de, bayes_factor, lfc_mean, lfc_median, lfc_std

# Model quality metrics
elbo = model.get_elbo(adata)
recon_error = model.get_reconstruction_error(adata)
```

### Save and Load

```python
# Save model (optionally include anndata)
model.save("./scvi_model", overwrite=True, save_anndata=True)

# Load model
loaded_model = scvi.model.SCVI.load("./scvi_model")

# Load with new adata (must have same var_names)
loaded_model = scvi.model.SCVI.load("./scvi_model", adata=new_adata)
```

### Transfer Learning (scArches)

```python
# Load reference model and map query data
query_model = scvi.model.SCVI.load_query_data(
    query_adata,
    "./reference_model",
    freeze_dropout=True,
    freeze_expression=True,
    freeze_batchnorm_encoder=True,
    freeze_batchnorm_decoder=False,
)
query_model.train(max_epochs=200, plan_kwargs={"weight_decay": 0.0})
query_latent = query_model.get_latent_representation()
```

## SOLO (Doublet Detection)

SOLO trains a classifier on the SCVI latent space to predict doublets.
Requires a pre-trained SCVI model.

```python
# Train SCVI first
scvi.model.SCVI.setup_anndata(adata, layer="counts")
vae = scvi.model.SCVI(adata)
vae.train(max_epochs=200)

# Create SOLO from trained SCVI
solo = scvi.external.SOLO.from_scvi_model(vae)
solo.train(max_epochs=200)

# Predict doublets
solo.predict()           # Returns DataFrame with softmax probabilities
doublet_probs = solo.predict(soft=False)  # Hard labels

# Add to adata
adata.obs["solo_doublet_prob"] = solo.predict()["doublet"]
adata.obs["solo_is_doublet"] = solo.predict(soft=False) == "doublet"

# Filter doublets
adata = adata[~adata.obs["solo_is_doublet"]].copy()
```

## SCANVI (Semi-Supervised Annotation)

```python
# Setup with labels; unlabeled cells have a specific category
scvi.model.SCANVI.setup_anndata(
    adata,
    batch_key="batch",
    labels_key="cell_type",
    unlabeled_category="Unknown",
)

model = scvi.model.SCANVI(adata, n_latent=10)
model.train(max_epochs=200)

# Predict labels for unlabeled cells
predictions = model.predict()              # Hard labels
prediction_probs = model.predict(soft=True) # Probability matrix

adata.obs["predicted_cell_type"] = predictions
adata.obsm["X_scANVI"] = model.get_latent_representation()
```

## Gotchas

- **Raw counts required**: SCVI expects raw (unnormalized) integer counts. Pass via
  `layer=` if counts are stored in a layer rather than `adata.X`.
- **setup_anndata once**: Call `setup_anndata()` before creating the model. It
  registers data fields that the model reads. Re-calling it resets the registration.
- **Reproducibility**: Set `scvi.settings.seed = 42` before training.
- **GPU training**: scvi-tools uses PyTorch. Set `use_gpu=True` in `model.train()`
  if a GPU is available (auto-detected in recent versions).
- **Large datasets**: Increase `batch_size` (256-512) and reduce `n_samples` in
  `get_normalized_expression` for memory efficiency.
- **var_names must match**: When loading a saved model with new data, the gene names
  and order must match the training data exactly.
- **SOLO per-batch**: For multi-batch data, consider running SOLO per batch for
  better accuracy.
