# SNFtool through rpy2 API Reference

Similarity Network Fusion (SNF), the R implementation of the original method, reached from Python through rpy2. It builds one patient-similarity network per modality and fuses them into a single network for stratification.

The python `snfpy` port is NOT available: it calls a scikit-learn argument that current scikit-learn removed, and it has no maintained release. SNFtool is the working route.

## rpy2 Setup

```python
import numpy as np
import rpy2.robjects as ro
from rpy2.robjects import numpy2ri, pandas2ri
from rpy2.robjects.packages import importr

numpy2ri.activate()
pandas2ri.activate()

snf = importr('SNFtool')
base = importr('base')
```

## Parameters

Three parameters control every call. The package documents these bands:

| Name | Meaning | Usual value |
|-|-|-|
| `K` | Number of nearest neighbors in the affinity graph and in the fusion | 20 (10-30) |
| `alpha` (`sigma`) | Variance of the local model in `affinityMatrix` | 0.5 (0.3-0.8) |
| `T` (`t`) | Number of diffusion iterations in `SNF` | 20 (10-20) |

`K` must stay well below the sample count. With N patients, a `K` near N makes every patient a neighbor of every other, and the fused network carries no structure.

## snf.standardNormalization()

```python
# z-score each feature column of one modality. Continuous data only.
# Each modality normalizes INDEPENDENTLY, before any distance is taken.
rna_n = snf.standardNormalization(rna_mat)      # samples x features
prot_n = snf.standardNormalization(prot_mat)
```

## snf.dist2() and snf.chiDist2()

```python
# dist2(X, C) returns SQUARED euclidean distances. Take the square root for
# euclidean distance -- affinityMatrix expects a distance, not its square.
dist_rna = ro.r('function(x) (dist2(as.matrix(x), as.matrix(x)))^(1/2)')(rna_n)

# chiDist2(A) is the chi-squared distance, for discrete or count-like data.
dist_disc = snf.chiDist2(disc_mat)
```

## snf.affinityMatrix()

```python
# affinityMatrix(diff, K = 20, sigma = 0.5)
# Distance matrix in, similarity graph out. Higher value = more similar.
W_rna = snf.affinityMatrix(dist_rna, 20, 0.5)
W_prot = snf.affinityMatrix(dist_prot, 20, 0.5)
# Returns: (N, N) symmetric affinity matrix
```

## snf.SNF()

```python
# SNF(Wall, K, t)
# Wall is an R LIST of square symmetric affinity matrices, one per modality.
# Every matrix must carry the SAME samples in the SAME order.
fused = snf.SNF(base.list(W_rna, W_prot, W_meth), 20, 20)
# Returns: (N, N) fused status matrix
```

## snf.estimateNumberOfClustersGivenGraph()

```python
# estimateNumberOfClustersGivenGraph(W, NUMC = 2:5)
# Pass the FUSED matrix. Widen NUMC when more clusters are plausible.
est = snf.estimateNumberOfClustersGivenGraph(fused, ro.IntVector(range(2, 8)))
# Returns four values, in this order:
#   K1  = best number of clusters by eigen-gap
#   K12 = second best by eigen-gap
#   K2  = best by rotation cost
#   K22 = second best by rotation cost
best_k = int(est[0])
```

The four estimates disagree often. Treat them as candidates, and select with a silhouette score or with the biology, never by taking the first value alone.

## snf.spectralClustering()

```python
# spectralClustering(affinity, K, type = 3)
# K here is the NUMBER OF CLUSTERS, not the neighbor count of affinityMatrix.
labels = np.asarray(snf.spectralClustering(fused, best_k))
# Returns: (N,) integer cluster labels, 1-based (R convention)
```

The R labels start at 1. Subtract 1 before you compare them with labels that a Python method produced.

## snf.calNMI() and snf.rankFeaturesByNMI()

