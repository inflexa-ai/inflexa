#!/usr/bin/env Rscript
# tpl-deseq2-two-group — DESeq2 two-group differential expression.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: DESeq2 negative binomial GLM, Wald test on the condition coefficient,
# median-of-ratios size factors, independent filtering at alpha, and shrinkage
# of the reported log2 fold change (Love et al. 2014; Zhu et al. 2019).
#
# Import: the branch on IMPORT_STATE. Transcript quantifications reach the model
# through tximport with the average transcript length per gene and sample as
# the offset (Soneson et al. 2015); count estimates with a length table take
# the same offset; corrected or integer counts take no offset; an unknown
# state stops and names the missing input.

suppressPackageStartupMessages({
  library(DESeq2)
  library(ggplot2)
  library(pheatmap)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
IMPORT_STATE     <- "integer_counts"  # [adaptable: import_state]

COUNTS_PATH      <- "/eval-u25-live-2-with-two-group-n6-enrich-s1-1/data/inputs/local/counts.csv"  # [adaptable: counts_path]




QUANT_DIR        <- NULL  # [adaptable: quant_dir] NULL: the state is not quantifications



TX2GENE_PATH     <- NULL  # [adaptable: tx2gene_path] NULL: the state is not quantifications



LENGTHS_PATH     <- NULL  # [adaptable: lengths_path] NULL: the state is not estimated_counts_with_lengths

COUNTS_FROM_ABUNDANCE <- "no"  # [adaptable: counts_from_abundance]
LENGTH_OFFSET    <- TRUE  # [adaptable: length_offset]
METADATA_PATH    <- "/eval-u25-live-2-with-two-group-n6-enrich-s1-1/data/inputs/local/metadata.csv"  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN <- "sample"  # [adaptable: sample_id_column]
CONDITION_COLUMN <- "condition"  # [adaptable: condition_column]
REFERENCE_LEVEL  <- "control"  # [adaptable: reference_level]
TEST_LEVEL       <- "treated"  # [adaptable: test_level]
DESIGN           <- ~ condition  # [adaptable: design]
MIN_COUNT        <- 10  # [adaptable: min_count]

MIN_SAMPLES      <- 6  # [adaptable: min_samples]


ALPHA            <- 0.05
LFC_SHRINK       <- "apeglm"  # [adaptable: lfc_shrink]
LFC_THRESHOLD    <- 0  # [adaptable: lfc_threshold]
N_TOP_GENES_PCA  <- 500  # [adaptable: n_top_genes_pca]
OUTPUT_PREFIX    <- "de_treated_vs_control"  # [adaptable: output_prefix]

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))

save_figure <- function(plot, name, width = 6, height = 5) {
  ggsave(fig(paste0(name, ".png")), plot, width = width, height = height, dpi = 300)
  ggsave(fig(paste0(name, ".pdf")), plot, width = width, height = height)
}

