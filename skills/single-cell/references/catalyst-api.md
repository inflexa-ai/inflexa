# CATALYST API Reference

Cytometry dATa anALYSis Tools — the central orchestration package for CyTOF
(mass cytometry) analysis in R/Bioconductor. Built on SingleCellExperiment,
provides preprocessing, FlowSOM/ConsensusClusterPlus clustering, dimensionality
reduction, visualization, and differential analysis wrappers (via diffcyt).

## Setup

```r
library(CATALYST)
library(flowCore)
library(SingleCellExperiment)
library(ggplot2)
```

CATALYST depends on SingleCellExperiment for its core data structure and
flowCore for FCS file I/O. ggplot2 is needed for customizing plots returned
by CATALYST's visualization functions.

## Data Preparation: prepData()

Construct a `SingleCellExperiment` from a `flowSet` + panel + metadata.

### Reading FCS Files

```r
# Read FCS files into a flowSet — MUST disable default transformations
fcs_files <- list.files("data/", pattern = "\\.fcs$", full.names = TRUE)
fs <- read.flowSet(
  files = fcs_files,
  transformation = FALSE,      # critical: no auto-transformation
  truncate_max_range = FALSE   # critical: preserve full dynamic range
)
```

`transformation = FALSE` and `truncate_max_range = FALSE` are mandatory for
CyTOF data. Default flowCore transformations are designed for fluorescence
cytometry and will corrupt mass cytometry intensity values.

### Panel and Metadata

```r
# Panel: maps FCS channel names to antigen names and marker classes
# fcs_colname MUST match colnames(fs) exactly
panel <- data.frame(
  fcs_colname  = c("Ir191Di", "Ir193Di", "Nd142Di", "Nd144Di",
                    "Sm147Di", "Eu151Di", "Gd155Di", "Tb159Di",
                    "Er166Di", "Yb172Di", "Lu175Di"),
  antigen      = c("DNA1", "DNA2", "CD45", "CD3", "CD20",
                    "CD14", "CD4", "CD8a", "CD56", "CD38", "HLA-DR"),
  marker_class = c("none", "none", "type", "type", "type",
                    "type", "type", "type", "type", "state", "state"),
  stringsAsFactors = FALSE
)

# Metadata: one row per FCS file
md <- data.frame(
  file_name  = basename(fcs_files),
  sample_id  = c("ctrl_1", "ctrl_2", "stim_1", "stim_2"),
  condition  = c("control", "control", "stimulated", "stimulated"),
  patient_id = c("P1", "P2", "P1", "P2"),
  stringsAsFactors = FALSE
)
```

**marker_class** values — this classification is CRITICAL:

| Value    | Purpose | Used by |
|----------|---------|---------|
| `"type"` | Lineage/surface markers for cell type identification | `cluster()`, `runDR()` with `features = "type"` |
| `"state"` | Functional/activation markers | Differential state analysis (`diffcyt-DS`) |
| `"none"` | Housekeeping channels (DNA, viability, barcodes) | Excluded from analysis |

### Constructing the SCE

```r
sce <- prepData(
  x = fs,              # flowSet (or SingleCellExperiment, or matrix)
  panel = panel,       # data.frame with fcs_colname, antigen, marker_class
  md = md,             # data.frame with file_name, sample_id, condition, patient_id
  cofactor = 5,        # numeric — arcsinh cofactor (default 5 for CyTOF)
  transform = TRUE,    # logical — apply arcsinh transformation (default TRUE)
  FACS = FALSE         # logical — TRUE keeps non-mass channels for FACS data.
                       # It does NOT change the cofactor.
)

# The returned SCE contains:
# - assays: "counts" (raw), "exprs" (arcsinh-transformed)
# - colData: sample_id, condition, patient_id, cluster_id (after clustering)
# - rowData: channel_name, marker_name, marker_class
```

`cofactor = 5` is the standard for CyTOF and is the default whether or not
`FACS = TRUE`. `FACS = TRUE` only controls which channels are retained — it
does **not** change the cofactor. For fluorescence data pass the cofactor
yourself, e.g. `cofactor = 150`, alongside `FACS = TRUE`.

## Preprocessing

### normCytof() — Bead-Based Normalization

Normalizes CyTOF data using bead standards to correct for signal drift over
acquisition time. MUST be called on raw data BEFORE `prepData()`.