```python
# calNMI(x, y): normalized mutual information between two label vectors.
agreement = float(snf.calNMI(ro.IntVector(labels), ro.IntVector(true_labels)))

# rankFeaturesByNMI(data, W): rank the features of every modality by their
# NMI against the fused matrix -- which features drive the fusion.
ranked = snf.rankFeaturesByNMI(base.list(rna_n, prot_n), fused)
```

## snf.groupPredict()

```python
# groupPredict(train, test, groups, K = 20, alpha = 0.5, t = 20, method = 1)
# Semi-supervised: propagate known labels onto held-out samples. `train` and
# `test` are LISTS with the same modalities in the same order.
predicted = snf.groupPredict(
    base.list(rna_train, prot_train),
    base.list(rna_test, prot_test),
    ro.IntVector(train_labels),
    20, 0.5, 20, 1,
)
# Returns: predicted labels for the test samples
```

## Visualization

```python
# displayClusters(W, group): the similarity matrix, ordered by cluster.
# displayClustersWithHeatmap(W, group, ColSideColors = NULL, ...): the same,
# with a sample annotation bar.
grdevices = importr('grDevices')
grdevices.png('fused_network.png', width=1000, height=1000, res=150)
snf.displayClustersWithHeatmap(fused, ro.IntVector(labels))
grdevices.dev_off()
```

The fused matrix is also a plain square numpy array on the Python side. Thus seaborn or matplotlib can render it with no R call.

## Complete Workflow

```python
import numpy as np
import pandas as pd
import rpy2.robjects as ro
from rpy2.robjects import numpy2ri
from rpy2.robjects.packages import importr

numpy2ri.activate()
snf = importr('SNFtool')
base = importr('base')

K, ALPHA, T = 20, 0.5, 20

# ---- 1. Matched samples across every modality ----
# SNF fuses ROWS. One sample order, one sample set, no exceptions.
common = sorted(set(rna_df.index) & set(prot_df.index) & set(meth_df.index))
mods = [rna_df.loc[common], prot_df.loc[common], meth_df.loc[common]]

# ---- 2. Normalize and build one affinity graph per modality ----
euclid = ro.r('function(x) (dist2(as.matrix(x), as.matrix(x)))^(1/2)')
graphs = []
for m in mods:
    normed = snf.standardNormalization(m.to_numpy())
    graphs.append(snf.affinityMatrix(euclid(normed), K, ALPHA))

# ---- 3. Fuse ----
fused = snf.SNF(base.list(*graphs), K, T)

# ---- 4. Estimate the cluster count, then cluster ----
est = snf.estimateNumberOfClustersGivenGraph(fused, ro.IntVector(range(2, 8)))
best_k = int(est[0])
labels = np.asarray(snf.spectralClustering(fused, best_k), dtype=int)

# ---- 5. Back to the samples ----
clusters = pd.Series(labels, index=common, name="snf_cluster")

# ---- 6. Which features drive the fusion ----
ranked = snf.rankFeaturesByNMI(base.list(*[m.to_numpy() for m in mods]), fused)
```

## Gotchas

- **`dist2` gives SQUARED distances.** Feed `affinityMatrix` the square root. The unrooted matrix runs without an error and produces a wrong neighborhood.
- **`K` means two things.** In `affinityMatrix` and `SNF` it is the neighbor count. In `spectralClustering` it is the cluster count. Passing 20 clusters is a silent, wrong run.
- **Sample order is the contract.** Every affinity matrix in the list must hold the same samples in the same order. SNF matches by POSITION and never by name, thus a mismatched order fuses the wrong patients together.
- **Normalize per modality, never across.** One modality with a large scale dominates the fused network otherwise.
- **R labels are 1-based.** A comparison against a scikit-learn label vector needs the offset.
- **Missing values.** SNF has no imputation step. Drop or impute before the distance, because a NaN propagates through the whole affinity matrix.
- **A small sample count.** SNF needs enough patients for a K-neighbor graph. Below roughly 30 samples, report the limit instead of a stratification.
