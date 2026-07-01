# CellTypist API Reference

Automated cell type annotation using logistic regression classifiers.
Works with AnnData objects or count matrices. Provides both pre-trained
models and custom model training.

## Model Management

```python
import celltypist
from celltypist import models

# Download all available models
models.download_models()

# Download a specific model
models.download_models(model="Immune_All_Low.pkl")

# List available models
print(models.models_description())

# Load a model
model = models.Model.load(model="Immune_All_Low.pkl")
print(model.cell_types)  # View cell types the model can predict
```

### Key Built-in Models

| Model | Description |
|-------|-------------|
| `Immune_All_Low.pkl` | Immune cells, low-hierarchy (broad types) |
| `Immune_All_High.pkl` | Immune cells, high-hierarchy (fine subtypes) |
| `Developing_Human_Brain.pkl` | Human brain development |
| `Adult_Mouse_Gut.pkl` | Mouse intestinal cells |
| `Human_Lung_Atlas.pkl` | Human lung cell types |
| `Cells_Fetal_Lung.pkl` | Fetal lung development |
| `Pan_Fetal_Human.pkl` | Pan-fetal human tissues |

## Annotation

### Basic Prediction

```python
import scanpy as sc

adata = sc.read_h5ad("input.h5ad")

# Basic annotation (input should be log-normalized)
predictions = celltypist.annotate(
    adata,
    model="Immune_All_Low.pkl",
    mode="best match",  # Default: assign single best label per cell
)

# Access results
predictions.predicted_labels    # DataFrame: predicted cell types
predictions.decision_matrix     # Decision function scores per type
predictions.probability_matrix  # Probability scores per type
```

### Majority Voting

```python
# Majority voting refines predictions using local neighborhood consensus
predictions = celltypist.annotate(
    adata,
    model="Immune_All_Low.pkl",
    majority_voting=True,
    over_clustering="leiden",  # Use existing clustering in adata.obs
)

# With automatic over-clustering (CellTypist computes it)
predictions = celltypist.annotate(
    adata,
    model="Immune_All_Low.pkl",
    majority_voting=True,
    # Omit over_clustering to let CellTypist create one
)
```

### Multi-label Classification

```python
# Probability matching: cells can get 0, 1, or multiple labels
predictions = celltypist.annotate(
    adata,
    model="Immune_All_Low.pkl",
    mode="prob match",
    p_thres=0.5,  # Probability threshold for label assignment
)
```

### Embedding Results in AnnData

```python
# Insert predictions into the AnnData object
result_adata = predictions.to_adata(
    insert_labels=True,   # Add predicted_labels to obs
    insert_conf=True,     # Add confidence scores to obs
    insert_prob=True,     # Add probability matrix to obsm
    prefix="celltypist_",  # Prefix for added columns
)

# Export results to files
predictions.to_table(folder="./output/", prefix="experiment1_")
predictions.to_table(folder="./output/", prefix="exp_", xlsx=True)
```

## Custom Model Training

### Standard Training

```python
# Train from AnnData (expects log-normalized data)
new_model = celltypist.train(
    adata,
    labels="cell_type_column",  # Column in adata.obs with ground truth
    check_expression=True,       # Verify data is log-normalized
)

# Save the model
new_model.write("./my_custom_model.pkl")
```

### SGD for Large Datasets

```python
# Use SGD for datasets > 100k cells
new_model = celltypist.train(
    adata,
    labels="cell_type",
    use_SGD=True,
    alpha=0.0001,
    max_iter=500,
    n_jobs=-1,
)

# Mini-batch SGD for very large datasets
new_model = celltypist.train(
    adata,
    labels="cell_type",
    use_SGD=True,
    mini_batch=True,
    batch_size=1000,
    batch_number=100,
    epochs=10,
    balance_cell_type=True,  # Balance rare cell types in training
)
```

### Feature Selection (Two-Pass)

```python
# First pass selects informative genes, second pass trains on them
new_model = celltypist.train(
    adata,
    labels="cell_type",
    feature_selection=True,
    top_genes=300,
    use_SGD=True,
)
```

### Adding Metadata

```python
new_model = celltypist.train(
    adata,
    labels="cell_type",
    date="2025-01-15",
    details="PBMC reference trained on 50k cells from 10x Genomics",
    source="10x Genomics public dataset",
    version="1.0",
)
```

## Standard Workflow

```python
import scanpy as sc
import celltypist
from celltypist import models

# 1. Load and preprocess
adata = sc.read_h5ad("raw_counts.h5ad")
sc.pp.normalize_total(adata, target_sum=1e4)
sc.pp.log1p(adata)

# 2. Cluster for majority voting
sc.pp.highly_variable_genes(adata, n_top_genes=2000)
sc.pp.pca(adata)
sc.pp.neighbors(adata)
sc.tl.leiden(adata, resolution=2.0, key_added="leiden_fine")

# 3. Annotate with majority voting
models.download_models(model="Immune_All_Low.pkl")
predictions = celltypist.annotate(
    adata,
    model="Immune_All_Low.pkl",
    majority_voting=True,
    over_clustering="leiden_fine",
)

# 4. Embed results
adata = predictions.to_adata()
```

## Gotchas

- **Log-normalized input**: CellTypist expects log-normalized data (not raw counts).
  Use `sc.pp.normalize_total` + `sc.pp.log1p` before annotation.
- **Gene name matching**: Gene names must match the model's training genes. Human
  gene symbols (uppercase) are expected for human models.
- **Over-clustering resolution**: For majority voting, use a high-resolution
  clustering (e.g., `resolution=2.0-5.0`) so that each micro-cluster is mostly
  one cell type. Too coarse a clustering defeats the purpose.
- **Model path**: Models downloaded via `models.download_models()` are stored in
  `models.models_path`. Specify the full path for custom models.
- **Large datasets**: Use `use_SGD=True` with `mini_batch=True` for datasets
  exceeding 100k cells to avoid memory issues.
