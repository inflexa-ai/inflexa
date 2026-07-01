# diffcyt API Reference

Differential discovery in high-dimensional cytometry data. Provides statistically rigorous differential abundance (DA) and differential state (DS) testing by adapting limma and edgeR frameworks to cytometry cluster-level summaries. Works with CATALYST SingleCellExperiment objects.

## Setup

```r
library(diffcyt)
library(CATALYST)
library(SummarizedExperiment)
```

## Input from CATALYST

diffcyt operates on cluster-level summaries derived from a CATALYST `SingleCellExperiment`. Cluster assignments must be present in `colData(sce)$cluster_id` (set by `CATALYST::cluster()`).

### Experiment Info and Marker Info

```r
# Extract experiment info from CATALYST SCE
experiment_info <- ei(sce)
# Columns: sample_id, patient_id, condition, ... (depends on your design)

# Marker info from SCE
marker_info <- data.frame(
  channel_name = rownames(sce),
  marker_name  = rowData(sce)$marker_name,
  marker_class = rowData(sce)$marker_class   # "type", "state", or "none"
)
```

### Design Matrix

```r
# Two-group comparison (NO intercept — required for makeContrasts)
design <- model.matrix(~ 0 + condition, data = ei(sce))
colnames(design) <- levels(ei(sce)$condition)

# With a covariate (e.g., batch)
design <- model.matrix(~ 0 + condition + batch, data = ei(sce))
```

### Contrast Matrix

```r
library(limma)

# Single comparison: condition B vs condition A
contrast <- makeContrasts(B - A, levels = design)

# The contrast must be a single-column matrix (one comparison at a time)
```

### Using diffcyt Helper Functions

diffcyt also provides its own `createDesignMatrix()` and `createContrast()` for simpler setups.

```r
# createDesignMatrix — builds design from experiment_info columns
design <- createDesignMatrix(experiment_info, cols_design = "condition")

# createContrast — numeric vector specifying the linear combination
# Position corresponds to columns of the design matrix
contrast <- createContrast(c(0, 1))

# For complex designs with batch
design <- createDesignMatrix(experiment_info, cols_design = c("condition", "batch"))
contrast <- createContrast(c(0, 1, 0))  # test second column (condition level 2 vs 1)
```

## Differential Abundance (DA) Testing

Tests whether cell population frequencies differ across conditions. Operates on cluster cell counts.

### calcCounts()

Aggregate cell counts per cluster per sample.

```r
d_counts <- calcCounts(sce)

# Access the count matrix (clusters x samples)
counts_matrix <- assays(d_counts)[["counts"]]

# Row metadata: cluster IDs
rowData(d_counts)

# Column metadata: experiment info
colData(d_counts)
```

### testDA_edgeR()

Default DA method. Uses edgeR exact test or GLM framework.

```r
res_DA <- testDA_edgeR(d_counts, design, contrast)

# With minimum cell filtering
res_DA <- testDA_edgeR(
  d_counts, design, contrast,
  min_cells = 3,       # clusters with fewer cells in any sample are excluded
  min_samples = 1       # minimum samples per group with enough cells
)

# With TMM normalization (accounts for compositional effects)
res_DA <- testDA_edgeR(
  d_counts, design, contrast,
  normalize = TRUE,
  norm_factors = "TMM"
)
```

### testDA_GLMM()

For random effects (paired samples, repeated measures). Requires `lme4`.

```r
# Create formula with random effects
formula_obj <- createFormula(
  experiment_info,
  cols_fixed = "condition",
  cols_random = c("sample_id", "patient_id")
)

# Run GLMM-based DA test
res_DA <- testDA_GLMM(d_counts, formula_obj$formula, contrast)
```

## Differential State (DS) Testing

Tests whether marker expression changes within populations across conditions. Uses "state" markers (functional), not "type" markers (lineage).

### calcMedians()

Compute median marker expression per cluster per sample.

```r
d_medians <- calcMedians(sce)

# Access medians for a specific marker (clusters x samples)
marker_medians <- assays(d_medians)[["CD69"]]

# Identify marker classes
metadata(d_medians)$id_type_markers    # logical: which are type markers
metadata(d_medians)$id_state_markers   # logical: which are state markers

# List all markers
names(assays(d_medians))
```

### testDS_limma()

Default DS method. Uses limma moderated t-statistics with precision weights.

```r
res_DS <- testDS_limma(d_counts, d_medians, design, contrast)

# With minimum cell filtering
res_DS <- testDS_limma(
  d_counts, d_medians, design, contrast,
  min_cells = 3,
  min_samples = 1
)

# Without precision weights
res_DS <- testDS_limma(
  d_counts, d_medians, design, contrast,
  weights = FALSE
)

# Test specific markers only (logical vector matching marker order)
markers_to_test <- rowData(sce)$marker_class == "state"
res_DS <- testDS_limma(
  d_counts, d_medians, design, contrast,
  markers_to_test = markers_to_test
)
```

### testDS_LMM()