```r
# Input: raw flowFrame or flowSet (NOT an SCE from prepData)
ff <- read.FCS("sample.fcs", transformation = FALSE, truncate_max_range = FALSE)

ff_norm <- normCytof(
  x = ff,                # flowFrame or flowSet — raw, untransformed
  beads = "dvs",         # "dvs" (DVS Sciences) or "beta" (Fluidigm Beta beads)
                         # or a named numeric vector of bead channels
  remove_beads = TRUE,   # logical — remove bead events after normalization
  k = 500,               # integer — number of beads per time window (smoothing)
  trim = 5,              # numeric — trim percentage for bead intensity outliers
  overwrite = FALSE      # logical — FALSE returns a new object; TRUE modifies x
)

# ff_norm is a flowFrame with bead-normalized intensities
# Then pass the normalized flowSet to prepData()
```

### compCytof() — Spillover Compensation

Apply spillover/compensation matrix to correct for isotope impurities.

```r
sce <- compCytof(
  x = sce,              # SingleCellExperiment (from prepData)
  sm = spillover_matrix, # matrix — spillover matrix (from single-stained controls)
  method = "nnls",       # "nnls" (non-negative least squares) or "flow"
  overwrite = FALSE      # logical — FALSE stores in a new assay; TRUE overwrites
)
```

### Debarcoding: assignPrelim() + applyCutoffs()

For multiplexed CyTOF experiments using mass-tag barcoding.

```r
# Step 1: Assign bead-based barcode IDs
sce <- assignPrelim(
  x = sce,              # SingleCellExperiment
  bc_key = barcode_key  # data.frame or matrix — barcode scheme
)

# Step 2: Apply separation cutoffs to resolve ambiguous assignments
sce <- applyCutoffs(
  x = sce               # SingleCellExperiment (after assignPrelim)
)

# After debarcoding, colData(sce)$bc_id contains barcode assignments
# Events with bc_id == 0 are unassigned
```

## Clustering: cluster()

Wraps FlowSOM self-organizing map + ConsensusClusterPlus metaclustering.

```r
sce <- cluster(
  x = sce,              # SingleCellExperiment
  features = "type",    # "type" (lineage markers), "state", or character vector
  xdim = 10,            # integer — SOM grid x dimension (default 10)
  ydim = 10,            # integer — SOM grid y dimension (default 10)
  maxK = 20,            # integer — maximum number of metaclusters to evaluate
  seed = 42             # integer — random seed for reproducibility
)

# Results stored in colData(sce):
#   cluster_id — SOM node assignment (up to xdim*ydim = 100 clusters)
#   meta2      — metaclustering into 2 clusters
#   meta3      — metaclustering into 3 clusters
#   ...
#   meta20     — metaclustering into 20 clusters (up to maxK)
```

`features = "type"` restricts clustering to lineage markers (marker_class ==
"type"). This is the standard approach — state markers are used for downstream
differential state analysis, not for defining cell populations.

`xdim = 10, ydim = 10` creates a 10x10 SOM grid (100 nodes). This is the
recommended default. Larger grids (e.g., 15x15) may capture finer populations
but increase computation and risk overfitting.

### mergeClusters() — Manual Cluster Annotation

Merge metaclusters based on expert inspection of marker expression heatmaps.

```r
# Create a merging table: map old metacluster IDs to new annotations
merging_table <- data.frame(
  old_cluster = seq_len(20),
  new_cluster = c("CD4 T cells", "CD8 T cells", "CD8 T cells",
                   "B cells", "B cells", "NK cells",
                   "Monocytes", "Monocytes", "Monocytes",
                   "DCs", "DCs", "Basophils",
                   rep("Other", 8))
)

sce <- mergeClusters(
  x = sce,                      # SingleCellExperiment
  k = "meta20",                 # character — metaclustering resolution to merge
  table = merging_table,        # data.frame — old_cluster and new_cluster columns
  id = "cell_type"              # character — name for the new annotation column
)

# colData(sce)$cell_type now contains the merged annotations
```

## Dimensionality Reduction: runDR()

```r
sce <- runDR(
  x = sce,              # SingleCellExperiment
  dr = "UMAP",          # "UMAP", "TSNE", or "DiffusionMap"
  features = "type",    # "type", "state", or character vector of marker names
  cells = 500,          # integer — cells to subsample per sample (for speed)
  seed = 42             # integer — random seed for reproducibility
)

# Result stored in reducedDim(sce, "UMAP")
# Access: reducedDim(sce, "UMAP") returns a matrix with 2 columns

# Use all cells (slow for large datasets)
sce <- runDR(sce, dr = "UMAP", features = "type", cells = NULL)

# t-SNE
sce <- runDR(sce, dr = "TSNE", features = "type", cells = 500)

# Diffusion map
sce <- runDR(sce, dr = "DiffusionMap", features = "type", cells = 500)
```

`cells = 500` subsamples 500 cells per sample before computing the embedding.
For a dataset with 8 samples, this uses 4000 cells total. Set `cells = NULL`
to use all cells, but expect long runtimes for >100k cells.

## Visualization

All plotting functions return ggplot2 objects that can be further customized.

