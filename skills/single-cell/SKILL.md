---
name: single-cell
description: Single-cell analysis pipeline covering scRNA-seq, snRNA-seq, and CyTOF (mass cytometry) — QC, normalization, integration, clustering, annotation, differential expression, trajectory, cell communication, and TF activity inference
version: 1.1.0
tags: [scrna-seq, snrna-seq, single-cell, scanpy, anndata, cytof, mass-cytometry, catalyst, flowsom]
---

# Single-Cell Analysis

Full pipeline guidance for scRNA-seq, snRNA-seq, and CyTOF (mass cytometry) analysis.

## Pipeline Decision Tree

### QC and Filtering

```
QC strategy?
├── Thresholds → Adaptive MAD-based (NOT arbitrary cutoffs)
│   ├── n_genes_by_counts: median +/- 5 MADs
│   ├── total_counts: median +/- 5 MADs
│   ├── pct_counts_mt: median + 3 MADs (upper only; >20% suspicious)
│   └── snRNA-seq: also check pct_counts_ribo (should be low)
├── Doublet detection
│   ├── Single sample → scrublet (via sc.pp.scrublet or sc.external.pp.scrublet)
│   └── Multiple samples / higher accuracy → SOLO (scvi-tools, deep generative)
└── Ambient RNA (optional, pre-loaded)
    └── If raw + filtered matrices available → CellBender or SoupX
```

### Normalization

```
Data type?
├── Standard scRNA-seq → sc.pp.normalize_total(target_sum=1e4) + sc.pp.log1p
├── Heterogeneous populations (very different sizes) → scran pooling via rpy2
└── Planning to use scVI downstream → skip normalization (scVI takes raw counts)
```

### Highly Variable Genes (HVG)

```
Input state?
├── Raw counts → flavor='seurat_v3' (variance-stabilizing, works on counts)
└── Log-normalized → flavor='seurat' (default, log-normalized expected)
Always: n_top_genes=2000-3000, subset to HVGs for PCA
```

### Integration / Batch Correction

```
Batch effects present? (check PCA colored by batch)
├── No batch effect → skip integration
├── Moderate batch effect (same tissue, same protocol)
│   └── Harmony (fast, operates in PCA space, corrects embeddings only)
├── Complex batch effect (different donors, protocols, tissues)
│   └── scVI (deep generative model, corrects latent space, preserves counts)
└── Alignment only (no shared latent space needed)
    └── scanorama (fast alignment, good for simple batch structures)
```

### Clustering

```
Algorithm → Leiden (NOT Louvain — Leiden guarantees connected clusters)
Resolution selection:
├── Try multiple resolutions: 0.3, 0.5, 0.8, 1.0, 1.5
├── Validate with silhouette score on each
├── Inspect marker genes at each resolution
└── Choose resolution where clusters have distinct biological markers
```

### Cell Type Annotation

```
Annotation approach?
├── Automated (fast, reproducible)
│   └── CellTypist with tissue-appropriate model
│       ├── majority_voting=True for clean labels
│       └── Cross-check with known markers
└── Marker-based (manual, flexible)
    └── sc.tl.rank_genes_groups per cluster → match to known markers
```

### Differential Expression

```
Comparison type?
├── Between conditions (e.g., treated vs control)
│   └── Pseudobulk + PyDESeq2 (aggregate per sample-celltype, then bulk DE)
│       Critical: per-cell DE inflates p-values due to pseudoreplication
└── Between clusters (within one condition, exploratory markers)
    └── sc.tl.rank_genes_groups (Wilcoxon or t-test, per-cluster)
```

### Trajectory Analysis

```
Goal?
├── Differentiation pseudotime
│   ├── Default → Palantir (diffusion maps, fate probabilities)
│   └── Simple ordering → sc.tl.dpt (diffusion pseudotime)
├── RNA velocity (transcriptional dynamics)
│   └── scVelo (requires spliced + unspliced layers from velocyto/STARsolo)
│       └── Check: adata.layers["spliced"], adata.layers["unspliced"] must exist
└── Fate mapping → CellRank (integrates velocity + transcriptome for fate probabilities)
```

### Cell-Cell Communication

```
LIANA+ rank_aggregate → li.mt.rank_aggregate(adata, groupby="cell_type")
Filter by magnitude_rank and specificity_rank
```

### TF Activity Inference

```
Resolve a TF-target regulon network for your organism (CollecTRI, or DoRothEA
  confidence A-C) from the reference data available to you — never dc.op.collectri()
  (no network egress). Formats vary; read it the way the inventory reports.
collectri = pd.read_csv(regulon_path)   # regulon_path resolved, not a literal
  → CollecTRI is CSV; DoRothEA ships as R .rda and needs rpy2, not pandas
  → normalise columns to source / target / weight; targets are HGNC (human) / MGI (mouse)
dc.mt.ulm(data=adata, net=collectri)
Results in adata.obsm["score_ulm"], adata.obsm["padj_ulm"]
```

---

## CyTOF (Mass Cytometry) Pipeline

CyTOF analysis uses a fundamentally different stack from scRNA-seq. The entire
pipeline is R-native — write native R scripts, not rpy2. The primary stack is
**CATALYST + FlowSOM + diffcyt**.

### Key Differences from scRNA-seq

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

### CyTOF Pipeline Decision Tree

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

### CyTOF Output Conventions

- Processed SingleCellExperiment saved as RDS. Export key results as CSV for
  cross-agent consumption.
- Cluster marker expression heatmap (type markers), UMAP colored by cluster and
  condition, abundance bar plots per condition.
