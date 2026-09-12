#!/usr/bin/env Rscript
# tpl-deseq2-interaction — DESeq2 2x2 factorial design with an interaction term.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: DESeq2 negative binomial GLM on ~ factor_a + factor_b + factor_a:factor_b,
# Wald test on the interaction coefficient and on the simple effect of factor_b
# inside each level of factor_a, median-of-ratios size factors, independent
# filtering at alpha, and ashr shrinkage of each reported log2 fold change
# (Love et al. 2014; Stephens 2017). ashr and not apeglm, because the simple
# effect inside the test level of factor_a is a contrast of two coefficients,
# and apeglm shrinks one coefficient only.

# Import: the branch on IMPORT_STATE. Transcript quantifications reach the model
# through tximport with the average transcript length per gene and sample as
# the offset (Soneson et al. 2015); count estimates with a length table take
# the same offset; corrected or integer counts take no offset; an unknown
# state stops and names the missing input.

suppressPackageStartupMessages({
  library(DESeq2)
  library(ggplot2)
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
METADATA_PATH      <- {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN   <- {{sample_id_column}}  # [adaptable: sample_id_column]
FACTOR_A_COLUMN    <- {{factor_a_column}}  # [adaptable: factor_a_column]
FACTOR_A_REFERENCE <- {{factor_a_reference}}  # [adaptable: factor_a_reference]
FACTOR_B_COLUMN    <- {{factor_b_column}}  # [adaptable: factor_b_column]
FACTOR_B_REFERENCE <- {{factor_b_reference}}  # [adaptable: factor_b_reference]
DESIGN             <- ~ factor_a + factor_b + factor_a:factor_b
MIN_COUNT          <- {{min_count}}  # [adaptable: min_count]
MIN_SAMPLES        <- {{min_samples}}  # [adaptable: min_samples] absent: the smallest cell size, computed below
ALPHA              <- {{alpha}}
LFC_SHRINK         <- {{lfc_shrink}}  # [adaptable: lfc_shrink]
LFC_THRESHOLD      <- {{lfc_threshold}}  # [adaptable: lfc_threshold]
N_TOP_GENES_PCA    <- {{n_top_genes_pca}}  # [adaptable: n_top_genes_pca]
OUTPUT_PREFIX      <- {{output_prefix}}  # [adaptable: output_prefix]

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))
file_token <- function(level) gsub("[^A-Za-z0-9_.-]", "_", level)

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
if (!FACTOR_A_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", FACTOR_A_COLUMN)
if (!FACTOR_B_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", FACTOR_B_COLUMN)
if (FACTOR_A_COLUMN == FACTOR_B_COLUMN) stop("factor_a_column and factor_b_column name the same column ", FACTOR_A_COLUMN)
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

two_level_factor <- function(column, reference, label) {
  values <- factor(metadata[[column]])
  if (nlevels(values) != 2) {
    stop("The column ", column, " (", label, ") must hold exactly two levels for a 2x2 design, but holds ",
         nlevels(values), ": ", paste(levels(values), collapse = ", "))
  }
  if (!reference %in% levels(values)) {
    stop("The column ", column, " holds ", paste(levels(values), collapse = ", "), " but not the reference level ", reference)
  }
  relevel(values, ref = reference)
}
metadata$factor_a <- two_level_factor(FACTOR_A_COLUMN, FACTOR_A_REFERENCE, "factor_a")
metadata$factor_b <- two_level_factor(FACTOR_B_COLUMN, FACTOR_B_REFERENCE, "factor_b")
FACTOR_A_TEST <- levels(metadata$factor_a)[2]
FACTOR_B_TEST <- levels(metadata$factor_b)[2]
cell_sizes <- table(metadata$factor_a, metadata$factor_b)
cell_text <- paste(sprintf("%s/%s=%d", rep(rownames(cell_sizes), times = 2), rep(colnames(cell_sizes), each = 2), as.vector(cell_sizes)), collapse = ", ")
if (any(cell_sizes == 0)) stop("Each of the four cells of the 2x2 design needs at least one sample. Cell sizes: ", cell_text)
if (any(cell_sizes < 2)) message("Warning: a cell holds one sample only, thus the interaction test has low power. Cell sizes: ", cell_text)
message("Samples: ", ncol(counts), "; genes: ", nrow(counts), "; design: ", deparse(DESIGN))
message("factor_a = ", FACTOR_A_COLUMN, ": ", FACTOR_A_TEST, " vs ", FACTOR_A_REFERENCE, " (reference)")
message("factor_b = ", FACTOR_B_COLUMN, ": ", FACTOR_B_TEST, " vs ", FACTOR_B_REFERENCE, " (reference)")
message("Cell sizes: ", cell_text)

# ── Filter ────────────────────────────────────────────────────────────────────
if (is.na(MIN_SAMPLES)) MIN_SAMPLES <- as.integer(min(cell_sizes))
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

coefficient_names <- resultsNames(dds)
find_coefficient <- function(expected, pattern, label) {
  if (expected %in% coefficient_names) return(expected)
  found <- grep(pattern, coefficient_names, value = TRUE)
  if (length(found) == 1) return(found)
  stop("The ", label, " coefficient ", expected, " is not in resultsNames: ", paste(coefficient_names, collapse = ", "))
}
b_coefficient <- find_coefficient(
  paste0("factor_b_", make.names(FACTOR_B_TEST), "_vs_", make.names(FACTOR_B_REFERENCE)),
  "^factor_b_.*_vs_", "factor_b main effect")
interaction_coefficient <- find_coefficient(
  paste0("factor_a", make.names(FACTOR_A_TEST), ".factor_b", make.names(FACTOR_B_TEST)),
  "^factor_a.*\\.factor_b", "interaction")
message("Interaction coefficient: ", interaction_coefficient, "; factor_b main effect: ", b_coefficient)

# ── Tests ─────────────────────────────────────────────────────────────────────
# One Wald test per table. `coef` names one coefficient, `contrast` gives the
# list form of results(): the sum of the named coefficients. The reported
# pvalue and adjusted_pvalue come from the Wald test, the reported
# log2_fold_change and lfc_se from the shrinkage estimator.
wald_table <- function(label, coef = NULL, contrast = NULL) {
  if (!is.null(coef)) {
    res <- results(dds, name = coef, alpha = ALPHA, lfcThreshold = LFC_THRESHOLD)
  } else {
    res <- results(dds, contrast = contrast, alpha = ALPHA, lfcThreshold = LFC_THRESHOLD)
  }
  if (LFC_SHRINK == "ashr") {
    message("Shrinking the log2 fold change of ", label, " with ashr")
    if (!is.null(coef)) {
      shrunk <- lfcShrink(dds, coef = coef, res = res, type = "ashr", quiet = TRUE)
    } else {
      shrunk <- lfcShrink(dds, contrast = contrast, res = res, type = "ashr", quiet = TRUE)
    }
  } else {
    shrunk <- res
  }
  table <- data.frame(
    gene = rownames(res),
    base_mean = res$baseMean,
    log2_fold_change = shrunk$log2FoldChange,
    lfc_se = shrunk$lfcSE,
    stat = res$stat,
    pvalue = res$pvalue,
    adjusted_pvalue = res$padj,
    stringsAsFactors = FALSE
  )
  table <- table[order(table$pvalue, na.last = TRUE), ]
  significant <- !is.na(table$adjusted_pvalue) & table$adjusted_pvalue < ALPHA
  counts_record <- list(
    n_tested = sum(!is.na(table$adjusted_pvalue)),
    n_significant = sum(significant),
    n_up = sum(significant & table$log2_fold_change > 0),
    n_down = sum(significant & table$log2_fold_change <= 0)
  )
  message(label, ": tested ", counts_record$n_tested, " genes after independent filtering; ", counts_record$n_significant,
          " at padj < ", ALPHA, " (", counts_record$n_up, " up, ", counts_record$n_down, " down)")
  list(table = table, counts = counts_record)
}

interaction_label <- paste0(FACTOR_A_COLUMN, ":", FACTOR_B_COLUMN, " (", FACTOR_A_TEST, " x ", FACTOR_B_TEST, ")")
interaction <- wald_table(paste("interaction", interaction_label), coef = interaction_coefficient)
write.csv(interaction$table, out("interaction_results.csv"), row.names = FALSE)

simple_effect_label <- function(level_a) {
  paste0(FACTOR_B_COLUMN, " ", FACTOR_B_TEST, " vs ", FACTOR_B_REFERENCE, " within ", FACTOR_A_COLUMN, " = ", level_a)
}
simple_reference <- wald_table(simple_effect_label(FACTOR_A_REFERENCE), coef = b_coefficient)
write.csv(simple_reference$table, out(paste0("simple_effect_", file_token(FACTOR_A_REFERENCE), ".csv")), row.names = FALSE)
simple_test <- wald_table(simple_effect_label(FACTOR_A_TEST), contrast = list(c(b_coefficient, interaction_coefficient)))
write.csv(simple_test$table, out(paste0("simple_effect_", file_token(FACTOR_A_TEST), ".csv")), row.names = FALSE)

# ── Figures ───────────────────────────────────────────────────────────────────
vsd <- vst(dds, blind = TRUE)
pca <- plotPCA(vsd, intgroup = c("factor_a", "factor_b"), ntop = min(N_TOP_GENES_PCA, nrow(vsd)), returnData = TRUE)
percent_var <- round(100 * attr(pca, "percentVar"))
pca_plot <- ggplot(pca, aes(PC1, PC2, color = factor_a, shape = factor_b, label = name)) +
  geom_point(size = 3) +
  geom_text(vjust = -0.8, size = 2.5, show.legend = FALSE) +
  xlab(paste0("PC1: ", percent_var[1], "% variance")) +
  ylab(paste0("PC2: ", percent_var[2], "% variance")) +
  scale_color_viridis_d(end = 0.8, name = FACTOR_A_COLUMN) +
  scale_shape_discrete(name = FACTOR_B_COLUMN) +
  ggtitle("PCA of the samples, VST, top variable genes") +
  theme_classic()
save_figure(pca_plot, "pca")

plot_df <- interaction$table[!is.na(interaction$table$adjusted_pvalue), ]
plot_df$significant <- plot_df$adjusted_pvalue < ALPHA
ma_plot <- ggplot(plot_df, aes(x = base_mean, y = log2_fold_change, color = significant)) +
  geom_point(size = 0.6, alpha = 0.6) +
  scale_x_log10() +
  scale_color_manual(values = c(`FALSE` = "grey60", `TRUE` = "#440154"), name = paste0("padj < ", ALPHA)) +
  geom_hline(yintercept = 0, linetype = "dashed") +
  xlab("Mean of normalized counts") + ylab("Shrunken interaction log2 fold change") +
  ggtitle(paste0("MA plot, interaction: ", interaction_label)) +
  theme_classic()
save_figure(ma_plot, "ma")

top_labels <- head(plot_df[order(plot_df$adjusted_pvalue), ], 15)
volcano_plot <- ggplot(plot_df, aes(x = log2_fold_change, y = -log10(adjusted_pvalue), color = significant)) +
  geom_point(size = 0.6, alpha = 0.6) +
  geom_text(data = top_labels, aes(label = gene), size = 2.5, vjust = -0.6, show.legend = FALSE) +
  scale_color_manual(values = c(`FALSE` = "grey60", `TRUE` = "#21908C"), name = paste0("padj < ", ALPHA)) +
  geom_hline(yintercept = -log10(ALPHA), linetype = "dashed") +
  xlab("Shrunken interaction log2 fold change") + ylab("-log10 adjusted p-value") +
  ggtitle(paste0("Volcano, interaction: ", interaction_label)) +
  theme_classic()
save_figure(volcano_plot, "volcano")

# ── Summary ───────────────────────────────────────────────────────────────────
cell_sizes_record <- setNames(lapply(rownames(cell_sizes), function(level_a) {
  as.list(setNames(as.integer(cell_sizes[level_a, ]), colnames(cell_sizes)))
}), rownames(cell_sizes))
simple_effects_record <- list()
simple_effects_record[[FACTOR_A_REFERENCE]] <- c(list(coefficients = b_coefficient, file = basename(out(paste0("simple_effect_", file_token(FACTOR_A_REFERENCE), ".csv")))), simple_reference$counts)
simple_effects_record[[FACTOR_A_TEST]] <- c(list(coefficients = c(b_coefficient, interaction_coefficient), file = basename(out(paste0("simple_effect_", file_token(FACTOR_A_TEST), ".csv")))), simple_test$counts)

summary_record <- list(
  template = "tpl-deseq2-interaction@1.1.0",
  import = import_record,
  method = "DESeq2 Wald test",
  design = deparse(DESIGN),
  factor_a = list(column = FACTOR_A_COLUMN, reference = FACTOR_A_REFERENCE, test = FACTOR_A_TEST),
  factor_b = list(column = FACTOR_B_COLUMN, reference = FACTOR_B_REFERENCE, test = FACTOR_B_TEST),
  n_samples = ncol(counts),
  cell_sizes = cell_sizes_record,
  n_genes_input = length(gene_ids),
  n_genes_after_filter = nrow(counts),
  interaction = c(list(coefficient = interaction_coefficient), interaction$counts),
  simple_effects = simple_effects_record,
  alpha = ALPHA,
  lfc_threshold = LFC_THRESHOLD,
  lfc_shrink = LFC_SHRINK,
  min_count = MIN_COUNT,
  min_samples = MIN_SAMPLES,
  size_factors = as.list(setNames(round(size_factors, 4), colnames(dds))),
  versions = list(
    R = R.version.string,
    DESeq2 = as.character(packageVersion("DESeq2")),
    tximport = if (IMPORT_STATE == "quantifications") as.character(packageVersion("tximport")) else NA,
    ashr = if (requireNamespace("ashr", quietly = TRUE)) as.character(packageVersion("ashr")) else NA
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("interaction_results.csv"))