### plotExprHeatmap() — Marker Expression by Cluster

```r
# Median marker expression per cluster at a given metaclustering resolution
plotExprHeatmap(
  x = sce,              # SingleCellExperiment
  features = "type",    # "type", "state", or character vector
  by = "cluster_id",    # column in colData to aggregate by
  k = "meta20",         # metaclustering resolution (e.g., "meta10", "meta20")
  scale = "last",       # when to scale relative to aggregation:
                        # "first" = scale expressions, then aggregate;
                        # "last"  = aggregate, then scale; "never" = no scaling
  bars = TRUE,          # logical — show cluster size bars
  perc = TRUE           # logical — show cluster percentage annotations
)

# Heatmap by sample
plotExprHeatmap(sce, features = "type", by = "sample_id")
```

### plotDR() — Dimensionality Reduction Plots

```r
# Color by cluster assignment
plotDR(sce, dr = "UMAP", color_by = "meta20")

# Color by a specific marker
plotDR(sce, dr = "UMAP", color_by = "CD4")

# Color by condition
plotDR(sce, dr = "UMAP", color_by = "condition")

# Split into facets by condition
plotDR(sce, dr = "UMAP", color_by = "meta20", facet_by = "condition")

# Color by condition, faceted
plotDR(sce, dr = "UMAP", color_by = "condition", facet_by = "condition")
```

### plotAbundances() — Cluster Proportions

```r
# Cluster proportions grouped by condition
plotAbundances(
  x = sce,
  k = "meta20",              # metaclustering resolution
  by = "cluster_id",         # "cluster_id" or "sample_id"
  group_by = "condition"     # colData column for grouping
)

# By sample (stacked bars showing cluster composition per sample)
plotAbundances(sce, k = "meta20", by = "sample_id", group_by = "condition")
```

### pbMDS() — Sample-Level MDS Plot

```r
# Pseudobulk MDS — check for batch effects and sample-level structure
pbMDS(
  x = sce,
  color_by = "condition",    # colData column for coloring
  label_by = "sample_id",   # colData column for point labels
  shape_by = NULL            # optional: colData column for point shapes
)
```

### plotNRS() — Non-Redundancy Scores

```r
# Per-marker non-redundancy scores (higher = more informative for clustering)
plotNRS(
  x = sce,
  features = "type",         # "type", "state", or character vector
  color_by = "condition"     # optional: colData column for coloring
)
```

### plotCounts() — Cell Counts per Sample

```r
plotCounts(
  x = sce,
  group_by = "condition",    # colData column for x-axis grouping
  color_by = "patient_id"   # colData column for bar coloring
)
```

## Differential Analysis Wrappers

CATALYST provides a high-level interface to the diffcyt framework for
differential abundance (DA) and differential state (DS) analysis.

### Setup: Design and Contrast Matrices

```r
# Extract experiment info from the SCE
ei_df <- ei(sce)
# Returns data.frame: sample_id, group_id (= condition), patient_id, n_cells

# Create design matrix
design <- createDesignMatrix(
  ei_df,
  cols_design = c("condition", "patient_id")  # include blocking factors
)

# Create contrast (stimulated vs control).
# The vector length MUST equal ncol(design), which depends on your metadata:
# intercept + (levels(condition) - 1) + (levels(patient_id) - 1). Do not
# hardcode it — build it from the design and name the coefficient you want.
coef_of_interest <- grep("^condition", colnames(design), value = TRUE)[1]
contrast <- createContrast(as.numeric(colnames(design) == coef_of_interest))

# Verify contrast dimensions
stopifnot(nrow(contrast) == ncol(design))
```

### Differential Abundance (DA)

```r
# Test whether cluster proportions differ between conditions
res_DA <- diffcyt(
  x = sce,
  design = design,
  contrast = contrast,
  analysis_type = "DA",          # differential abundance
  method_DA = "diffcyt-DA-edgeR", # "diffcyt-DA-edgeR" or "diffcyt-DA-GLMM"
  clustering_to_use = "meta20",  # metaclustering resolution
  verbose = TRUE
)

# Extract results table
da_table <- rowData(res_DA$res)
# Columns: cluster_id, logFC, logCPM, LR, p_val, p_adj
head(da_table[order(da_table$p_adj), ])
```

### Differential State (DS)

```r
# Test whether marker expression within clusters differs between conditions
res_DS <- diffcyt(
  x = sce,
  design = design,
  contrast = contrast,
  analysis_type = "DS",          # differential state
  method_DS = "diffcyt-DS-limma", # "diffcyt-DS-limma" or "diffcyt-DS-LMM"
  clustering_to_use = "meta20",
  verbose = TRUE
)

# Extract results
ds_table <- rowData(res_DS$res)
# Columns: cluster_id, marker_id, logFC, AveExpr, t, p_val, p_adj
head(ds_table[order(ds_table$p_adj), ])
```