- DA results CSV: `cluster_id`, `log_fold_change`, `p_val`, `p_adj`, `n_cells`.
- DS results CSV: `cluster_id`, `marker_id`, `log_fold_change`, `p_val`, `p_adj`.

### CyTOF Anti-Patterns

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

## Output Conventions

### scRNA-seq / snRNA-seq

- Processed AnnData as .h5ad: raw counts in `adata.layers["counts"]`, log-normalized in `adata.X`.
- UMAP plots colored by cluster, cell type, batch, and condition as PNG/PDF.
- DE results as CSV: gene, log2FoldChange, pvalue, padj, cluster/comparison.
- Marker gene dotplot or heatmap per cluster. Trajectory plots with pseudotime if applicable.

### CyTOF

See CyTOF Output Conventions above.

## Anti-Patterns

- **Per-cell DE between conditions**: Treating each cell as an independent sample inflates p-values due to pseudoreplication. Always use pseudobulk aggregation (sum counts per sample per cell type, then DESeq2/edgeR/limma).
- **Skipping integration when batches exist**: If PCA shows batch-driven clustering, downstream analysis will find batch effects, not biology. Always check and integrate.
- **Louvain instead of Leiden**: Louvain can produce disconnected clusters. Leiden guarantees connected communities and is strictly better.
- **Arbitrary QC thresholds**: Hard cutoffs like "filter cells with <200 genes" ignore dataset-specific distributions. Use MAD-based adaptive thresholds.
- **Running scVelo without spliced/unspliced layers**: scVelo requires `adata.layers["spliced"]` and `adata.layers["unspliced"]` from velocyto or STARsolo. Without them, velocity estimates are meaningless.
- **HVG flavor mismatch**: Using `flavor='seurat_v3'` on log-normalized data or `flavor='seurat'` on raw counts produces incorrect variable gene selection.
- **Normalizing before scVI**: scVI expects raw counts. Pre-normalizing corrupts its probabilistic model.
- **Clustering at a single resolution**: Different resolutions reveal different granularity. Always try multiple and validate biologically.
- **Ignoring ambient RNA in droplet data**: High ambient RNA inflates expression of highly expressed genes across all cells, creating false marker genes.

## Additional Available Packages

### Python (scRNA-seq / snRNA-seq)

- **cellrank** (>=2): Cell fate probability and driver gene identification. Builds on scVelo velocity or pseudotime. Use `cr.kernels.VelocityKernel` or `cr.kernels.PseudotimeKernel`, then `cr.estimators.GPCCA` for macrostates.
- **pyscenic**: Gene regulatory network inference. Identifies TF regulons (TF + target genes). Use `GRNBoost2` for co-expression, `cisTarget` for motif enrichment. Computationally heavy.
- **pytometry**: FCS file reading into AnnData for lightweight exploration. For production CyTOF analysis, use the CATALYST + FlowSOM + diffcyt R stack instead.

### R (scRNA-seq, via rpy2)

- **SingleCellExperiment, scater, scran, batchelor**: R single-cell ecosystem. scran provides pooling normalization, batchelor provides MNN integration. Use only when specific R-only functionality is required; prefer scanpy/scvi-tools Python equivalents.

### R (CyTOF — native R scripts)

- **CATALYST**: End-to-end CyTOF orchestration. Preprocessing (`normCytof`, `compCytof`, `assignPrelim`), data preparation (`prepData`), clustering wrapper (`cluster` — wraps FlowSOM + ConsensusClusterPlus), rich visualization (`plotExprHeatmap`, `plotDR`, `plotAbundances`, `pbMDS`, `plotNRS`), and differential analysis wrapper.
- **FlowSOM**: Self-organizing map clustering for cytometry. Fast, stable, scales to millions of cells. Used via `CATALYST::cluster()` — rarely called directly.
- **diffcyt**: Differential discovery framework. DA testing via `testDA_edgeR()` (default) or `testDA_GLMM()` (random effects). DS testing via `testDS_limma()` (default) or `testDS_LMM()` (random effects). Uses established statistical frameworks (limma, edgeR) adapted to cytometry data.
- **flowCore**: FCS file I/O and cytometry data infrastructure. `read.flowSet()` with `transformation = FALSE, truncate_max_range = FALSE` for CyTOF.
- **CytoNorm**: Batch normalization for multi-batch CyTOF. Requires technical replicates across batches. Model-based quantile normalization per FlowSOM cluster.
- **cyCombine**: Batch correction without technical replicates. Reference-free linear scaling across technologies (CyTOF, flow, CITE-seq).

## References

### scRNA-seq / snRNA-seq (Python)

- `references/scanpy-api.md` — Core pipeline (QC, normalization, clustering, DE, visualization)
- `references/scvi-tools-api.md` — Deep generative models (scVI, SOLO doublets)
- `references/harmonypy-api.md` — PCA-space batch correction
- `references/celltypist-api.md` — Automated cell type annotation
- `references/decoupler-api.md` — TF activity, pathway enrichment, functional scoring
- `references/liana-api.md` — Cell-cell communication (ligand-receptor)
- `references/palantir-api.md` — Differentiation pseudotime and fate probabilities
- `references/scvelo-api.md` — RNA velocity (spliced/unspliced dynamics)
- `references/pertpy-api.md` — Perturbation analysis (Augur, Milo, scCODA)
- `references/scirpy-api.md` — TCR/BCR immune repertoire analysis

### CyTOF / Mass Cytometry (R)

- `references/catalyst-api.md` — CATALYST preprocessing, clustering, visualization
- `references/diffcyt-api.md` — Differential abundance and state testing
