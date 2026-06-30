# DeepChem API Reference

Python library for deep learning on molecular data. Provides featurizers (SMILES to model input), molecular property prediction models (GCN, AttentiveFP, MLP), MoleculeNet benchmark datasets, and evaluation metrics. Built on TensorFlow/PyTorch backends.

## Core Imports

```python
import deepchem as dc
import numpy as np
import pandas as pd
```

## Featurizers

Convert molecules (SMILES strings) into numerical representations suitable for model input.

### CircularFingerprint (ECFP)

Best for sklearn-compatible workflows and smaller datasets. Produces fixed-length bit vectors.

```python
featurizer = dc.feat.CircularFingerprint(size=2048, radius=2)
# size: fingerprint length (bits)
# radius: Morgan radius (2 = ECFP4, 3 = ECFP6)

# Single molecule
fp = featurizer.featurize(["CCO"])
# Returns: np.ndarray of shape (1, 2048)

# Batch featurization
smiles = ["CCO", "c1ccccc1", "CC(=O)O"]
fps = featurizer.featurize(smiles)
# Returns: np.ndarray of shape (3, 2048)
```

### MolGraphConvFeaturizer (Graph Neural Networks)

Converts molecules into graph representations for GCN/AttentiveFP models.

```python
featurizer = dc.feat.MolGraphConvFeaturizer(use_edges=True)
# use_edges=True: include edge (bond) features for models that use them

graphs = featurizer.featurize(smiles)
# Returns: list of GraphData objects
# Each has .node_features, .edge_index, .edge_features
```

### WeaveFeaturizer

Alternative graph featurizer for WeaveModel.

```python
featurizer = dc.feat.WeaveFeaturizer()
features = featurizer.featurize(smiles)
```

### Gotchas -- Featurizers

- `featurize()` accepts a list of SMILES strings, not RDKit mol objects.
- Invalid SMILES produce NaN entries. Check with `np.isnan(fps).any()` after featurization.
- `CircularFingerprint` output is directly usable with sklearn models (numpy array).
- `MolGraphConvFeaturizer` output is NOT usable with sklearn -- it produces graph objects for DeepChem graph models only.

## Dataset Loading

### From Arrays

```python
# Create dataset from numpy arrays
X = fps  # features from featurizer, shape (n_samples, n_features)
y = np.array([4.5, 6.2, 3.1])  # target values
w = np.ones(len(y))  # sample weights (optional)
ids = smiles  # identifiers (optional)

dataset = dc.data.NumpyDataset(X=X, y=y, w=w, ids=ids)

# Access
dataset.X      # features
dataset.y      # labels
dataset.w      # weights
dataset.ids    # identifiers
len(dataset)   # number of samples
```

### From SMILES DataFrame

```python
# Load from CSV with SMILES and targets
loader = dc.data.CSVLoader(
    tasks=["pIC50"],                          # target column(s)
    feature_field="SMILES",                   # SMILES column
    featurizer=dc.feat.CircularFingerprint(size=2048, radius=2),
)
dataset = loader.create_dataset("compounds.csv")
```

### MoleculeNet Benchmarks

```python
# Delaney (aqueous solubility) -- regression
tasks, datasets, transformers = dc.molnet.load_delaney(
    featurizer=dc.feat.CircularFingerprint(size=2048, radius=2),
    splitter="random",
)
train, valid, test = datasets

# Tox21 (toxicity) -- multi-task classification
tasks, datasets, transformers = dc.molnet.load_tox21(
    featurizer=dc.feat.MolGraphConvFeaturizer(use_edges=True),
    splitter="scaffold",  # scaffold split for realistic evaluation
)
train, valid, test = datasets

# Other available benchmarks
# dc.molnet.load_bbbp()       # blood-brain barrier
# dc.molnet.load_hiv()        # HIV inhibition
# dc.molnet.load_muv()        # MUV bioassays
# dc.molnet.load_sider()      # side effects
# dc.molnet.load_clintox()    # clinical toxicity
# dc.molnet.load_bace()       # BACE-1 inhibition
# dc.molnet.load_freesolv()   # free solvation energy
# dc.molnet.load_lipophilicity() # lipophilicity
```

