#!/usr/bin/env Rscript
# tpl-deseq2-lrt-timecourse — DESeq2 likelihood ratio test for a time course.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: DESeq2 negative binomial GLM, likelihood ratio test of the full
# design against the reduced design, median-of-ratios size factors, and
# independent filtering at alpha (Love et al. 2014). With a condition column
# and the default designs the test removes the condition:time terms, thus it
# finds the genes whose condition effect differs between time points. With one
# group and the designs ~ time against ~ 1 it finds the genes that change over
# time. The per-timepoint log2 fold changes are Wald contrasts on the full
# model: the condition effect at each time point, and each time point against
# the first. apeglm shrinks one coefficient and takes no contrast, thus the
# contrasts are shrunk with ashr (Stephens 2017), which takes a contrast vector.

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
IMPORT_STATE     <- {{import_state}}  # [adaptable: import_state]
COUNTS_PATH      <- {{counts_path}}  # [adaptable: counts_path] absent: the quantifications state takes quant_dir
QUANT_DIR        <- {{quant_dir}}  # [adaptable: quant_dir] absent: the state is not quantifications
TX2GENE_PATH     <- {{tx2gene_path}}  # [adaptable: tx2gene_path] absent: the state is not quantifications
LENGTHS_PATH     <- {{lengths_path}}  # [adaptable: lengths_path] absent: the state is not estimated_counts_with_lengths
COUNTS_FROM_ABUNDANCE <- {{counts_from_abundance}}  # [adaptable: counts_from_abundance]
LENGTH_OFFSET    <- {{length_offset}}  # [adaptable: length_offset]
METADATA_PATH       <- {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN    <- {{sample_id_column}}  # [adaptable: sample_id_column]
CONDITION_COLUMN    <- {{condition_column}}  # [adaptable: condition_column] absent: one group over time
REFERENCE_LEVEL     <- {{reference_level}}  # [adaptable: reference_level] absent: one group over time
TIME_COLUMN         <- {{time_column}}  # [adaptable: time_column]
TIME_ORDER          <- {{time_order}}  # [adaptable: time_order] absent: the order of first appearance in the sample table
FULL_DESIGN         <- {{full_design}}  # [adaptable: full_design]
REDUCED_DESIGN      <- {{reduced_design}}  # [adaptable: reduced_design]
MIN_COUNT           <- {{min_count}}  # [adaptable: min_count]
MIN_SAMPLES         <- {{min_samples}}  # [adaptable: min_samples] absent: the smallest condition-by-time cell, computed below
ALPHA               <- {{alpha}}
LFC_SHRINK          <- {{lfc_shrink}}  # [adaptable: lfc_shrink] ashr or none
N_TOP_GENES_PCA     <- {{n_top_genes_pca}}  # [adaptable: n_top_genes_pca]
N_TOP_GENES_HEATMAP <- {{n_top_genes_heatmap}}  # [adaptable: n_top_genes_heatmap]
OUTPUT_PREFIX       <- {{output_prefix}}  # [adaptable: output_prefix]

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))

save_figure <- function(plot, name, width = 6, height = 5) {
  ggsave(fig(paste0(name, ".png")), plot, width = width, height = height, dpi = 300)
  ggsave(fig(paste0(name, ".pdf")), plot, width = width, height = height)
}

if (!LFC_SHRINK %in% c("ashr", "none")) stop("lfc_shrink must be ashr or none, not ", LFC_SHRINK)
has_condition <- !is.na(CONDITION_COLUMN)
if (has_condition && is.na(REFERENCE_LEVEL)) stop("A condition column needs a reference_level")
if (!has_condition && !is.na(REFERENCE_LEVEL)) stop("A reference_level needs a condition_column")

# ── Inputs ────────────────────────────────────────────────────────────────────
# The sample table comes first: the quantifications branch takes the sample
# identifiers from it to find the quant.sf files.
message("Reading the sample table from ", METADATA_PATH)
metadata <- read.csv(METADATA_PATH, check.names = FALSE, stringsAsFactors = FALSE)
for (column in c(SAMPLE_ID_COLUMN, if (has_condition) CONDITION_COLUMN, TIME_COLUMN)) {
  if (!column %in% colnames(metadata)) stop("The sample table has no column ", column)
}
rownames(metadata) <- as.character(metadata[[SAMPLE_ID_COLUMN]])

