# CellTypist API Reference

Automated cell type annotation using logistic regression classifiers.
Works with AnnData objects or count matrices. Provides both pre-trained
models and custom model training.

## Model Management

Never call `models.download_models()`: it fetches from the CellTypist model server, and there is no network egress. Do not fall back on CellTypist's own cache either — `models.models_description()` and `models.models_path` describe that download cache, which is not populated here. Load the model from a file already available to you.

**Resolve the model before you write the script.** Ask for the *model* by what it is, not by a path — reference data is provisioned per-environment, so the directory and the filename both vary and neither is yours to assume:

| You need | Ask for | Standard models |
|-|-|-|
| Broad immune labels | A pre-trained CellTypist immune model, low-hierarchy | Immune_All_Low |
| Fine immune subtypes | A pre-trained CellTypist immune model, high-hierarchy | Immune_All_High |
| Tissue-specific labels | A pre-trained CellTypist model for your tissue and organism | Human_Lung_Atlas, Developing_Human_Brain, Adult_Mouse_Gut, Cells_Fetal_Lung, Pan_Fetal_Human |

**Load by absolute path.** Passing a bare model name (`model="Immune_All_Low.pkl"`) makes CellTypist resolve it against its own cache directory, which fails when the file lives anywhere else. Every `model=` argument below takes a path you resolved, and it must be absolute.

The file should be a pickled CellTypist `Model` — a logistic-regression classifier carrying the gene list it was trained on and the labels it can emit. Verify that after loading rather than trusting the name: `model.cell_types` should hold the labels you expect and `model.features` the training genes. Organism matters as much as tissue — a human model applied to mouse symbols runs happily and returns meaningless labels.

If no suitable model is available, report that and fall back to marker-based annotation. Do not invent a path, and do not silently annotate with the wrong tissue's model.

```python
import celltypist
from celltypist import models

# `model_path` is an absolute path you resolved, not a literal to copy.
model = models.Model.load(model=model_path)
print(model.cell_types)     # labels this model can predict
print(len(model.features))  # genes it was trained on
```

### Key Built-in Models

| Model | Description |
|-|-|
| Immune_All_Low | Immune cells, low-hierarchy (broad types) |
| Immune_All_High | Immune cells, high-hierarchy (fine subtypes) |
| Developing_Human_Brain | Human brain development |
| Adult_Mouse_Gut | Mouse intestinal cells |
| Human_Lung_Atlas | Human lung cell types |
| Cells_Fetal_Lung | Fetal lung development |
| Pan_Fetal_Human | Pan-fetal human tissues |

These are the models CellTypist publishes; which of them exist in this environment is a separate question, answered by the reference data available to you.

## Annotation

### Basic Prediction

```python
import scanpy as sc

adata = sc.read_h5ad("input.h5ad")

# Basic annotation (input should be log-normalized)
predictions = celltypist.annotate(
    adata,
    model=model_path,  # absolute path, resolved per Model Management
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
    model=model_path,  # absolute path, resolved per Model Management
    majority_voting=True,
    over_clustering="leiden",  # Use existing clustering in adata.obs
)

# With automatic over-clustering (CellTypist computes it)
predictions = celltypist.annotate(
    adata,
    model=model_path,  # absolute path, resolved per Model Management
    majority_voting=True,
    # Omit over_clustering to let CellTypist create one
)
```

### Multi-label Classification

```python
# Probability matching: cells can get 0, 1, or multiple labels
predictions = celltypist.annotate(
    adata,
    model=model_path,  # absolute path, resolved per Model Management
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
# `model_path` is an absolute path you resolved (Immune_All_Low here) — no download step.
predictions = celltypist.annotate(
    adata,
    model=model_path,  # absolute path, resolved per Model Management
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
- **No network access**: Never call `models.download_models()` — it reaches the
  CellTypist model server and fails outright. `models.models_description()` reads
  the same download cache and is equally unusable here.
- **Load models by absolute path**: `model="Immune_All_Low.pkl"` is a *name*
  lookup against `models.models_path`, not a file read. It fails whenever the
  model is not inside that cache directory. Pass the absolute path you resolved
  to both `models.Model.load()` and `celltypist.annotate()`, for pre-trained and
  custom models alike.
- **`CELLTYPIST_FOLDER` is read at import**: if you point CellTypist at a
  different model directory with `CELLTYPIST_FOLDER`, export it in the *same*
  command that runs the script (`CELLTYPIST_FOLDER=... python script.py`), using
  a directory you resolved — setting it in a separate shell invocation has no
  effect on the run. Passing an absolute `model=` path avoids the issue entirely.
- **Large datasets**: Use `use_SGD=True` with `mini_batch=True` for datasets
  exceeding 100k cells to avoid memory issues.
