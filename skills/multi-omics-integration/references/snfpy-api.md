# snfpy: Similarity Network Fusion API Reference

Similarity Network Fusion (SNF) for patient stratification across multiple omics modalities. Constructs per-modality patient similarity networks and fuses them into a single network for clustering. Based on Wang et al. (2014) Nature Methods.

## Core Imports

```python
import snf
import numpy as np
import pandas as pd
from sklearn.cluster import spectral_clustering
from sklearn.metrics import v_measure_score, silhouette_score
from sklearn.preprocessing import StandardScaler
```

## snf.make_affinity()

Constructs affinity (similarity) matrices from raw data arrays. Performs columnwise normalization, computes a distance matrix, and converts to an affinity matrix using a scaled exponential similarity kernel.

```python
snf.make_affinity(
    *data,                      # (N, M) array_like - one or more raw data arrays
                                # N = samples, M = features
                                # if multiple arrays provided, returns list of affinity matrices
    metric='sqeuclidean',       # str or list-of-str - distance metric
                                # must be valid scipy.spatial.distance.pdist metric
                                # common: 'sqeuclidean', 'euclidean', 'cosine', 'correlation'
                                # if list, applies each metric to corresponding data array
    K=20,                       # int (0, N) - number of nearest neighbors for affinity kernel
                                # rule of thumb: N // 10 (N = number of samples)
    mu=0.5,                     # float (0, 1) - scaling factor for affinity kernel width
                                # controls how quickly similarity decays with distance
                                # typical range: 0.3 - 0.8
    normalize=True              # bool - whether to columnwise-normalize input data
                                # set False if data is already pre-scaled
)
# Returns: (N, N) np.ndarray or list of (N, N) np.ndarray
#          symmetric affinity matrix (higher = more similar)
```

## snf.snf()

Fuses multiple affinity networks into a single similarity network via iterative message passing. Each network shares information with the others through a diffusion process on nearest-neighbor graphs.

```python
snf.snf(
    *aff,                       # (N, N) array_like - two or more square affinity matrices
                                # all must be the same size (same samples)
    K=20,                       # int (0, N) - number of nearest neighbors for fusion
                                # should match K used in make_affinity()
    t=20,                       # int - number of iterations for information swapping
                                # convergence typically within 10-20 iterations
    alpha=1.0                   # float (0, 1) - normalization factor for scaling
                                # default 1.0; rarely needs adjustment
)
# Returns: (N, N) np.ndarray - fused similarity network
#          symmetric, doubly-stochastic-like matrix
```

## snf.get_n_clusters()

Estimates the optimal number of clusters via the eigengap method (largest gap in eigenvalue spectrum of the graph Laplacian).

```python
snf.get_n_clusters(
    arr,                        # (N, N) array_like - fused affinity matrix (output of snf.snf())
    n_clusters=range(2, 6)      # array_like - candidate cluster numbers to evaluate
                                # default evaluates 2, 3, 4, 5 clusters
)
# Returns: tuple of int - (best, second_best) cluster numbers
#          best = highest eigengap, second_best = runner-up
```

## snf.group_predict()

Propagates known cluster labels from training samples to unlabeled test samples via SNF. Useful for semi-supervised classification.

```python
snf.group_predict(
    train,                      # list of (N_train, M) array_like - training data per modality
    test,                       # list of (N_test, M) array_like - test data per modality
    labels,                     # (N_train,) array_like - cluster labels for training samples
    K=20,                       # int - number of nearest neighbors
    mu=0.4,                     # float - affinity kernel scaling factor
    t=20                        # int - number of SNF iterations
)
# Returns: (N_test,) np.ndarray - predicted labels for test samples
```

## Spectral Clustering on Fused Network

snfpy produces a fused affinity matrix; apply sklearn spectral clustering to obtain discrete cluster labels.

```python
from sklearn.cluster import spectral_clustering

labels = spectral_clustering(
    fused_network,              # (N, N) np.ndarray - fused affinity from snf.snf()
    n_clusters=best_k,          # int - number of clusters (from snf.get_n_clusters())
    random_state=42,
    affinity='precomputed'      # REQUIRED: tells sklearn this is a similarity matrix
)
# Returns: (N,) np.ndarray - integer cluster labels [0, n_clusters)
```

## snf.metrics Module

Evaluation metrics for assessing SNF clustering quality.

```python
# Normalized mutual information (compare two label vectors)
nmi = snf.metrics.nmi(labels_true, labels_pred)
# Returns: float in [0, 1], 1 = perfect agreement

# Silhouette score on the fused affinity matrix
sil = snf.metrics.silhouette_score(fused_network, labels)
# Returns: float in [-1, 1], higher = better-defined clusters
```

## snf.cv.snf_gridsearch()

Grid search over SNF hyperparameters (K, mu, n_clusters) with cross-validation.

