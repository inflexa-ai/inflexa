#!/usr/bin/env Rscript
# tpl-qc-eda — Sample structure QC on a bulk RNA-seq count matrix.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: a DESeqDataSet with the design ~ 1, a variance stabilizing
# transformation blind to the sample table, PCA on the most variable genes,
# a Euclidean sample distance heatmap, and the library size and the number of
# detected genes per sample with a low depth flag against the median library
# size (Love et al. 2014; Love et al. 2015; Conesa et al. 2016).

suppressPackageStartupMessages({
  library(DESeq2)
  library(ggplot2)
  library(pheatmap)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
COUNTS_PATH      <- {{counts_path}}  # [adaptable: counts_path]
METADATA_PATH    <- {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN <- {{sample_id_column}}  # [adaptable: sample_id_column]
CONDITION_COLUMN <- {{condition_column}}  # [adaptable: condition_column]
{{#if batch_column}}
BATCH_COLUMN     <- {{batch_column}}  # [adaptable: batch_column]
{{/if}}
{{#unless batch_column}}
BATCH_COLUMN     <- NA_character_  # [adaptable: batch_column] NA: no batch column, one point shape in the PCA
{{/unless}}
N_TOP_GENES_PCA  <- {{n_top_genes_pca}}  # [adaptable: n_top_genes_pca]
LOW_DEPTH_RATIO  <- {{low_depth_ratio}}  # [adaptable: low_depth_ratio]
OUTPUT_PREFIX    <- {{output_prefix}}  # [adaptable: output_prefix]

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))

save_figure <- function(plot, name, width = 6, height = 5) {
  ggsave(fig(paste0(name, ".png")), plot, width = width, height = height, dpi = 300)
  ggsave(fig(paste0(name, ".pdf")), plot, width = width, height = height)
}

# ── Inputs ────────────────────────────────────────────────────────────────────
message("Reading counts from ", COUNTS_PATH)
counts_df <- read.csv(COUNTS_PATH, check.names = FALSE, stringsAsFactors = FALSE)
if (ncol(counts_df) < 2) stop("The count matrix needs a gene id column and at least one sample column")
gene_ids <- as.character(counts_df[[1]])
counts <- as.matrix(counts_df[, -1, drop = FALSE])
storage.mode(counts) <- "numeric"
rownames(counts) <- gene_ids
if (anyNA(counts)) stop("The count matrix holds a missing value")
if (any(counts < 0) || any(abs(counts - round(counts)) > 1e-6)) {
  stop("The count matrix must hold non-negative integers. This QC takes raw counts, not TPM or FPKM.")
}
counts <- round(counts)
if (ncol(counts) < 3) stop("The QC needs at least 3 samples for a PCA, the count matrix has ", ncol(counts))
if (any(duplicated(colnames(counts)))) stop("The count matrix header holds a duplicated sample id")

message("Reading the sample table from ", METADATA_PATH)
metadata <- read.csv(METADATA_PATH, check.names = FALSE, stringsAsFactors = FALSE)
if (!SAMPLE_ID_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", SAMPLE_ID_COLUMN)
if (!CONDITION_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", CONDITION_COLUMN)
has_batch <- !is.na(BATCH_COLUMN)
if (has_batch && !BATCH_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", BATCH_COLUMN)
if (any(duplicated(metadata[[SAMPLE_ID_COLUMN]]))) stop("The sample table holds a duplicated sample id in ", SAMPLE_ID_COLUMN)
rownames(metadata) <- as.character(metadata[[SAMPLE_ID_COLUMN]])
missing <- setdiff(colnames(counts), rownames(metadata))
if (length(missing) > 0) stop("Samples in the counts but not in the sample table: ", paste(missing, collapse = ", "))
metadata <- metadata[colnames(counts), , drop = FALSE]
metadata$condition <- factor(metadata[[CONDITION_COLUMN]])
if (anyNA(metadata$condition)) stop("The column ", CONDITION_COLUMN, " holds a missing value")
if (has_batch) {
  metadata$batch <- factor(metadata[[BATCH_COLUMN]])
  if (anyNA(metadata$batch)) stop("The column ", BATCH_COLUMN, " holds a missing value")
}
message("Samples: ", ncol(counts), "; genes: ", nrow(counts))
message("Condition levels: ", paste(levels(metadata$condition), collapse = ", "))
if (has_batch) message("Batch levels: ", paste(levels(metadata$batch), collapse = ", "))

# ── Library sizes ─────────────────────────────────────────────────────────────
library_size <- colSums(counts)
detected_genes <- colSums(counts > 0)
median_library_size <- median(library_size)
if (median_library_size <= 0) stop("The median library size is 0, the count matrix is empty")
ratio_to_median <- library_size / median_library_size
low_depth <- ratio_to_median < 1 / LOW_DEPTH_RATIO
library_table <- data.frame(
  sample = colnames(counts),
  library_size = as.numeric(library_size),
  detected_genes = as.integer(detected_genes),
  ratio_to_median = as.numeric(ratio_to_median),
  low_depth = as.logical(low_depth),
  stringsAsFactors = FALSE
)
write.csv(library_table, out("library_sizes.csv"), row.names = FALSE)
low_depth_samples <- library_table$sample[library_table$low_depth]
message("Median library size: ", format(median_library_size, big.mark = ","), "; low depth flag below 1/", LOW_DEPTH_RATIO, " of the median")
message("Library sizes: ", paste(sprintf("%s=%s (%.2fx)", library_table$sample, format(library_table$library_size, big.mark = ",", trim = TRUE), library_table$ratio_to_median), collapse = ", "))
if (length(low_depth_samples) > 0) {
  message("Low depth samples: ", paste(low_depth_samples, collapse = ", "))
} else {
  message("Low depth samples: none")
}

# ── Variance stabilizing transformation ───────────────────────────────────────
dds <- DESeqDataSetFromMatrix(countData = counts, colData = metadata, design = ~ 1)
dds <- estimateSizeFactors(dds)
message("Size factors: ", paste(sprintf("%s=%.2f", colnames(dds), sizeFactors(dds)), collapse = ", "))
n_informative <- sum(rowMeans(counts(dds, normalized = TRUE)) > 5)
if (n_informative >= 1000) {
  message("vst(blind = TRUE) on ", nrow(dds), " genes")
  vsd <- vst(dds, blind = TRUE)
} else {
  message("varianceStabilizingTransformation(blind = TRUE) on ", nrow(dds), " genes: fewer than 1000 genes have a mean normalized count above 5")
  vsd <- varianceStabilizingTransformation(dds, blind = TRUE)
}
write.csv(data.frame(gene = rownames(vsd), assay(vsd), check.names = FALSE), out("vst.csv"), row.names = FALSE)

# ── PCA ───────────────────────────────────────────────────────────────────────
n_top <- min(N_TOP_GENES_PCA, nrow(vsd))
intgroup <- if (has_batch) c("condition", "batch") else "condition"
pca <- plotPCA(vsd, intgroup = intgroup, ntop = n_top, returnData = TRUE)
percent_var <- 100 * attr(pca, "percentVar")
message("PCA on the top ", n_top, " variable genes: PC1 ", round(percent_var[1], 1), "%, PC2 ", round(percent_var[2], 1), "%")
pca_table <- data.frame(sample = as.character(pca$name), PC1 = pca$PC1, PC2 = pca$PC2, condition = as.character(pca$condition), stringsAsFactors = FALSE)
if (has_batch) pca_table$batch <- as.character(pca$batch)
write.csv(pca_table, out("pca.csv"), row.names = FALSE)

pca_plot <- if (has_batch) {
  ggplot(pca, aes(PC1, PC2, color = condition, shape = batch, label = name))
} else {
  ggplot(pca, aes(PC1, PC2, color = condition, label = name))
}
pca_plot <- pca_plot +
  geom_point(size = 3) +
  geom_text(vjust = -0.8, size = 2.5, show.legend = FALSE) +
  xlab(paste0("PC1: ", round(percent_var[1]), "% variance")) +
  ylab(paste0("PC2: ", round(percent_var[2]), "% variance")) +
  scale_color_viridis_d(end = 0.8) +
  ggtitle(paste0("PCA of the samples, VST (blind), top ", n_top, " variable genes")) +
  theme_classic()
save_figure(pca_plot, "pca")

# ── Sample distances ──────────────────────────────────────────────────────────
distances <- dist(t(assay(vsd)))
distance_matrix <- as.matrix(distances)
annotation <- data.frame(condition = metadata$condition, row.names = colnames(vsd))
if (has_batch) annotation$batch <- metadata$batch
draw_distances <- function() {
  pheatmap(distance_matrix, clustering_distance_rows = distances, clustering_distance_cols = distances, annotation_col = annotation, main = "Euclidean sample distances (VST, blind)")
}
png(fig("sample_distances.png"), width = 6, height = 5, units = "in", res = 300)
draw_distances()
dev.off()
pdf(fig("sample_distances.pdf"), width = 6, height = 5)
draw_distances()
dev.off()

# ── Library size figure ───────────────────────────────────────────────────────
library_long <- rbind(
  data.frame(sample = library_table$sample, metric = "Library size (counts)", value = library_table$library_size, low_depth = library_table$low_depth, stringsAsFactors = FALSE),
  data.frame(sample = library_table$sample, metric = "Detected genes (count > 0)", value = library_table$detected_genes, low_depth = library_table$low_depth, stringsAsFactors = FALSE)
)
library_long$metric <- factor(library_long$metric, levels = c("Library size (counts)", "Detected genes (count > 0)"))
library_long$sample <- factor(library_long$sample, levels = library_table$sample)
threshold_line <- data.frame(metric = factor("Library size (counts)", levels = levels(library_long$metric)), value = median_library_size / LOW_DEPTH_RATIO)
library_plot <- ggplot(library_long, aes(x = sample, y = value, fill = low_depth)) +
  geom_col() +
  geom_hline(data = threshold_line, aes(yintercept = value), linetype = "dashed") +
  facet_wrap(~ metric, ncol = 1, scales = "free_y") +
  scale_fill_manual(values = c(`FALSE` = "grey60", `TRUE` = "#D55E00"), name = paste0("Below 1/", LOW_DEPTH_RATIO, " of the median")) +
  xlab(NULL) + ylab(NULL) +
  ggtitle("Library size and detected genes per sample") +
  theme_classic() +
  theme(axis.text.x = element_text(angle = 60, hjust = 1), legend.position = "bottom")
save_figure(library_plot, "library_sizes", width = 7, height = 6)

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-qc-eda@1.0.0",
  method = "Sample structure QC: vst(blind = TRUE), PCA, sample distances, library sizes",
  design = "~ 1",
  inputs = list(counts = COUNTS_PATH, metadata = METADATA_PATH),
  condition_column = CONDITION_COLUMN,
  batch_column = if (has_batch) BATCH_COLUMN else NULL,
  n_samples = ncol(counts),
  n_genes = nrow(counts),
  group_sizes = as.list(table(metadata$condition)),
  median_library_size = median_library_size,
  low_depth_ratio = LOW_DEPTH_RATIO,
  n_low_depth_samples = length(low_depth_samples),
  low_depth_samples = I(as.character(low_depth_samples)),
  n_top_genes_pca = n_top,
  percent_variance = list(PC1 = round(percent_var[1], 2), PC2 = round(percent_var[2], 2)),
  size_factors = as.list(setNames(round(sizeFactors(dds), 4), colnames(dds))),
  versions = list(
    R = R.version.string,
    DESeq2 = as.character(packageVersion("DESeq2")),
    ggplot2 = as.character(packageVersion("ggplot2")),
    pheatmap = as.character(packageVersion("pheatmap"))
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA, null = "null")
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("summary.json"))
