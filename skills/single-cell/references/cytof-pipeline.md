# CyTOF (Mass Cytometry) Pipeline

CyTOF analysis uses a fundamentally different stack from scRNA-seq. The entire
pipeline is R-native — write native R scripts, not rpy2. The primary stack is
**CATALYST + FlowSOM + diffcyt**.

## Key Differences from scRNA-seq

| | scRNA-seq | CyTOF |
|---|---|---|
| Features | ~20,000 genes | ~40-50 protein markers (pre-selected panel) |
| Transformation | log1p (after library size norm) | arcsinh(x / 5) |
| Dimensionality reduction | PCA → UMAP | UMAP directly (no PCA — already low-dimensional) |
| Clustering | Leiden on kNN graph | FlowSOM (SOM + ConsensusClusterPlus metaclustering) |
| Differential testing | Pseudobulk + DESeq2 | diffcyt (DA: edgeR/GLMM; DS: limma/LMM) |
| Zeros | Technical dropout (imputation common) | Real zeros (protein not expressed, no imputation) |
| Data format | AnnData (.h5ad) | SingleCellExperiment + FCS files |
| Batch correction | Harmony / scVI | CytoNorm (with tech replicates) / cyCombine (without) |

## CyTOF Pipeline Decision Tree

```
Input data?
├── FCS files
│   └── Read via flowCore::read.flowSet(transformation = FALSE, truncate_max_range = FALSE)
│       └── Construct SCE via CATALYST::prepData(panel, md)
├── Already in SingleCellExperiment
│   └── Proceed to preprocessing
└── CSV / count matrix
    └── Construct SCE manually

Preprocessing?
├── Bead normalization → CATALYST::normCytof() (corrects instrument drift)
├── Debarcoding (if multiplexed) → CATALYST::assignPrelim() + applyCutoffs()
├── Compensation → CATALYST::compCytof() (metal spillover correction)
└── Pre-gating → Filter: DNA+ (intact cells), singlets (event length), live/dead

Batch correction? (multi-batch studies)
├── Technical replicates available → CytoNorm (quantile normalization per FlowSOM cluster)
└── No replicates → cyCombine (reference-free linear scaling)

Transformation
└── arcsinh(x / cofactor)
    ├── CyTOF → cofactor = 5 (standard)
    ├── Flow cytometry → cofactor = 150
    └── IMC → cofactor = 1

Marker classification → CRITICAL
├── "type" markers (lineage): CD3, CD4, CD8, CD19, CD56, etc. → used for clustering
└── "state" markers (functional): Ki-67, pSTAT3, Granzyme B, etc. → used for DS analysis only

Clustering
└── CATALYST::cluster(sce, features = "type", xdim = 10, ydim = 10, maxK = 20)
    └── Wraps FlowSOM (SOM) + ConsensusClusterPlus (metaclustering)
    └── Inspect with plotExprHeatmap, plotDR, plotAbundances → merge/annotate clusters

Visualization
├── Expression heatmap → CATALYST::plotExprHeatmap(sce, by = "cluster_id")
├── DR plot → CATALYST::plotDR(sce, dr = "UMAP", color_by = "cluster_id")
├── Abundances → CATALYST::plotAbundances(sce, k = "meta20", by = "cluster_id")
├── MDS → CATALYST::pbMDS(sce, color_by = "condition")
└── NRS → CATALYST::plotNRS(sce, features = "type") (non-redundancy scores)

Differential analysis?
├── Differential abundance (DA) → Are cell populations more/less frequent?
│   ├── Default → diffcyt::testDA_edgeR() (moderated tests via edgeR)
│   └── With random effects → diffcyt::testDA_GLMM() (mixed models)
└── Differential state (DS) → Do markers change expression within populations?
    ├── Default → diffcyt::testDS_limma() (moderated tests via limma)
    └── With random effects → diffcyt::testDS_LMM() (mixed models)
```

## CyTOF Output Conventions

- Processed SingleCellExperiment saved as RDS. Export key results as CSV for
  cross-agent consumption.
- Cluster marker expression heatmap (type markers), UMAP colored by cluster and
  condition, abundance bar plots per condition.
- DA results CSV: `cluster_id`, `log_fold_change`, `p_val`, `p_adj`, `n_cells`.
- DS results CSV: `cluster_id`, `marker_id`, `log_fold_change`, `p_val`, `p_adj`.

## CyTOF Anti-Patterns

- **Using PCA on CyTOF data**: With ~40 markers, PCA is unnecessary and can be
  harmful. Run UMAP directly on arcsinh-transformed type markers.
- **Clustering on state markers**: State (functional) markers change between
  conditions — including them in clustering mixes biology with cell identity.
  Cluster on type (lineage) markers only.
- **Using Leiden/Louvain for CyTOF clustering**: FlowSOM is faster, more stable,
  and better validated for CyTOF than graph-based methods. Use FlowSOM via
  `CATALYST::cluster()`.
- **Wrong arcsinh cofactor**: CyTOF uses cofactor 5, flow cytometry uses 150.
  Wrong cofactor distorts marker distributions and downstream clustering.
- **Confusing cell count with sample size**: Statistical power for differential
  testing comes from biological replicates (samples), not cell numbers.
  3 vs 3 samples is the minimum for diffcyt.
- **Using scanpy/Python tools for CyTOF**: The CATALYST + FlowSOM + diffcyt
  R stack is the gold standard. Python tools (pytometry) are usable for
  exploration but lack the statistical rigor of diffcyt for differential testing.
- **Skipping bead normalization**: Instrument signal drifts during acquisition.
  Without bead normalization, early vs late samples differ systematically.
- **Reading FCS with default transforms**: `flowCore::read.flowSet()` may apply
  transforms by default. Always set `transformation = FALSE,
  truncate_max_range = FALSE` for CyTOF data.
- **Imputing zeros**: Unlike scRNA-seq dropout, CyTOF zeros are real. The protein
  is not expressed. Do not impute.