### Gotchas -- Dataset Loading

- `splitter="scaffold"` performs Bemis-Murcko scaffold split -- more realistic than random for molecular data. Use for final evaluation.
- `transformers` returned by `load_*` may include normalization. Apply inverse transform for interpretable predictions.
- MoleculeNet datasets are downloaded on first use. In sandbox environments without internet, load data from local files using `NumpyDataset` or `CSVLoader`.

## Models

### GraphConvModel (GCN)

Graph convolutional network for molecular property prediction.

```python
model = dc.models.GraphConvModel(
    n_tasks=1,                   # number of prediction tasks
    mode="regression",           # "regression" or "classification"
    batch_size=64,
    learning_rate=0.001,
    dropout=0.1,
)

# Requires MolGraphConvFeaturizer input
featurizer = dc.feat.MolGraphConvFeaturizer(use_edges=False)
# Note: GraphConvModel does NOT use edge features
```

### AttentiveFPModel

Attention-based fingerprint model. Often best performing for molecular properties.

```python
model = dc.models.AttentiveFPModel(
    n_tasks=1,
    mode="regression",
    batch_size=64,
    learning_rate=0.001,
    num_layers=2,                # number of graph attention layers
    graph_feat_size=200,         # hidden size
    dropout=0.1,
)

# Requires MolGraphConvFeaturizer with use_edges=True
featurizer = dc.feat.MolGraphConvFeaturizer(use_edges=True)
```

### MultitaskClassifier / MultitaskRegressor (Dense Network)

Standard dense neural network on fingerprint features.

```python
# Classification
model = dc.models.MultitaskClassifier(
    n_tasks=1,
    n_features=2048,             # must match fingerprint size
    layer_sizes=[1024, 512],     # hidden layer sizes
    dropouts=0.2,
    learning_rate=0.001,
)

# Regression
model = dc.models.MultitaskRegressor(
    n_tasks=1,
    n_features=2048,
    layer_sizes=[1024, 512],
    dropouts=0.2,
    learning_rate=0.001,
)

# Requires CircularFingerprint input (numpy array)
featurizer = dc.feat.CircularFingerprint(size=2048, radius=2)
```

### Gotchas -- Models

- `GraphConvModel` does NOT use edge features. Use `MolGraphConvFeaturizer(use_edges=False)` for it.
- `AttentiveFPModel` DOES use edge features. Use `MolGraphConvFeaturizer(use_edges=True)`.
- `MultitaskClassifier/Regressor` expects flat numpy arrays (fingerprints), NOT graph objects.
- Graph models (GCN, AttentiveFP) are GPU-intensive. For >10K compounds on CPU, prefer fingerprint + sklearn instead.

## Training

```python
# Fit model
model.fit(train_dataset, nb_epoch=50)
# nb_epoch: number of training epochs

# With validation monitoring (manual)
for epoch in range(50):
    loss = model.fit(train_dataset, nb_epoch=1)
    train_score = model.evaluate(train_dataset, [metric])
    valid_score = model.evaluate(valid_dataset, [metric])
    print(f"Epoch {epoch}: train={train_score}, valid={valid_score}")
```

### Gotchas -- Training

- `model.fit()` returns the average loss over the epoch.
- There is no built-in early stopping. Implement manually by monitoring validation metrics.
- `nb_epoch=50` is a reasonable starting point. Increase for complex tasks, decrease for small datasets.

## Evaluation