```python
snf.cv.snf_gridsearch(
    *data,                      # raw data arrays (same as make_affinity input)
    metric='sqeuclidean',       # distance metric
    mu=None,                    # list of float - mu values to search (e.g., [0.3, 0.5, 0.8])
    K=None,                     # list of int - K values to search (e.g., [10, 20, 30])
    n_clusters=None,            # list of int - cluster counts to search (e.g., [2, 3, 4, 5])
    t=20,                       # int - SNF iterations
    folds=3,                    # int - number of CV folds
    n_perms=1000,               # int - number of permutations for significance testing
    normalize=True,             # bool - normalize input data
    seed=None                   # int - random seed for reproducibility
)
# Returns: DataFrame with columns for each hyperparameter combo and silhouette scores
```

## Complete Multi-Omics Workflow

```python
import snf
import numpy as np
import pandas as pd
from sklearn.cluster import spectral_clustering
from sklearn.preprocessing import StandardScaler
import matplotlib.pyplot as plt
import seaborn as sns

# ---- 1. Load per-modality data (samples x features) ----
rna_df = pd.read_csv('rna_expression.csv', index_col=0)       # N patients x G genes
prot_df = pd.read_csv('protein_abundance.csv', index_col=0)    # N patients x P proteins
metab_df = pd.read_csv('metabolomics.csv', index_col=0)        # N patients x M metabolites

# Verify matched samples across all modalities
common_samples = rna_df.index.intersection(prot_df.index).intersection(metab_df.index)
rna_df = rna_df.loc[common_samples]
prot_df = prot_df.loc[common_samples]
metab_df = metab_df.loc[common_samples]
print(f"Matched samples across modalities: {len(common_samples)}")

# ---- 2. Scale each modality independently (CRITICAL) ----
scaler = StandardScaler()
rna_scaled = scaler.fit_transform(rna_df.values)
prot_scaled = scaler.fit_transform(prot_df.values)
metab_scaled = scaler.fit_transform(metab_df.values)

# ---- 3. Construct per-modality affinity matrices ----
N = len(common_samples)
K = max(10, N // 10)    # rule of thumb: N // 10, minimum 10

affinity_networks = snf.make_affinity(
    rna_scaled, prot_scaled, metab_scaled,
    metric='sqeuclidean',
    K=K,
    mu=0.5,
    normalize=False         # already scaled above
)
# affinity_networks is a list of 3 (N, N) arrays

# ---- 4. Fuse networks ----
fused = snf.snf(affinity_networks, K=K)
# fused is (N, N) array

# ---- 5. Determine optimal number of clusters ----
best_k, second_k = snf.get_n_clusters(fused)
print(f"Optimal clusters: {best_k} (runner-up: {second_k})")

# ---- 6. Spectral clustering on fused network ----
labels = spectral_clustering(fused, n_clusters=best_k, random_state=42, affinity='precomputed')

# ---- 7. Assign labels back to samples ----
cluster_df = pd.DataFrame({
    'sample': common_samples,
    'cluster': labels
}).set_index('sample')
cluster_df.to_csv('snf_clusters.csv')

# ---- 8. Evaluate clustering quality ----
from sklearn.metrics import silhouette_score
sil = silhouette_score(1 - fused / fused.max(), labels, metric='precomputed')
print(f"Silhouette score: {sil:.3f}")
```

## Visualization Patterns

```python
# ---- Fused similarity heatmap with cluster annotations ----
order = np.argsort(labels)
fused_ordered = fused[np.ix_(order, order)]

fig, axes = plt.subplots(1, 2, figsize=(16, 6))

# Per-modality affinity (show one)
sns.heatmap(affinity_networks[0][np.ix_(order, order)],
            cmap='viridis', ax=axes[0], xticklabels=False, yticklabels=False)
axes[0].set_title('RNA Affinity (sorted by cluster)')

# Fused network
sns.heatmap(fused_ordered,
            cmap='viridis', ax=axes[1], xticklabels=False, yticklabels=False)
axes[1].set_title('Fused SNF Network (sorted by cluster)')

plt.tight_layout()
plt.savefig('snf_heatmaps.png', dpi=150, bbox_inches='tight')
plt.close()

# ---- Cluster composition bar plot (with metadata) ----
if 'condition' in metadata.columns:
    ct = pd.crosstab(cluster_df['cluster'], metadata.loc[common_samples, 'condition'])
    ct_pct = ct.div(ct.sum(axis=1), axis=0)
    ct_pct.plot(kind='bar', stacked=True, figsize=(8, 5))
    plt.ylabel('Proportion')
    plt.title('SNF Cluster Composition by Condition')
    plt.tight_layout()
    plt.savefig('snf_cluster_composition.png', dpi=150, bbox_inches='tight')
    plt.close()
```

## Common Patterns

### Two-Modality Fusion (RNA + Protein)