sha256 <- function(path) unname(tools::sha256sum(path))
require_input <- function(value, slot, what) {
  if (is.na(value)) stop("The import state ", IMPORT_STATE, " needs ", what, ": set the slot ", slot)
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
  if (!is.na(COUNTS_PATH)) message("counts_path is not read: the quantifications state imports the quant.sf files")
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

if (has_condition) {
  metadata$condition <- factor(metadata[[CONDITION_COLUMN]])
  if (!REFERENCE_LEVEL %in% levels(metadata$condition)) {
    stop("The condition column holds ", paste(levels(metadata$condition), collapse = ", "), " but not ", REFERENCE_LEVEL)
  }
  if (nlevels(metadata$condition) < 2) stop("The condition column holds one level only. For one group over time, leave condition_column absent and set full_design ~ time and reduced_design ~ 1.")
  metadata$condition <- relevel(metadata$condition, ref = REFERENCE_LEVEL)
} else if ("condition" %in% union(all.vars(FULL_DESIGN), all.vars(REDUCED_DESIGN))) {
  stop("A design names condition, but no condition_column is set. For one group over time, set full_design ~ time and reduced_design ~ 1.")
}

time_values <- as.character(metadata[[TIME_COLUMN]])
if (length(TIME_ORDER) == 0) {
  time_levels <- unique(time_values)
} else {
  if (!setequal(TIME_ORDER, unique(time_values)) || anyDuplicated(TIME_ORDER) > 0) {
    stop("time_order must list each time level once: the sample table holds ", paste(unique(time_values), collapse = ", "), " but time_order gives ", paste(TIME_ORDER, collapse = ", "))
  }
  time_levels <- TIME_ORDER
}
metadata$time <- factor(time_values, levels = time_levels)
if (nlevels(metadata$time) < 2) stop("The time column holds one level only; a time course needs at least two")

design_columns <- setdiff(union(all.vars(FULL_DESIGN), all.vars(REDUCED_DESIGN)), c("condition", "time"))
for (column in design_columns) {
  if (!column %in% colnames(metadata)) stop("A design names ", column, " but the sample table has no such column")
  if (is.character(metadata[[column]])) metadata[[column]] <- factor(metadata[[column]])
}
if (!"time" %in% all.vars(FULL_DESIGN)) stop("The full design must name time")
if (has_condition && !"condition" %in% all.vars(FULL_DESIGN)) stop("The full design must name condition when a condition column is set")
full_terms <- attr(terms(FULL_DESIGN), "term.labels")
reduced_terms <- attr(terms(REDUCED_DESIGN), "term.labels")
extra_terms <- setdiff(reduced_terms, full_terms)
if (length(extra_terms) > 0) stop("The reduced design holds terms that the full design does not: ", paste(extra_terms, collapse = ", "))
removed_terms <- setdiff(full_terms, reduced_terms)
if (length(removed_terms) == 0) stop("The reduced design holds every term of the full design; the test has nothing to remove")
full_model_matrix <- model.matrix(FULL_DESIGN, data = metadata)
reduced_model_matrix <- model.matrix(REDUCED_DESIGN, data = metadata)
df_tested <- ncol(full_model_matrix) - ncol(reduced_model_matrix)
if (df_tested < 1) stop("The full design has no more coefficients than the reduced design")

message("Samples: ", ncol(counts), "; genes: ", nrow(counts))
message("Full design: ", deparse(FULL_DESIGN), "; reduced design: ", deparse(REDUCED_DESIGN))
message("Terms removed by the test: ", paste(removed_terms, collapse = ", "), " (", df_tested, " degrees of freedom)")
if (has_condition) message("Condition levels: ", paste(levels(metadata$condition), collapse = ", "), " (reference ", REFERENCE_LEVEL, ")")
message("Time levels: ", paste(levels(metadata$time), collapse = ", "))

# ── Filter ────────────────────────────────────────────────────────────────────
cell_sizes <- if (has_condition) table(metadata$condition, metadata$time) else table(metadata$time)
if (is.na(MIN_SAMPLES)) MIN_SAMPLES <- as.integer(min(cell_sizes[cell_sizes > 0]))
keep <- rowSums(counts >= MIN_COUNT) >= MIN_SAMPLES
message("Low count filter: keep genes with >= ", MIN_COUNT, " counts in >= ", MIN_SAMPLES, " samples: ", sum(keep), " of ", nrow(counts), " kept")
counts <- counts[keep, , drop = FALSE]
if (!is.null(lengths)) lengths <- lengths[keep, , drop = FALSE]

# ── Model ─────────────────────────────────────────────────────────────────────
if (IMPORT_STATE == "quantifications" && !is.null(lengths)) {
  # DESeqDataSetFromTximport rounds the estimates and attaches the average transcript length as avgTxLength.
  kept <- list(abundance = txi$abundance[keep, , drop = FALSE], counts = txi$counts[keep, , drop = FALSE], length = lengths, countsFromAbundance = txi$countsFromAbundance)
  dds <- DESeqDataSetFromTximport(kept, colData = metadata, design = FULL_DESIGN)
} else {
  dds <- DESeqDataSetFromMatrix(countData = counts, colData = metadata, design = FULL_DESIGN)
  if (!is.null(lengths)) assays(dds)[["avgTxLength"]] <- lengths
}
dds <- DESeq(dds, test = "LRT", reduced = REDUCED_DESIGN, quiet = TRUE)
# With avgTxLength DESeq2 fits a normalization factor per gene and sample instead of a size factor per sample;
# the per-sample geometric mean of the factors is the depth scale of the record.
size_factors <- sizeFactors(dds)
if (is.null(size_factors)) size_factors <- exp(colMeans(log(normalizationFactors(dds))))
message(if (is.null(sizeFactors(dds))) "Normalization factors with the length offset, per-sample geometric mean: " else "Size factors: ", paste(sprintf("%s=%.2f", colnames(dds), size_factors), collapse = ", "))

res <- results(dds, alpha = ALPHA)

# ── Results table ─────────────────────────────────────────────────────────────
results_table <- data.frame(
  gene = rownames(res),
  base_mean = res$baseMean,
  stat = res$stat,
  pvalue = res$pvalue,
  adjusted_pvalue = res$padj,
  stringsAsFactors = FALSE
)
results_table <- results_table[order(results_table$pvalue, na.last = TRUE), ]
write.csv(results_table, out("lrt_results.csv"), row.names = FALSE)

n_tested <- sum(!is.na(res$padj))
n_significant <- sum(!is.na(res$padj) & res$padj < ALPHA)
message("Tested ", n_tested, " genes after independent filtering; ", n_significant, " at padj < ", ALPHA)

# ── Per-timepoint log2 fold changes as contrasts on the full model ───────────
# A contrast is the difference between two rows of the full model matrix, with
# every other column of the sample table held equal, thus an additive covariate
# cancels. With a condition: the condition level against the reference at each
# time point. In every case: each time point against the first, within each
# condition level. The maximum likelihood value comes from the coefficients;
# the shrunken value comes from lfcShrink with ashr on the Wald contrast.
coefficients <- coef(dds)
template_rows <- as.data.frame(colData(dds))[c(1, 1), all.vars(FULL_DESIGN), drop = FALSE]
contrast_vector <- function(condition_a, time_a, condition_b, time_b) {
  rows <- template_rows
  if (has_condition) rows$condition <- factor(c(condition_a, condition_b), levels = levels(metadata$condition))
  rows$time <- factor(c(time_a, time_b), levels = levels(metadata$time))
  contrast_matrix <- model.matrix(FULL_DESIGN, data = rows)
  if (ncol(contrast_matrix) != ncol(coefficients)) {
    stop("The contrast has ", ncol(contrast_matrix), " columns but the model has ", ncol(coefficients), " coefficients")
  }
  contrast_matrix[1, ] - contrast_matrix[2, ]
}
contrasts <- list()
condition_levels <- if (has_condition) levels(metadata$condition) else NA_character_
if (has_condition) {
  for (level in setdiff(condition_levels, REFERENCE_LEVEL)) {
    for (time_level in levels(metadata$time)) {
      contrasts[[paste0(level, "_vs_", REFERENCE_LEVEL, "_at_", time_level)]] <- contrast_vector(level, time_level, REFERENCE_LEVEL, time_level)
    }
  }
}
first_time <- levels(metadata$time)[1]
for (level in condition_levels) {
  for (time_level in levels(metadata$time)[-1]) {
    name <- paste0(time_level, "_vs_", first_time, if (has_condition) paste0("_in_", level) else "")
    contrasts[[name]] <- contrast_vector(level, time_level, level, first_time)
  }
}
significant_genes <- results_table$gene[!is.na(results_table$adjusted_pvalue) & results_table$adjusted_pvalue < ALPHA]
timepoint_lfc <- data.frame(
  gene = significant_genes,
  adjusted_pvalue = results_table$adjusted_pvalue[match(significant_genes, results_table$gene)],
  stringsAsFactors = FALSE
)
for (name in names(contrasts)) {
  timepoint_lfc[[paste0("lfc_", name)]] <- as.numeric(coefficients[significant_genes, , drop = FALSE] %*% contrasts[[name]])
}
if (LFC_SHRINK == "ashr") {
  message("Shrinking ", length(contrasts), " contrasts with ashr")
  for (name in names(contrasts)) {
    wald <- results(dds, contrast = contrasts[[name]], test = "Wald", alpha = ALPHA)
    shrunken <- lfcShrink(dds, contrast = contrasts[[name]], res = wald, type = "ashr", quiet = TRUE)
    timepoint_lfc[[paste0("shrunken_lfc_", name)]] <- shrunken$log2FoldChange[match(significant_genes, rownames(shrunken))]
  }
}
write.csv(timepoint_lfc, out("timepoint_lfc.csv"), row.names = FALSE)
message("Per-timepoint log2 fold changes for ", nrow(timepoint_lfc), " significant genes: ", out("timepoint_lfc.csv"))

# ── Figures ───────────────────────────────────────────────────────────────────
vsd <- vst(dds, blind = TRUE)

pca <- plotPCA(vsd, intgroup = if (has_condition) c("condition", "time") else "time", ntop = min(N_TOP_GENES_PCA, nrow(vsd)), returnData = TRUE)
percent_var <- round(100 * attr(pca, "percentVar"))
point_shapes <- rep_len(c(16, 17, 15, 18, 8, 3, 4, 7, 9, 10, 11, 12, 13, 14, 0, 1, 2, 5, 6), nlevels(metadata$time))
pca_plot <- if (has_condition) {
  ggplot(pca, aes(PC1, PC2, color = condition, shape = time, label = name)) + scale_shape_manual(values = point_shapes)
} else {
  ggplot(pca, aes(PC1, PC2, color = time, label = name))
}
pca_plot <- pca_plot +
  geom_point(size = 3) +
  geom_text(vjust = -0.8, size = 2.5, show.legend = FALSE) +
  xlab(paste0("PC1: ", percent_var[1], "% variance")) +
  ylab(paste0("PC2: ", percent_var[2], "% variance")) +
  scale_color_viridis_d(end = 0.8) +
  ggtitle("PCA of the samples, VST, top variable genes") +
  theme_classic()
save_figure(pca_plot, "pca")

top_genes <- head(results_table$gene[!is.na(results_table$pvalue)], N_TOP_GENES_HEATMAP)
if (length(top_genes) >= 2) {
  sample_order <- if (has_condition) order(metadata$condition, metadata$time) else order(metadata$time)
  heatmap_matrix <- assay(vsd)[top_genes, sample_order, drop = FALSE]
  annotation <- if (has_condition) {
    data.frame(condition = metadata$condition, time = metadata$time, row.names = colnames(vsd))
  } else {
    data.frame(time = metadata$time, row.names = colnames(vsd))
  }
  annotation <- annotation[sample_order, , drop = FALSE]
  heatmap_title <- paste0("Top ", length(top_genes), " likelihood ratio test genes, VST, scaled by row")
  draw_heatmap <- function() {
    pheatmap(heatmap_matrix, scale = "row", cluster_cols = FALSE, annotation_col = annotation, fontsize_row = 6, main = heatmap_title)
  }
  png(fig("top_genes_heatmap.png"), width = 7, height = 8, units = "in", res = 300)
  draw_heatmap()
  dev.off()
  pdf(fig("top_genes_heatmap.pdf"), width = 7, height = 8)
  draw_heatmap()
  dev.off()
} else {
  message("Fewer than 2 genes have a p-value; no heatmap")
}

# ── Summary ───────────────────────────────────────────────────────────────────
cell_size_names <- if (has_condition) {
  paste(rep(rownames(cell_sizes), times = ncol(cell_sizes)), rep(colnames(cell_sizes), each = nrow(cell_sizes)), sep = ":")
} else {
  names(cell_sizes)
}
summary_record <- list(
  template = "tpl-deseq2-lrt-timecourse@1.2.0",
  import = import_record,
  method = "DESeq2 likelihood ratio test",
  full_design = deparse(FULL_DESIGN),
  reduced_design = deparse(REDUCED_DESIGN),
  terms_removed = as.list(removed_terms),
  df_tested = df_tested,
  condition = if (has_condition) list(column = CONDITION_COLUMN, levels = as.list(levels(metadata$condition)), reference = REFERENCE_LEVEL) else NULL,
  n_condition_levels = if (has_condition) nlevels(metadata$condition) else 1L,
  time = list(column = TIME_COLUMN, levels = as.list(levels(metadata$time))),
  contrasts = as.list(names(contrasts)),
  lfc_shrink = LFC_SHRINK,
  n_samples = ncol(counts),
  cell_sizes = as.list(setNames(as.integer(cell_sizes), cell_size_names)),
  n_genes_input = length(gene_ids),
  n_genes_after_filter = nrow(counts),
  n_genes_tested = n_tested,
  n_significant = n_significant,
  alpha = ALPHA,
  min_count = MIN_COUNT,
  min_samples = MIN_SAMPLES,
  n_top_genes_heatmap = N_TOP_GENES_HEATMAP,
  size_factors = as.list(setNames(round(size_factors, 4), colnames(dds))),
  versions = list(
    R = R.version.string,
    DESeq2 = as.character(packageVersion("DESeq2")),
    tximport = if (IMPORT_STATE == "quantifications") as.character(packageVersion("tximport")) else NA,
    ashr = if (LFC_SHRINK == "ashr") as.character(packageVersion("ashr")) else NULL,
    ggplot2 = as.character(packageVersion("ggplot2")),
    pheatmap = as.character(packageVersion("pheatmap"))
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA, null = "null")
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("lrt_results.csv"))