For random effects (paired samples, repeated measures). Requires `lme4`.

```r
formula_obj <- createFormula(
  experiment_info,
  cols_fixed = "condition",
  cols_random = c("sample_id", "patient_id")
)

res_DS <- testDS_LMM(d_counts, d_medians, formula_obj$formula, contrast)
```

## Result Extraction: topTable()

```r
# DA results — top 20 by adjusted p-value (default)
topTable(res_DA, format_vals = TRUE)

# Show all results
topTable(res_DA, all = TRUE)

# With cell counts per sample
topTable(res_DA, show_counts = TRUE, format_vals = TRUE, digits = 3)

# With proportions per sample
topTable(res_DA, show_counts = TRUE, show_props = TRUE, format_vals = TRUE)

# DS results — includes marker_id column
topTable(res_DS, format_vals = TRUE)

# With median expression per sample
topTable(res_DS, show_meds = TRUE, show_logFC = TRUE, format_vals = TRUE, digits = 3)

# Custom number of top results
topTable(res_DA, top_n = 50)

# Order by raw p-value instead of adjusted
topTable(res_DA, order_by = "p_val")

# Show all statistical columns
topTable(res_DA, show_all_cols = TRUE)
```

### topTable() Output Columns

| Column | DA | DS | Description |
|--------|----|----|-------------|
| cluster_id | yes | yes | Cluster identifier |
| marker_id | no | yes | Marker tested (DS only) |
| p_val | yes | yes | Raw p-value |
| p_adj | yes | yes | Adjusted p-value (BH by default) |
| log_fold_change | yes | yes | Estimated log fold change |

Filter significant results:

```r
# Extract as data frame and filter
da_results <- topTable(res_DA, all = TRUE, show_counts = TRUE, format_vals = TRUE)
da_sig <- da_results[da_results$p_adj < 0.05, ]
da_sig <- da_sig[order(da_sig$p_adj), ]

ds_results <- topTable(res_DS, all = TRUE, show_meds = TRUE, format_vals = TRUE)
ds_sig <- ds_results[ds_results$p_adj < 0.05, ]
ds_sig <- ds_sig[order(ds_sig$p_adj), ]
```

## Complete DA Workflow Example

End-to-end differential abundance analysis from a CATALYST SingleCellExperiment.

```r
library(diffcyt)
library(CATALYST)
library(SummarizedExperiment)
library(limma)

# --- 1. Aggregate cell counts per cluster per sample ---
d_counts <- calcCounts(sce)

# --- 2. Create design and contrast matrices ---
design <- model.matrix(~ 0 + condition, data = ei(sce))
colnames(design) <- levels(ei(sce)$condition)
contrast <- makeContrasts(treatment - control, levels = design)

# --- 3. Run DA test ---
res_DA <- testDA_edgeR(d_counts, design, contrast)

# --- 4. Extract and inspect results ---
da_table <- topTable(res_DA, all = TRUE, show_counts = TRUE, format_vals = TRUE, digits = 3)
da_sig <- da_table[da_table$p_adj < 0.05, ]
cat("Significant DA clusters:", nrow(da_sig), "\n")
print(da_sig)

# --- 5. Visualize ---
plotDiffHeatmap(sce, rowData(res_DA), all = TRUE, fdr = 0.05)
```

## Complete DS Workflow Example

End-to-end differential state analysis from a CATALYST SingleCellExperiment.

```r
library(diffcyt)
library(CATALYST)
library(SummarizedExperiment)
library(limma)

# --- 1. Compute median marker expression per cluster per sample ---
d_counts <- calcCounts(sce)
d_medians <- calcMedians(sce)

# --- 2. Create design and contrast matrices (same as DA) ---
design <- model.matrix(~ 0 + condition, data = ei(sce))
colnames(design) <- levels(ei(sce)$condition)
contrast <- makeContrasts(treatment - control, levels = design)

# --- 3. Run DS test ---
res_DS <- testDS_limma(d_counts, d_medians, design, contrast)

# --- 4. Extract and inspect results ---
ds_table <- topTable(res_DS, all = TRUE, show_meds = TRUE, format_vals = TRUE, digits = 3)
ds_sig <- ds_table[ds_table$p_adj < 0.05, ]
cat("Significant DS cluster-marker pairs:", nrow(ds_sig), "\n")
print(ds_sig)

# --- 5. Visualize ---
plotDiffHeatmap(sce, rowData(res_DS), all = TRUE, fdr = 0.05)
```

## plotDiffHeatmap()

CATALYST visualization function for diffcyt results. Displays differential heatmaps for DA or DS results.

```r
# DA heatmap — shows cluster abundance changes
plotDiffHeatmap(sce, rowData(res_DA), all = TRUE, fdr = 0.05)

# DS heatmap — shows marker expression changes within clusters
plotDiffHeatmap(sce, rowData(res_DS), all = TRUE, fdr = 0.05)

# Show only top N
plotDiffHeatmap(sce, rowData(res_DA), top_n = 20, fdr = 0.05)

# Save to file
library(ggplot2)
p <- plotDiffHeatmap(sce, rowData(res_DA), all = TRUE, fdr = 0.05)
ggsave("figures/da_heatmap.png", p, width = 10, height = 8, dpi = 300)
ggsave("figures/da_heatmap.pdf", p, width = 10, height = 8)
```