```python
affinities = snf.make_affinity(rna_scaled, prot_scaled, metric='sqeuclidean', K=K, mu=0.5)
fused = snf.snf(affinities, K=K)
```

### Per-Modality Metric Selection

Use different distance metrics per modality when data types differ substantially.

```python
# Euclidean for continuous abundance data, correlation for expression profiles
affinities = snf.make_affinity(
    rna_scaled, metab_scaled,
    metric=['correlation', 'sqeuclidean'],
    K=K, mu=0.5
)
fused = snf.snf(affinities, K=K)
```

### Hyperparameter Tuning via Grid Search

```python
results = snf.cv.snf_gridsearch(
    rna_scaled, prot_scaled, metab_scaled,
    K=[10, 15, 20, 30],
    mu=[0.3, 0.5, 0.8],
    n_clusters=[2, 3, 4, 5],
    folds=5,
    seed=42
)
print(results.sort_values('silhouette', ascending=False).head(5))
```

### Comparing Cluster Stability Across K

```python
from sklearn.metrics import adjusted_rand_score

k_range = range(2, 8)
stability = []
for k in k_range:
    labels_k = spectral_clustering(fused, n_clusters=k, random_state=42, affinity='precomputed')
    sil = silhouette_score(1 - fused / fused.max(), labels_k, metric='precomputed')
    stability.append({'k': k, 'silhouette': sil})
stability_df = pd.DataFrame(stability)
print(stability_df)
best_k = stability_df.loc[stability_df['silhouette'].idxmax(), 'k']
```

### Leiden Clustering on Fused Network (Alternative to Spectral)

```python
import igraph as ig
import leidenalg

# Convert fused affinity to igraph weighted graph
# Threshold weak edges to create sparse graph
threshold = np.percentile(fused[fused > 0], 25)
adj = fused.copy()
adj[adj < threshold] = 0
np.fill_diagonal(adj, 0)

g = ig.Graph.Weighted_Adjacency(adj.tolist(), mode='undirected')
partition = leidenalg.find_partition(g, leidenalg.RBConfigurationVertexPartition,
                                     weights='weight', resolution_parameter=1.0, seed=42)
leiden_labels = np.array(partition.membership)
```

### Semi-Supervised Label Propagation

```python
# Propagate known labels to new patients
predicted_labels = snf.group_predict(
    train=[rna_train, prot_train, metab_train],
    test=[rna_test, prot_test, metab_test],
    labels=train_labels,
    K=K, mu=0.5, t=20
)
```

## Gotchas

- **Scale each modality BEFORE computing affinity matrices.** Different modalities have vastly different value ranges (e.g., RNA counts 0-100k vs. methylation beta 0-1). Without `StandardScaler()`, the high-variance modality dominates the fused network. Use `normalize=False` in `make_affinity()` if you pre-scale, or `normalize=True` (default) if you pass raw data.
- **K should scale with sample size.** Rule of thumb: `K = N // 10` where N is the number of samples. Too small K makes the network too sparse and noisy; too large K smooths out meaningful local structure. For small cohorts (N < 50), use K = 5-10.
- **Use the same K in `make_affinity()` and `snf()`.** Mismatched K values between the affinity construction and fusion steps can degrade results.
- **`metric='sqeuclidean'` (squared Euclidean) is the default, not `'euclidean'`.** This is intentional -- squared Euclidean avoids the square root computation and works well with the exponential kernel. Use `'correlation'` for expression data where relative patterns matter more than magnitude.
- **`spectral_clustering()` requires `affinity='precomputed'`.** Without this flag, sklearn treats the input as raw feature data and computes its own affinity matrix, which defeats the purpose of SNF.
- **`get_n_clusters()` only evaluates the range you provide.** The default `range(2, 6)` only checks 2-5 clusters. Expand to `range(2, 11)` for exploratory analysis with unknown structure.
- **Fused matrix is NOT a distance matrix.** Higher values = more similar. When using sklearn's `silhouette_score`, convert to a distance: `1 - fused / fused.max()` with `metric='precomputed'`.
- **All modalities must have the same samples in the same order.** SNF fuses sample-by-sample affinity matrices. Mismatched or misaligned samples produce silently wrong results. Always verify index alignment before fusion.
- **SNF does not handle missing samples.** Unlike MOFA+, SNF requires all samples to be present in all modalities. Restrict to the intersection of complete cases across modalities.
- **Small sample sizes (N < 30) produce unreliable affinity matrices.** SNF relies on local neighborhood structure. With very few samples, the K-nearest-neighbor graph becomes meaningless. Consider MOFA+ for small cohorts.
- **Number of SNF iterations (t=20) rarely needs tuning.** The algorithm converges quickly. Increasing t beyond 20 has negligible effect; decreasing below 10 may under-fuse.
- **snfpy version is 0.2.2 (latest).** The package is stable but not actively maintained. Pin the version to avoid unexpected changes.
