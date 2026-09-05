#!/usr/bin/env Rscript
# tpl-qc-log-abundance — Sample structure QC on a TPM, FPKM, or log-scale matrix.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: log2(value + offset) on a linear-scale abundance (TPM, FPKM, RPKM),
# or the values as they are when they are already on a log2 scale, the number
# of detected genes per sample, PCA on the most variable genes, a Euclidean
# sample distance heatmap, and an MDS plot on the most variable genes (Ritchie
# et al. 2015; Conesa et al. 2016; Zhao et al. 2020). No count model and no
# variance stabilizing transformation applies to such values.

suppressPackageStartupMessages({
  library(limma)
  library(ggplot2)
  library(pheatmap)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
ABUNDANCE_PATH     <- {{abundance_path}}  # [adaptable: abundance_path]
METADATA_PATH      <- {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN   <- {{sample_id_column}}  # [adaptable: sample_id_column]
CONDITION_COLUMN   <- {{condition_column}}  # [adaptable: condition_column]
{{#if batch_column}}
BATCH_COLUMN       <- {{batch_column}}  # [adaptable: batch_column]
{{/if}}
{{#unless batch_column}}
BATCH_COLUMN       <- NA_character_  # [adaptable: batch_column] NA: no batch column, one point shape in the PCA and the MDS plot
{{/unless}}
VALUES_ARE_LOG     <- {{values_are_log}}  # [adaptable: values_are_log]
LOG_OFFSET         <- {{log_offset}}  # [adaptable: log_offset]
DETECTION_FLOOR    <- {{detection_floor}}  # [adaptable: detection_floor]
N_TOP_GENES        <- {{n_top_genes}}  # [adaptable: n_top_genes]
MDS_GENE_SELECTION <- {{mds_gene_selection}}
OUTPUT_PREFIX      <- {{output_prefix}}  # [adaptable: output_prefix]

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))
sample_qc_path <- file.path("output", paste0("sample_", OUTPUT_PREFIX, ".csv"))

save_figure <- function(plot, name, width = 6, height = 5) {
  ggsave(fig(paste0(name, ".png")), plot, width = width, height = height, dpi = 300)
  ggsave(fig(paste0(name, ".pdf")), plot, width = width, height = height)
}

save_base_figure <- function(draw, name, width = 6, height = 5) {
  png(fig(paste0(name, ".png")), width = width, height = height, units = "in", res = 300)
  draw()
  dev.off()
  pdf(fig(paste0(name, ".pdf")), width = width, height = height)
  draw()
  dev.off()
}

# ── Inputs ────────────────────────────────────────────────────────────────────
message("Reading the abundance matrix from ", ABUNDANCE_PATH)
abundance_df <- read.csv(ABUNDANCE_PATH, check.names = FALSE, stringsAsFactors = FALSE)
if (ncol(abundance_df) < 2) stop("The abundance matrix needs a gene id column and at least one sample column")
gene_ids <- as.character(abundance_df[[1]])
values <- as.matrix(abundance_df[, -1, drop = FALSE])
storage.mode(values) <- "numeric"
rownames(values) <- gene_ids
if (anyNA(values)) stop("The abundance matrix holds a missing or non-numeric value")
if (any(duplicated(gene_ids))) stop("The abundance matrix holds a duplicated gene identifier")
if (any(duplicated(colnames(values)))) stop("The abundance matrix header holds a duplicated sample id")
if (ncol(values) < 3) stop("The QC needs at least 3 samples for a PCA, the abundance matrix has ", ncol(values))

message("Reading the sample table from ", METADATA_PATH)
metadata <- read.csv(METADATA_PATH, check.names = FALSE, stringsAsFactors = FALSE)
if (!SAMPLE_ID_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", SAMPLE_ID_COLUMN)
if (!CONDITION_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", CONDITION_COLUMN)
has_batch <- !is.na(BATCH_COLUMN)
if (has_batch && !BATCH_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", BATCH_COLUMN)
if (any(duplicated(metadata[[SAMPLE_ID_COLUMN]]))) stop("The sample table holds a duplicated sample id in ", SAMPLE_ID_COLUMN)
rownames(metadata) <- as.character(metadata[[SAMPLE_ID_COLUMN]])
missing <- setdiff(colnames(values), rownames(metadata))
if (length(missing) > 0) stop("Samples in the abundance matrix but not in the sample table: ", paste(missing, collapse = ", "))
metadata <- metadata[colnames(values), , drop = FALSE]
metadata$condition <- factor(metadata[[CONDITION_COLUMN]])
if (anyNA(metadata$condition)) stop("The column ", CONDITION_COLUMN, " holds a missing value")
if (has_batch) {
  metadata$batch <- factor(metadata[[BATCH_COLUMN]])
  if (anyNA(metadata$batch)) stop("The column ", BATCH_COLUMN, " holds a missing value")
}
message("Samples: ", ncol(values), "; genes: ", nrow(values))
message("Condition levels: ", paste(levels(metadata$condition), collapse = ", "))
if (has_batch) message("Batch levels: ", paste(levels(metadata$batch), collapse = ", "))

# ── The log2 scale ────────────────────────────────────────────────────────────
# A TPM, FPKM, or RPKM value is already scaled within its sample. The transform
# to log2 gives the scale on which the distances and the PCA apply. A value
# that is already on the log2 scale stays as it is.
if (VALUES_ARE_LOG) {
  transform <- "none (the values are log2 already)"
  log_expression <- values
  if (max(values) > 50) message("Note: the largest value is ", round(max(values), 1), ", which is large for a log2 value. Make sure that values_are_log is correct.")
} else {
  transform <- paste0("log2(value + ", LOG_OFFSET, ")")
  if (any(values < 0)) stop("The abundance matrix holds a negative value. A linear-scale abundance is not negative. If the values are log2 already, set values_are_log to true.")
  if (any(values + LOG_OFFSET <= 0)) stop("A value plus the offset ", LOG_OFFSET, " is not positive, thus its log2 is not finite. Use a positive log_offset.")
  if (all(abs(values - round(values)) < 1e-6)) message("Note: every value is an integer. If the matrix holds raw counts, the count QC with a variance stabilizing transformation is the correct method.")
  log_expression <- log2(values + LOG_OFFSET)
}
message("Transform: ", transform)
write.csv(data.frame(gene = rownames(log_expression), log_expression, check.names = FALSE), out("log_expression.csv"), row.names = FALSE)

# ── Detected genes ────────────────────────────────────────────────────────────
detected_genes <- colSums(log_expression > DETECTION_FLOOR)
median_detected <- median(detected_genes)
message("Detected genes (log2 expression > ", DETECTION_FLOOR, "), median ", median_detected, ": ", paste(sprintf("%s=%d", colnames(log_expression), as.integer(detected_genes)), collapse = ", "))

# ── PCA ───────────────────────────────────────────────────────────────────────
gene_variance <- apply(log_expression, 1, var)
if (sum(gene_variance > 0) < 2) stop("Fewer than two genes vary across the samples, thus no PCA is possible")
n_top <- min(N_TOP_GENES, sum(gene_variance > 0))
top_genes <- names(sort(gene_variance, decreasing = TRUE))[seq_len(n_top)]
pca <- prcomp(t(log_expression[top_genes, , drop = FALSE]), center = TRUE, scale. = FALSE)
percent_var <- 100 * pca$sdev^2 / sum(pca$sdev^2)
message("PCA on the top ", n_top, " variable genes: PC1 ", round(percent_var[1], 1), "%, PC2 ", round(percent_var[2], 1), "%")

# ── MDS ───────────────────────────────────────────────────────────────────────
mds <- plotMDS(log_expression, top = n_top, gene.selection = MDS_GENE_SELECTION, plot = FALSE)
mds_var <- 100 * mds$var.explained[1:2]
message("MDS on the top ", n_top, " variable genes (", MDS_GENE_SELECTION, "): dim 1 ", round(mds_var[1], 1), "%, dim 2 ", round(mds_var[2], 1), "%")

# ── Sample table ──────────────────────────────────────────────────────────────
sample_table <- data.frame(
  sample = colnames(log_expression),
  detected_genes = as.integer(detected_genes),
  pc1 = as.numeric(pca$x[, 1]),
  pc2 = as.numeric(pca$x[, 2]),
  mds1 = as.numeric(mds$x),
  mds2 = as.numeric(mds$y),
  condition = as.character(metadata$condition),
  stringsAsFactors = FALSE
)
if (has_batch) sample_table$batch <- as.character(metadata$batch)
write.csv(sample_table, sample_qc_path, row.names = FALSE)

# ── Figures ───────────────────────────────────────────────────────────────────
plot_df <- sample_table
plot_df$condition <- metadata$condition
if (has_batch) plot_df$batch <- metadata$batch

scatter <- function(df, x, y, xlab, ylab, title) {
  plot <- if (has_batch) {
    ggplot(df, aes(.data[[x]], .data[[y]], color = condition, shape = batch, label = sample))
  } else {
    ggplot(df, aes(.data[[x]], .data[[y]], color = condition, label = sample))
  }
  plot +
    geom_point(size = 3) +
    geom_text(vjust = -0.8, size = 2.5, show.legend = FALSE) +
    xlab(xlab) + ylab(ylab) +
    scale_color_viridis_d(end = 0.8) +
    ggtitle(title) +
    theme_classic()
}

pca_plot <- scatter(plot_df, "pc1", "pc2",
  paste0("PC1: ", round(percent_var[1]), "% variance"),
  paste0("PC2: ", round(percent_var[2]), "% variance"),
  paste0("PCA of the samples, log2 expression, top ", n_top, " variable genes"))
save_figure(pca_plot, "pca")

mds_plot <- scatter(plot_df, "mds1", "mds2",
  paste0("Leading logFC dim 1 (", round(mds_var[1]), "%)"),
  paste0("Leading logFC dim 2 (", round(mds_var[2]), "%)"),
  paste0("MDS of the samples, log2 expression, top ", n_top, " variable genes"))
save_figure(mds_plot, "mds")

distances <- dist(t(log_expression))
distance_matrix <- as.matrix(distances)
annotation <- data.frame(condition = metadata$condition, row.names = colnames(log_expression))
if (has_batch) annotation$batch <- metadata$batch
draw_distances <- function() {
  pheatmap(distance_matrix, clustering_distance_rows = distances, clustering_distance_cols = distances, annotation_col = annotation, main = "Euclidean sample distances (log2 expression)")
}
save_base_figure(draw_distances, "sample_distances")

detected_df <- sample_table
detected_df$sample <- factor(detected_df$sample, levels = sample_table$sample)
detected_df$condition <- metadata$condition
detected_plot <- ggplot(detected_df, aes(x = sample, y = detected_genes, fill = condition)) +
  geom_col() +
  geom_hline(yintercept = median_detected, linetype = "dashed") +
  scale_fill_viridis_d(end = 0.8) +
  xlab(NULL) + ylab(paste0("Detected genes (log2 expression > ", DETECTION_FLOOR, ")")) +
  ggtitle("Detected genes per sample, the median dashed") +
  theme_classic() +
  theme(axis.text.x = element_text(angle = 60, hjust = 1), legend.position = "bottom")
save_figure(detected_plot, "detected_genes", width = 7, height = 5)

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-qc-log-abundance@1.0.0",
  method = "Sample structure QC on log abundance values: detected genes, PCA, sample distances, MDS",
  inputs = list(abundance = ABUNDANCE_PATH, metadata = METADATA_PATH),
  condition_column = CONDITION_COLUMN,
  batch_column = if (has_batch) BATCH_COLUMN else NULL,
  transform = transform,
  values_are_log = VALUES_ARE_LOG,
  log_offset = if (VALUES_ARE_LOG) NA else LOG_OFFSET,
  n_samples = ncol(log_expression),
  n_genes = nrow(log_expression),
  group_sizes = as.list(table(metadata$condition)),
  detection_floor = DETECTION_FLOOR,
  detected_genes = as.list(setNames(as.integer(detected_genes), colnames(log_expression))),
  median_detected_genes = median_detected,
  n_top_genes = n_top,
  mds_gene_selection = MDS_GENE_SELECTION,
  percent_variance = list(PC1 = round(percent_var[1], 2), PC2 = round(percent_var[2], 2)),
  mds_variance_explained = list(dim1 = round(mds_var[1], 2), dim2 = round(mds_var[2], 2)),
  versions = list(
    R = R.version.string,
    limma = as.character(packageVersion("limma")),
    ggplot2 = as.character(packageVersion("ggplot2")),
    pheatmap = as.character(packageVersion("pheatmap"))
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA, null = "null")
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("summary.json"))