### diffcyt's Own plotHeatmap()

diffcyt also provides `plotHeatmap()` when using the wrapper `diffcyt()` function output.

```r
# Using diffcyt wrapper output
out_DA <- diffcyt(
  d_input, experiment_info, marker_info,
  design = design, contrast = contrast,
  analysis_type = "DA", method_DA = "diffcyt-DA-edgeR",
  seed_clustering = 123
)
plotHeatmap(out_DA, analysis_type = "DA")
plotHeatmap(out_DA, analysis_type = "DA", threshold = 0.05, top_n = 30)
```

## With Random Effects (Paired/Longitudinal Designs)

For paired samples (e.g., same patient pre vs post treatment) or longitudinal data, use the GLMM/LMM methods.

```r
library(diffcyt)
library(CATALYST)
library(SummarizedExperiment)
library(lme4)

# --- Experiment info for paired design ---
# 4 patients, each measured pre and post treatment
experiment_info <- data.frame(
  sample_id  = factor(paste0("sample", 1:8)),
  patient_id = factor(rep(paste0("patient", 1:4), 2)),
  condition  = factor(rep(c("pre", "post"), each = 4)),
  stringsAsFactors = FALSE
)

# --- Create formula with random effects ---
formula_obj <- createFormula(
  experiment_info,
  cols_fixed  = "condition",
  cols_random = c("sample_id", "patient_id")
)

# --- Contrast ---
contrast <- createContrast(c(0, 1))

# --- DA with GLMM ---
d_counts <- calcCounts(sce)
res_DA_glmm <- testDA_GLMM(d_counts, formula_obj$formula, contrast)
topTable(res_DA_glmm, all = TRUE, format_vals = TRUE)

# --- DS with LMM ---
d_medians <- calcMedians(sce)
res_DS_lmm <- testDS_LMM(d_counts, d_medians, formula_obj$formula, contrast)
topTable(res_DS_lmm, all = TRUE, format_vals = TRUE)
```

## Saving Results

```r
# --- DA results ---
da_results <- topTable(res_DA, all = TRUE, show_counts = TRUE, format_vals = TRUE, digits = 3)
write.csv(da_results, "output/da_results.csv", row.names = FALSE)

# Filter significant
da_sig <- da_results[da_results$p_adj < 0.05, ]
write.csv(da_sig, "output/da_significant.csv", row.names = FALSE)

# --- DS results ---
ds_results <- topTable(res_DS, all = TRUE, show_meds = TRUE, format_vals = TRUE, digits = 3)
write.csv(ds_results, "output/ds_results.csv", row.names = FALSE)

# Filter significant
ds_sig <- ds_results[ds_results$p_adj < 0.05, ]
write.csv(ds_sig, "output/ds_significant.csv", row.names = FALSE)
```

## Gotchas

- `min_cells` (default 3): clusters with fewer cells in any sample are excluded from testing. Setting too high drops rare populations; too low gives unstable estimates.
- `min_samples`: minimum number of samples per group that must pass the `min_cells` threshold. Clusters failing this are excluded.
- DA tests proportions, not absolute counts. An increase in one population forces apparent decreases in others (compositional constraint). Consider TMM normalization (`normalize = TRUE, norm_factors = "TMM"`) to partially address this.
- DS testing uses median marker expression per cluster per sample. Highly influenced by outlier cells. Larger clusters give more stable medians.
- Design matrix must NOT include an intercept when using `makeContrasts()`. Use `~ 0 + condition`, not `~ condition`.
- `testDA_GLMM()` and `testDS_LMM()` require the `lme4` package. These are slower than edgeR/limma methods.
- The contrast must be a single-column matrix (one comparison at a time). For multiple comparisons, run separate tests with different contrasts.
- For >20 clusters x multiple markers, multiple testing correction (BH) becomes aggressive. Consider testing biologically motivated subsets of clusters or markers.
- `calcCounts()` and `calcMedians()` require cluster assignments in `colData(sce)$cluster_id`. This is set by `CATALYST::cluster()`. If missing, you get an error about missing `cluster_id`.
- DS testing only uses "state" markers (functional markers like phospho-proteins, activation markers). "Type" markers (lineage markers used for clustering) are excluded by default. Control this via the `markers_to_test` parameter.
- `plotDiffHeatmap()` is from CATALYST, not diffcyt. It takes the SCE and `rowData()` of the result object.
- `createFormula()` returns a list with `$formula`, `$data`, and `$random_terms`. Pass `formula_obj$formula` to the GLMM/LMM functions, not the list itself.
- `testDS_limma()` requires both `d_counts` and `d_medians` as inputs (counts are used for precision weights). `testDA_edgeR()` requires only `d_counts`.