# ── Inputs ────────────────────────────────────────────────────────────────────
# The sample table comes first: the quantifications branch takes the sample
# identifiers from it to find the quant.sf files.
message("Reading the sample table from ", METADATA_PATH)
metadata <- read.csv(METADATA_PATH, check.names = FALSE, stringsAsFactors = FALSE)
if (!SAMPLE_ID_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", SAMPLE_ID_COLUMN)
if (!CONDITION_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", CONDITION_COLUMN)
rownames(metadata) <- as.character(metadata[[SAMPLE_ID_COLUMN]])

sha256 <- function(path) unname(tools::sha256sum(path))
require_input <- function(value, slot, what) {
  if (is.null(value)) stop("The import state ", IMPORT_STATE, " needs ", what, ": set the slot ", slot)
  if (!file.exists(value)) stop("The ", what, " is missing: ", value)
  value
}
read_matrix <- function(path, what) {
  message("Reading the ", what, " from ", path)
  table <- read.csv(path, check.names = FALSE, stringsAsFactors = FALSE)
  matrix <- as.matrix(table[, -1, drop = FALSE])
  storage.mode(matrix) <- "numeric"
  rownames(matrix) <- as.character(table[[1]])
  if (any(is.na(matrix))) stop("The ", what, " holds a missing or a non-numeric value: ", path)
  matrix
}
# The import record of the summary: the state, the mode the model took, the map, and the files with their hashes.
import_record <- list(state = IMPORT_STATE, mode = NA, counts_from_abundance = COUNTS_FROM_ABUNDANCE, length_offset = FALSE, tx2gene = NA, files = list())
lengths <- NULL

if (IMPORT_STATE == "quantifications") {
  suppressPackageStartupMessages(library(tximport))
  require_input(QUANT_DIR, "quant_dir", "the quantification directory")
  require_input(TX2GENE_PATH, "tx2gene_path", "the transcript-to-gene map")
  if (!is.null(COUNTS_PATH)) message("counts_path is not read: the quantifications state imports the quant.sf files")
  samples <- rownames(metadata)
  files <- setNames(file.path(QUANT_DIR, samples, "quant.sf"), samples)
  absent <- samples[!file.exists(files)]
  if (length(absent) > 0) {
    stop("No quant.sf for ", length(absent), " of ", length(samples), " samples of the sample table: ", paste(absent, collapse = ", "), ". The script looks for <quant_dir>/<sample>/quant.sf under ", QUANT_DIR)
  }
  tx2gene <- read.csv(TX2GENE_PATH, check.names = FALSE, stringsAsFactors = FALSE)
  if (!all(c("transcript", "gene") %in% colnames(tx2gene))) stop("The transcript-to-gene map needs the columns transcript and gene: ", TX2GENE_PATH)
  tx2gene <- tx2gene[, c("transcript", "gene")]
  quantified <- read.delim(files[[1]], stringsAsFactors = FALSE)$Name
  n_unmapped <- sum(!quantified %in% tx2gene$transcript)
  message("tximport: ", length(files), " quant.sf files, ", length(quantified), " transcripts, ", n_unmapped, " absent from the map, countsFromAbundance = ", COUNTS_FROM_ABUNDANCE)
  txi <- tximport(files, type = "salmon", tx2gene = tx2gene, countsFromAbundance = COUNTS_FROM_ABUNDANCE)
  counts <- txi$counts
  if (LENGTH_OFFSET && COUNTS_FROM_ABUNDANCE == "no") {
    lengths <- txi$length
    import_record$mode <- "tximport_avg_tx_length_offset"
  } else if (COUNTS_FROM_ABUNDANCE != "no") {
    if (LENGTH_OFFSET) message("countsFromAbundance = ", COUNTS_FROM_ABUNDANCE, " carries the length correction inside the counts: the model takes no offset")
    import_record$mode <- paste0("tximport_", COUNTS_FROM_ABUNDANCE, "_no_offset")
  } else {
    message("length_offset is FALSE: the model takes the summed estimates with no length offset, and a change in isoform use can show as differential expression")
    import_record$mode <- "tximport_no_offset"
  }
  hashes <- sha256(files)
  import_record$tx2gene <- list(path = TX2GENE_PATH, sha256 = sha256(TX2GENE_PATH), n_transcripts = length(quantified), n_genes = nrow(counts), n_unmapped = n_unmapped)
  import_record$files <- lapply(seq_along(samples), function(i) list(sample = samples[i], path = unname(files[i]), sha256 = hashes[i]))
} else if (IMPORT_STATE == "estimated_counts_with_lengths") {
  require_input(COUNTS_PATH, "counts_path", "the count estimate table")
  require_input(LENGTHS_PATH, "lengths_path", "the average transcript length table")
  counts <- read_matrix(COUNTS_PATH, "count estimates")
  if (any(counts < 0)) stop("The count estimate table must hold non-negative values: ", COUNTS_PATH)
  lengths <- read_matrix(LENGTHS_PATH, "average transcript lengths")
  absent_genes <- setdiff(rownames(counts), rownames(lengths))
  absent_samples <- setdiff(colnames(counts), colnames(lengths))
  if (length(absent_genes) > 0) stop(length(absent_genes), " genes of the counts have no row in the length table, for example ", paste(head(absent_genes, 5), collapse = ", "))
  if (length(absent_samples) > 0) stop("Samples of the counts with no column in the length table: ", paste(absent_samples, collapse = ", "))
  lengths <- lengths[rownames(counts), colnames(counts), drop = FALSE]
  if (any(lengths <= 0)) stop("The average transcript length table must hold positive lengths: ", LENGTHS_PATH)
  if (LENGTH_OFFSET) {
    import_record$mode <- "estimated_counts_with_avg_tx_length_offset"
  } else {
    message("length_offset is FALSE: the model takes the rounded estimates with no length offset, and a change in isoform use can show as differential expression")
    lengths <- NULL
    import_record$mode <- "estimated_counts_no_offset"
  }
  import_record$files <- list(list(sample = NA, path = COUNTS_PATH, sha256 = sha256(COUNTS_PATH)), list(sample = NA, path = LENGTHS_PATH, sha256 = sha256(LENGTHS_PATH)))
} else if (IMPORT_STATE %in% c("corrected_counts", "integer_counts")) {
  require_input(COUNTS_PATH, "counts_path", "the count matrix")
  counts <- read_matrix(COUNTS_PATH, "counts")
  if (any(counts < 0)) stop("The count matrix must hold non-negative values: ", COUNTS_PATH)
  fractional <- any(abs(counts - round(counts)) > 1e-6)
  if (IMPORT_STATE == "integer_counts" && fractional) {
    stop("The count matrix holds non-integer values but the import state is integer_counts: name the import state of the table, estimated_counts_with_lengths with its length table or corrected_counts with its countsFromAbundance mode. DESeq2 takes counts, not TPM or FPKM.")
  }
  if (IMPORT_STATE == "corrected_counts" && COUNTS_FROM_ABUNDANCE == "no") {
    stop("The import state corrected_counts needs the correction mode of the table: set counts_from_abundance to lengthScaledTPM or scaledTPM")
  }
  if (fractional) message("The counts from abundance hold fractional values: the model takes them rounded, as DESeqDataSetFromTximport does")
  if (LENGTH_OFFSET) message("The import state ", IMPORT_STATE, " carries no lengths: the model takes no length offset")
  import_record$mode <- if (IMPORT_STATE == "corrected_counts") "length_corrected_counts_no_offset" else "gene_counts_without_length_offset"
  import_record$files <- list(list(sample = NA, path = COUNTS_PATH, sha256 = sha256(COUNTS_PATH)))
} else {
  stop("The import state is unknown: the length correction of the counts is not established. Give the quantification directory and the transcript-to-gene map (quant_dir, tx2gene_path, import_state quantifications), or the count estimates with the average transcript length table (counts_path, lengths_path, import_state estimated_counts_with_lengths), or name the state corrected_counts or integer_counts.")
}
import_record$length_offset <- !is.null(lengths)
message("Import: ", IMPORT_STATE, " -> ", import_record$mode)

# The estimates as imported, before the rounding and the filter, for the record.
write.csv(data.frame(gene = rownames(counts), round(counts, 3), check.names = FALSE), out("import_counts.csv"), row.names = FALSE)
if (!is.null(lengths)) write.csv(data.frame(gene = rownames(lengths), round(lengths, 3), check.names = FALSE), out("import_lengths.csv"), row.names = FALSE)

gene_ids <- rownames(counts)
counts <- round(counts)
missing <- setdiff(colnames(counts), rownames(metadata))
if (length(missing) > 0) stop("Samples in the counts but not in the sample table: ", paste(missing, collapse = ", "))
metadata <- metadata[colnames(counts), , drop = FALSE]
metadata$condition <- factor(metadata[[CONDITION_COLUMN]])
if (!all(c(REFERENCE_LEVEL, TEST_LEVEL) %in% levels(metadata$condition))) {
  stop("The condition column holds ", paste(levels(metadata$condition), collapse = ", "), " but not both ", REFERENCE_LEVEL, " and ", TEST_LEVEL)
}
metadata$condition <- relevel(metadata$condition, ref = REFERENCE_LEVEL)
for (column in setdiff(all.vars(DESIGN), "condition")) {
  if (!column %in% colnames(metadata)) stop("The design names ", column, " but the sample table has no such column")
  if (is.character(metadata[[column]])) metadata[[column]] <- factor(metadata[[column]])
}
message("Samples: ", ncol(counts), "; genes: ", nrow(counts), "; design: ", deparse(DESIGN))
message("Condition levels: ", paste(levels(metadata$condition), collapse = ", "), " (reference ", REFERENCE_LEVEL, ")")

# ── Filter ────────────────────────────────────────────────────────────────────
group_sizes <- table(metadata$condition)
if (is.na(MIN_SAMPLES)) MIN_SAMPLES <- as.integer(min(group_sizes))
keep <- rowSums(counts >= MIN_COUNT) >= MIN_SAMPLES
message("Low count filter: keep genes with >= ", MIN_COUNT, " counts in >= ", MIN_SAMPLES, " samples: ", sum(keep), " of ", nrow(counts), " kept")
counts <- counts[keep, , drop = FALSE]
if (!is.null(lengths)) lengths <- lengths[keep, , drop = FALSE]

# ── Model ─────────────────────────────────────────────────────────────────────
if (IMPORT_STATE == "quantifications" && !is.null(lengths)) {
  # DESeqDataSetFromTximport rounds the estimates and attaches the average transcript length as avgTxLength.
  kept <- list(abundance = txi$abundance[keep, , drop = FALSE], counts = txi$counts[keep, , drop = FALSE], length = lengths, countsFromAbundance = txi$countsFromAbundance)
  dds <- DESeqDataSetFromTximport(kept, colData = metadata, design = DESIGN)
} else {
  dds <- DESeqDataSetFromMatrix(countData = counts, colData = metadata, design = DESIGN)
  if (!is.null(lengths)) assays(dds)[["avgTxLength"]] <- lengths
}
dds <- DESeq(dds, quiet = TRUE)
# With avgTxLength DESeq2 fits a normalization factor per gene and sample instead of a size factor per sample;
# the per-sample geometric mean of the factors is the depth scale of the record.
size_factors <- sizeFactors(dds)
if (is.null(size_factors)) size_factors <- exp(colMeans(log(normalizationFactors(dds))))
message(if (is.null(sizeFactors(dds))) "Normalization factors with the length offset, per-sample geometric mean: " else "Size factors: ", paste(sprintf("%s=%.2f", colnames(dds), size_factors), collapse = ", "))

# ── Dispersion diagnostic (fit QC) ──────────────────────────────────────────
png(fig("dispersion.png"), width = 6, height = 5, units = "in", res = 300)
plotDispEsts(dds, main = "DESeq2 dispersion estimates (gene-wise, fitted trend, shrunken MAP)")
dev.off()
pdf(fig("dispersion.pdf"), width = 6, height = 5)
plotDispEsts(dds, main = "DESeq2 dispersion estimates (gene-wise, fitted trend, shrunken MAP)")
dev.off()

coefficient <- paste0("condition_", make.names(TEST_LEVEL), "_vs_", make.names(REFERENCE_LEVEL))
if (!coefficient %in% resultsNames(dds)) {
  stop("The coefficient ", coefficient, " is not in resultsNames: ", paste(resultsNames(dds), collapse = ", "))
}
res <- results(dds, name = coefficient, alpha = ALPHA, lfcThreshold = LFC_THRESHOLD)
unshrunken_lfc <- res$log2FoldChange

# ── Raw p-value histogram — inspected BEFORE trusting the BH adjustment ──────
# A well-behaved test gives a histogram flat/uniform on (0,1) with a spike near
# 0 for true effects; a hump elsewhere (e.g. near 1) would flag a misspecified
# null and would make the BH-adjusted padj untrustworthy.
pval_hist_df <- data.frame(pvalue = res$pvalue[!is.na(res$pvalue)])
pval_hist_plot <- ggplot(pval_hist_df, aes(x = pvalue)) +
  geom_histogram(breaks = seq(0, 1, by = 0.02), fill = "#3B528B", color = "white") +
  xlab("Raw p-value (Wald test)") + ylab("Number of genes") +
  ggtitle(paste0("Raw p-value distribution: ", TEST_LEVEL, " vs ", REFERENCE_LEVEL,
                 " (n=", nrow(pval_hist_df), " genes with a non-NA p-value)")) +
  theme_classic()
save_figure(pval_hist_plot, "pvalue_histogram")
message("Raw p-value histogram: ", sum(pval_hist_df$pvalue < 0.05), " of ", nrow(pval_hist_df),
        " genes have p < 0.05 before any multiplicity adjustment")

if (LFC_SHRINK == "apeglm") {
  message("Shrinking the log2 fold change with apeglm on ", coefficient)
  res_shrunk <- lfcShrink(dds, coef = coefficient, res = res, type = "apeglm", quiet = TRUE)
} else if (LFC_SHRINK == "ashr") {
  message("Shrinking the log2 fold change with ashr on the contrast")
  res_shrunk <- lfcShrink(dds, contrast = c("condition", TEST_LEVEL, REFERENCE_LEVEL), res = res, type = "ashr", quiet = TRUE)
} else {
  res_shrunk <- res
}

# ── NA-padj cause flag (count_outlier_policy = flag_and_report_na) ──────────
# DESeq2 sets pvalue (and hence padj) to NA for a gene whose Cook's distance
# flags a count outlier; it leaves pvalue but sets padj to NA for a gene
# independent filtering excludes on low mean count. Distinguish the two causes
# rather than treating every NA padj as the same thing.
na_padj_cause <- ifelse(
  is.na(res$pvalue), "cooks_outlier_na_pvalue",
  ifelse(is.na(res$padj), "independent_filtering_low_mean", NA_character_)
)

# ── Results table ─────────────────────────────────────────────────────────────
results_table <- data.frame(
  gene = rownames(res),
  base_mean = res$baseMean,
  log2_fold_change = res_shrunk$log2FoldChange,
  log2_fold_change_unshrunken = unshrunken_lfc,
  lfc_se = res_shrunk$lfcSE,
  stat = res$stat,
  pvalue = res$pvalue,
  adjusted_pvalue = res$padj,
  na_padj_cause = na_padj_cause,
  stringsAsFactors = FALSE
)
results_table <- results_table[order(results_table$pvalue, na.last = TRUE), ]
write.csv(results_table, out("results.csv"), row.names = FALSE)

# Which sample drives each Cook's-outlier-flagged gene (bears on the sample_01
# inclusion decision: if one sample dominates, that is evidence for exclusion;
# a diffuse spread across samples is not).
cooks_mat <- assays(dds)[["cooks"]]
outlier_genes <- rownames(res)[is.na(res$pvalue)]
if (length(outlier_genes) > 0 && !is.null(cooks_mat)) {
  max_cooks_sample <- apply(cooks_mat[outlier_genes, , drop = FALSE], 1, function(x) colnames(cooks_mat)[which.max(x)])
  outlier_by_sample <- as.data.frame(table(driving_sample = max_cooks_sample), stringsAsFactors = FALSE)
  colnames(outlier_by_sample) <- c("sample", "n_cooks_outlier_genes_driven")
} else {
  outlier_by_sample <- data.frame(sample = colnames(dds), n_cooks_outlier_genes_driven = 0L)
}
write.csv(outlier_by_sample, out("cooks_outlier_by_sample.csv"), row.names = FALSE)
message("Cook's-outlier NA genes: ", length(outlier_genes), "; independent-filtering NA genes: ",
        sum(na_padj_cause == "independent_filtering_low_mean", na.rm = TRUE))
message("Cook's outliers by driving sample: ", paste(sprintf("%s=%d", outlier_by_sample$sample, outlier_by_sample$n_cooks_outlier_genes_driven), collapse = ", "))

normalized <- counts(dds, normalized = TRUE)
write.csv(data.frame(gene = rownames(normalized), normalized, check.names = FALSE), out("normalized_counts.csv"), row.names = FALSE)

vsd <- vst(dds, blind = TRUE)
write.csv(data.frame(gene = rownames(vsd), assay(vsd), check.names = FALSE), out("vst.csv"), row.names = FALSE)

# ── Length-bias diagnostic (caveat check, not a correction) ─────────────────
# The quantifier/pipeline that produced these counts is unknown and no
# GC/length correction (cqn/EDASeq) is available in this environment. Check,
# per sample, whether each gene's normalized count relative to the
# across-sample geometric mean trends with gene length; report any trend as a
# caveat rather than correcting it.
GENE_LENGTHS_PATH <- "/eval-u25-live-2-with-two-group-n6-enrich-s1-1/data/inputs/local/gene_lengths.csv"  # [adaptable: gene lengths reference, not a template slot]
if (file.exists(GENE_LENGTHS_PATH)) {
  gene_length_tbl <- read.csv(GENE_LENGTHS_PATH, check.names = FALSE, stringsAsFactors = FALSE)
  rownames(gene_length_tbl) <- as.character(gene_length_tbl[[1]])
  common_genes <- intersect(rownames(normalized), rownames(gene_length_tbl))
  gene_len <- as.numeric(gene_length_tbl[common_genes, 2])
  norm_sub <- normalized[common_genes, , drop = FALSE]
  log_norm <- log2(norm_sub + 1)
  ref_log <- rowMeans(log_norm)
  log_len <- log2(gene_len)
  bias_rows <- lapply(colnames(norm_sub), function(s) {
    ratio <- log_norm[, s] - ref_log
    keep_idx <- is.finite(ratio) & is.finite(log_len)
    pear <- suppressWarnings(cor.test(log_len[keep_idx], ratio[keep_idx], method = "pearson"))
    spear <- suppressWarnings(cor.test(log_len[keep_idx], ratio[keep_idx], method = "spearman"))
    data.frame(sample = s, n_genes = sum(keep_idx),
               pearson_r = unname(pear$estimate), pearson_p = pear$p.value,
               spearman_rho = unname(spear$estimate), spearman_p = spear$p.value)
  })
  bias_table <- do.call(rbind, bias_rows)
  write.csv(bias_table, out("length_bias_correlations.csv"), row.names = FALSE)

  extreme_samples <- bias_table$sample[order(-abs(bias_table$pearson_r))][seq_len(min(2, nrow(bias_table)))]
  bias_plot_df <- do.call(rbind, lapply(extreme_samples, function(s) {
    ratio <- log_norm[, s] - ref_log
    data.frame(sample = s, log2_length = log_len, log2_ratio_to_mean = ratio)
  }))
  bias_plot <- ggplot(bias_plot_df, aes(x = log2_length, y = log2_ratio_to_mean)) +
    geom_point(size = 0.5, alpha = 0.4, color = "#31688E") +
    geom_smooth(method = "loess", se = FALSE, color = "#FDE725", linewidth = 0.8) +
    facet_wrap(~ sample) +
    xlab("log2(gene length)") + ylab("log2(normalized count / across-sample geometric mean)") +
    ggtitle("Length-bias diagnostic: two samples with the largest |Pearson r|") +
    theme_classic()
  save_figure(bias_plot, "length_bias_scatter", width = 8, height = 4.5)
  message("Length-bias diagnostic written: ", out("length_bias_correlations.csv"),
          "; max |pearson r| = ", round(max(abs(bias_table$pearson_r)), 3), " (", bias_table$sample[which.max(abs(bias_table$pearson_r))], ")")
} else {
  message("Gene length reference table not found at ", GENE_LENGTHS_PATH, "; length-bias diagnostic skipped")
  bias_table <- NULL
}

n_significant <- sum(!is.na(res$padj) & res$padj < ALPHA)
n_up <- sum(!is.na(res$padj) & res$padj < ALPHA & res_shrunk$log2FoldChange > 0)
n_down <- n_significant - n_up
message("Tested ", sum(!is.na(res$padj)), " genes after independent filtering; ", n_significant, " at padj < ", ALPHA, " (", n_up, " up, ", n_down, " down)")

# ── Figures ───────────────────────────────────────────────────────────────────
pca <- plotPCA(vsd, intgroup = "condition", ntop = min(N_TOP_GENES_PCA, nrow(vsd)), returnData = TRUE)
percent_var <- round(100 * attr(pca, "percentVar"))
pca_plot <- ggplot(pca, aes(PC1, PC2, color = condition, label = name)) +
  geom_point(size = 3) +
  geom_text(vjust = -0.8, size = 2.5, show.legend = FALSE) +
  xlab(paste0("PC1: ", percent_var[1], "% variance")) +
  ylab(paste0("PC2: ", percent_var[2], "% variance")) +
  scale_color_viridis_d(end = 0.8) +
  ggtitle("PCA of the samples, VST, top variable genes") +
  theme_classic()
save_figure(pca_plot, "pca")

distances <- dist(t(assay(vsd)))
distance_matrix <- as.matrix(distances)
annotation <- data.frame(condition = metadata$condition, row.names = colnames(vsd))
png(fig("sample_distances.png"), width = 6, height = 5, units = "in", res = 300)
pheatmap(distance_matrix, clustering_distance_rows = distances, clustering_distance_cols = distances, annotation_col = annotation, main = "Euclidean sample distances (VST)")
dev.off()
pdf(fig("sample_distances.pdf"), width = 6, height = 5)
pheatmap(distance_matrix, clustering_distance_rows = distances, clustering_distance_cols = distances, annotation_col = annotation, main = "Euclidean sample distances (VST)")
dev.off()

plot_df <- results_table[!is.na(results_table$adjusted_pvalue), ]
plot_df$significant <- plot_df$adjusted_pvalue < ALPHA
ma_plot <- ggplot(plot_df, aes(x = base_mean, y = log2_fold_change, color = significant)) +
  geom_point(size = 0.6, alpha = 0.6) +
  scale_x_log10() +
  scale_color_manual(values = c(`FALSE` = "grey60", `TRUE` = "#440154"), name = paste0("padj < ", ALPHA)) +
  geom_hline(yintercept = 0, linetype = "dashed") +
  xlab("Mean of normalized counts") + ylab("Shrunken log2 fold change") +
  ggtitle(paste0("MA plot: ", TEST_LEVEL, " vs ", REFERENCE_LEVEL)) +
  theme_classic()
save_figure(ma_plot, "ma")

top_labels <- head(plot_df[order(plot_df$adjusted_pvalue), ], 15)
volcano_plot <- ggplot(plot_df, aes(x = log2_fold_change, y = -log10(adjusted_pvalue), color = significant)) +
  geom_point(size = 0.6, alpha = 0.6) +
  geom_text(data = top_labels, aes(label = gene), size = 2.5, vjust = -0.6, show.legend = FALSE) +
  scale_color_manual(values = c(`FALSE` = "grey60", `TRUE` = "#21908C"), name = paste0("padj < ", ALPHA)) +
  geom_hline(yintercept = -log10(ALPHA), linetype = "dashed") +
  xlab("Shrunken log2 fold change") + ylab("-log10 adjusted p-value") +
  ggtitle(paste0("Volcano: ", TEST_LEVEL, " vs ", REFERENCE_LEVEL)) +
  theme_classic()
save_figure(volcano_plot, "volcano")

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-deseq2-two-group@1.1.0",
  method = "DESeq2 Wald test",
  import = import_record,
  contrast = list(factor = "condition", test = TEST_LEVEL, reference = REFERENCE_LEVEL),
  design = deparse(DESIGN),
  n_samples = ncol(counts),
  group_sizes = as.list(group_sizes),
  n_genes_input = length(gene_ids),
  n_genes_after_filter = nrow(counts),
  n_genes_tested = sum(!is.na(res$padj)),
  n_significant = n_significant,
  n_up = n_up,
  n_down = n_down,
  alpha = ALPHA,
  lfc_threshold = LFC_THRESHOLD,
  lfc_shrink = LFC_SHRINK,
  min_count = MIN_COUNT,
  min_samples = MIN_SAMPLES,
  size_factors = as.list(setNames(round(size_factors, 4), colnames(dds))),
  na_padj = list(
    n_cooks_outlier_na_pvalue = sum(na_padj_cause == "cooks_outlier_na_pvalue", na.rm = TRUE),
    n_independent_filtering_low_mean = sum(na_padj_cause == "independent_filtering_low_mean", na.rm = TRUE),
    cooks_outlier_by_sample = as.list(setNames(outlier_by_sample$n_cooks_outlier_genes_driven, outlier_by_sample$sample))
  ),
  shallow_sample_decision = list(
    sample = "sample_01",
    decision = "kept",
    rationale = paste0(
      "T1S1 found sample_01 at 0.26x median library depth (size factor 0.29, lowest of the cohort) but ",
      "correctly placed on the control side of PC1 with no condition misassignment; its low depth widens its ",
      "per-gene dispersion/CI contribution via the size factor rather than biasing fold changes systematically. ",
      "Per plan policy, depth alone is not a removal criterion. This step additionally checked whether ",
      "sample_01 disproportionately drives Cook's-outlier NA calls (see cooks_outlier_by_sample); a diffuse ",
      "attribution across samples supports keeping it, a concentration in sample_01 alone would be evidence to revisit."
    )
  ),
  length_bias_diagnostic = if (!is.null(bias_table)) list(
    max_abs_pearson_r = round(max(abs(bias_table$pearson_r)), 4),
    sample_with_max_abs_r = bias_table$sample[which.max(abs(bias_table$pearson_r))],
    per_sample = bias_table
  ) else list(status = "skipped_no_length_table"),
  versions = list(
    R = R.version.string,
    DESeq2 = as.character(packageVersion("DESeq2")),
    tximport = if (IMPORT_STATE == "quantifications") as.character(packageVersion("tximport")) else NA,
    apeglm = if (requireNamespace("apeglm", quietly = TRUE)) as.character(packageVersion("apeglm")) else NA,
    ashr = if (requireNamespace("ashr", quietly = TRUE)) as.character(packageVersion("ashr")) else NA
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("results.csv"))