```python
# Define metrics
r2_metric = dc.metrics.Metric(dc.metrics.pearson_r2_score)
rmse_metric = dc.metrics.Metric(dc.metrics.rms_score)
roc_auc_metric = dc.metrics.Metric(dc.metrics.roc_auc_score)

# Evaluate on test set (regression)
scores = model.evaluate(test_dataset, [r2_metric, rmse_metric])
# Returns dict: {"pearson_r2_score": 0.85, "rms_score": 0.42}

# Evaluate on test set (classification)
scores = model.evaluate(test_dataset, [roc_auc_metric])

# Available metrics
# dc.metrics.pearson_r2_score    -- R-squared (regression)
# dc.metrics.rms_score           -- RMSE (regression)
# dc.metrics.mae_score           -- MAE (regression)
# dc.metrics.roc_auc_score       -- ROC-AUC (classification)
# dc.metrics.prc_auc_score       -- PR-AUC (classification)
# dc.metrics.accuracy_score      -- accuracy (classification)
```

## Prediction

```python
# Predict on new data
predictions = model.predict(test_dataset)
# Returns: np.ndarray of shape (n_samples, n_tasks) for regression
# For classification: shape (n_samples, n_tasks, n_classes)

# Predict on new SMILES
new_smiles = ["CCO", "c1ccccc1O"]
new_features = featurizer.featurize(new_smiles)
new_dataset = dc.data.NumpyDataset(X=new_features)
preds = model.predict(new_dataset)
```

## Complete Workflow: Fingerprint + sklearn

Best for small to medium datasets (<10K). Fast, interpretable, no GPU needed.

```python
import deepchem as dc
import numpy as np
from sklearn.ensemble import RandomForestRegressor, GradientBoostingRegressor
from sklearn.model_selection import cross_val_score
from sklearn.metrics import r2_score, mean_squared_error

# Featurize
featurizer = dc.feat.CircularFingerprint(size=2048, radius=2)
smiles = df["SMILES"].tolist()
X = featurizer.featurize(smiles)
y = df["pIC50"].values

# Remove failed featurizations
valid_mask = ~np.isnan(X).any(axis=1)
X = X[valid_mask]
y = y[valid_mask]

# Train sklearn model (no DeepChem model needed)
from sklearn.model_selection import train_test_split
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

rf = RandomForestRegressor(n_estimators=500, random_state=42, n_jobs=-1)
rf.fit(X_train, y_train)
y_pred = rf.predict(X_test)
print(f"RF R2: {r2_score(y_test, y_pred):.3f}")
print(f"RF RMSE: {np.sqrt(mean_squared_error(y_test, y_pred)):.3f}")
```

## Complete Workflow: Graph Neural Network

Best for medium to large datasets with GPU access.

```python
import deepchem as dc

# Featurize for graph models
featurizer = dc.feat.MolGraphConvFeaturizer(use_edges=True)
features = featurizer.featurize(smiles)

# Create dataset
dataset = dc.data.NumpyDataset(X=features, y=y)

# Scaffold split
splitter = dc.splits.ScaffoldSplitter()
train, valid, test = splitter.train_valid_test_split(dataset)

# AttentiveFP model
model = dc.models.AttentiveFPModel(
    n_tasks=1,
    mode="regression",
    batch_size=64,
    learning_rate=0.001,
    num_layers=2,
    graph_feat_size=200,
    dropout=0.1,
)

# Train
model.fit(train, nb_epoch=50)

# Evaluate
metric = dc.metrics.Metric(dc.metrics.pearson_r2_score)
train_score = model.evaluate(train, [metric])
test_score = model.evaluate(test, [metric])
print(f"Train R2: {train_score}, Test R2: {test_score}")
```

## Gotchas

- DeepChem uses TensorFlow, PyTorch, or JAX as backend. Check which is available in your environment.
- `featurize()` silently returns NaN for invalid SMILES. Always check for NaN after featurization.
- Graph models are memory-intensive. For large datasets, use smaller batch sizes.
- `ScaffoldSplitter` is preferred over random splits for molecular data -- prevents data leakage from similar scaffolds appearing in both train and test.
- Model checkpoints are saved to a temporary directory by default. Set `model_dir=` to persist.
- DeepChem models are not serializable with pickle. Use `model.save()` and `dc.models.GraphConvModel.load()` for persistence.