For advanced diffcyt workflows (custom formulas, specific random effects),
see `diffcyt-api.md`.

## Saving Results

```r
# Export cluster assignments per cell
cluster_df <- data.frame(
  cell_id    = seq_len(ncol(sce)),
  sample_id  = colData(sce)$sample_id,
  cluster_id = colData(sce)$cluster_id,
  meta20     = colData(sce)$meta20
)
write.csv(cluster_df, "output/cluster_assignments.csv", row.names = FALSE)

# Export median marker expression per cluster
library(dplyr)
expr_mat <- t(assay(sce, "exprs"))
expr_df <- as.data.frame(expr_mat)
expr_df$cluster_id <- colData(sce)$meta20
medians <- expr_df %>%
  group_by(cluster_id) %>%
  summarise(across(everything(), median))
write.csv(medians, "output/cluster_median_expression.csv", row.names = FALSE)

# Export cell-level expression matrix with metadata
cell_data <- cbind(
  as.data.frame(colData(sce)[, c("sample_id", "condition", "patient_id", "cluster_id", "meta20")]),
  as.data.frame(t(assay(sce, "exprs")))
)
write.csv(cell_data, "output/cell_level_data.csv", row.names = FALSE)

# Save full SCE as RDS for fast reload
saveRDS(sce, "output/catalyst_sce.rds")

# Reload
sce <- readRDS("output/catalyst_sce.rds")
```

## Gotchas

- **marker_class values**: Must be exactly `"type"`, `"state"`, or `"none"`. Any other value (e.g., `"Type"`, `"lineage"`, `"functional"`) silently breaks marker subsetting and clustering. No error is thrown — features simply get excluded.
- **Panel channel name matching**: `panel$fcs_colname` must match the actual FCS channel names exactly (case-sensitive). Check with `colnames(fs)` before calling `prepData()`. A mismatch silently drops channels.
- **normCytof before prepData**: Bead normalization must be performed on the raw `flowFrame`/`flowSet` BEFORE calling `prepData()`. Running it after arcsinh transformation corrupts the bead identification and normalization.
- **cofactor selection**: CyTOF uses cofactor = 5 (arcsinh(x/5)). FACS uses cofactor = 150. Using the wrong cofactor compresses or inflates the dynamic range, distorting all downstream clustering and visualization.
- **Metaclustering column naming**: `cluster()` stores results as `meta2`, `meta3`, ..., `metaK` in `colData`. Access specific resolutions by name (e.g., `colData(sce)$meta20`). The `k` parameter in plotting functions expects a string like `"meta20"`, not the integer `20`.
- **mergeClusters table format**: The merging table must be a `data.frame` with columns named `old_cluster` and `new_cluster`. `old_cluster` values must match the cluster IDs at the resolution specified by `k`. Mismatched IDs are silently dropped.
- **runDR subsampling**: `cells` parameter defaults to subsampling per sample. Set `cells = NULL` to use all cells, but for >100k total cells UMAP becomes very slow (minutes to hours). The default subsampling is usually sufficient for visualization.
- **plotExprHeatmap k parameter**: The `k` argument selects which metaclustering resolution to display (e.g., `"meta10"`, `"meta20"`). Omitting it defaults to the original SOM clusters (100 nodes with 10x10 grid), which is usually too granular to interpret.
- **type vs state for clustering**: Always use `features = "type"` for `cluster()`. Clustering on state markers mixes functional activation states into cell identity, producing biologically uninterpretable clusters. State markers are for differential state analysis within defined populations.
- **FlowSOM reproducibility**: `cluster()` results depend on the random seed. Always set `seed` explicitly. Different seeds can produce substantially different SOM maps, especially with small cell counts.
- **Large SOM grids**: Increasing `xdim`/`ydim` beyond 10 (e.g., 15x15 = 225 nodes) increases runtime quadratically and can fragment rare populations across many nearly-empty nodes. The 10x10 default handles most CyTOF datasets well.
- **diffcyt contrast length**: The contrast vector length must equal `ncol(design)`. A mismatch causes a cryptic dimension error. Always verify with `nrow(contrast) == ncol(design)`.
- **diffcyt requires patient_id for paired designs**: For paired experimental designs (e.g., before/after treatment in the same patient), include `patient_id` in `cols_design` for `createDesignMatrix()`. Omitting it treats all samples as independent, inflating statistical significance.
- **Memory for large datasets**: CyTOF datasets with >1M cells per sample can exhaust memory during `cluster()` and `runDR()`. Subsample before or during these steps. `prepData()` itself is efficient but downstream operations scale with total cell count.
