#!/usr/bin/env Rscript
# tpl-decoupler-tf-activity — transcription factor activity with decoupleR on
# the CollecTRI regulons, from a contrast and per sample.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: a signed regulon network (source, target, weight = mode of
# regulation). The gene-level statistic of the contrast is the DESeq2 Wald
# statistic of the test level against the reference level, or the `stat`
# column of a given results table. The decoupleR univariate linear model (ulm)
# regresses the statistic on the signed target weights of each regulator; the
# t-value of the slope is the activity score, and Benjamini-Hochberg adjusts
# the p-values across the regulators. The same model on the variance
# stabilized matrix gives one score per regulator and sample (Badia-i-Mompel
# et al. 2022; Müller-Dott et al. 2023).

suppressPackageStartupMessages({
  library(decoupleR)
  library(DESeq2)
  library(ggplot2)
  library(pheatmap)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
COUNTS_PATH        <- {{counts_path}}  # [adaptable: counts_path]
METADATA_PATH      <- {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN   <- {{sample_id_column}}  # [adaptable: sample_id_column]
CONDITION_COLUMN   <- {{condition_column}}  # [adaptable: condition_column]
REFERENCE_LEVEL    <- {{reference_level}}  # [adaptable: reference_level]
TEST_LEVEL         <- {{test_level}}  # [adaptable: test_level]
{{#if results_path}}
RESULTS_PATH       <- {{results_path}}  # [adaptable: results_path]
{{/if}}
{{#unless results_path}}
RESULTS_PATH       <- NA_character_  # [adaptable: results_path] NA: fit DESeq2 on the counts for the contrast statistic
{{/unless}}
NETWORK_PATH       <- {{network_path}}  # [adaptable: network_path]
REGULON_COLLECTION <- {{regulon_collection}}  # [adaptable: regulon_collection]
ACTIVITY_METHOD    <- {{activity_method}}  # [adaptable: activity_method]
MIN_REGULON_SIZE   <- {{min_regulon_size}}  # [adaptable: min_regulon_size]
MIN_COUNT          <- {{min_count}}  # [adaptable: min_count]
ALPHA              <- {{alpha}}
N_TOP_REGULATORS   <- {{n_top_regulators}}  # [adaptable: n_top_regulators]
OUTPUT_PREFIX      <- {{output_prefix}}  # [adaptable: output_prefix]

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))

save_figure <- function(plot, name, width = 6, height = 5) {
  ggsave(fig(paste0(name, ".png")), plot, width = width, height = height, dpi = 300)
  ggsave(fig(paste0(name, ".pdf")), plot, width = width, height = height)
}

run_activity <- if (ACTIVITY_METHOD == "mlm") decoupleR::run_mlm else decoupleR::run_ulm

# ── Inputs ────────────────────────────────────────────────────────────────────
message("Reading counts from ", COUNTS_PATH)
counts_df <- read.csv(COUNTS_PATH, check.names = FALSE, stringsAsFactors = FALSE)
gene_ids <- as.character(counts_df[[1]])
counts <- as.matrix(counts_df[, -1, drop = FALSE])
storage.mode(counts) <- "numeric"
rownames(counts) <- gene_ids
if (any(counts < 0, na.rm = TRUE) || any(abs(counts - round(counts)) > 1e-6, na.rm = TRUE)) {
  stop("The count matrix must hold non-negative integers. DESeq2 takes raw counts, not TPM or FPKM.")
}
counts <- round(counts)

message("Reading the sample table from ", METADATA_PATH)
metadata <- read.csv(METADATA_PATH, check.names = FALSE, stringsAsFactors = FALSE)
if (!SAMPLE_ID_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", SAMPLE_ID_COLUMN)
if (!CONDITION_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", CONDITION_COLUMN)
rownames(metadata) <- as.character(metadata[[SAMPLE_ID_COLUMN]])
missing <- setdiff(colnames(counts), rownames(metadata))
if (length(missing) > 0) stop("Samples in the counts but not in the sample table: ", paste(missing, collapse = ", "))
metadata <- metadata[colnames(counts), , drop = FALSE]
metadata$condition <- factor(metadata[[CONDITION_COLUMN]])
if (!all(c(REFERENCE_LEVEL, TEST_LEVEL) %in% levels(metadata$condition))) {
  stop("The condition column holds ", paste(levels(metadata$condition), collapse = ", "), " but not both ", REFERENCE_LEVEL, " and ", TEST_LEVEL)
}
metadata$condition <- relevel(metadata$condition, ref = REFERENCE_LEVEL)
message("Samples: ", ncol(counts), "; genes: ", nrow(counts))
message("Condition levels: ", paste(levels(metadata$condition), collapse = ", "), " (reference ", REFERENCE_LEVEL, ")")

message("Reading the regulon network from ", NETWORK_PATH)
network_df <- read.csv(NETWORK_PATH, check.names = FALSE, stringsAsFactors = FALSE)
for (column in c("source", "target", "weight")) {
  if (!column %in% colnames(network_df)) stop("The network has no column ", column, "; it needs source, target, and weight")
}
network <- data.frame(
  source = as.character(network_df$source),
  target = as.character(network_df$target),
  mor = as.numeric(network_df$weight),
  stringsAsFactors = FALSE
)
network <- network[!is.na(network$mor) & network$mor != 0, ]
network <- network[!duplicated(network[, c("source", "target")]), ]
if (nrow(network) == 0) stop("The network holds no edge with a non-zero weight")
message("Network ", REGULON_COLLECTION, ": ", nrow(network), " edges, ", length(unique(network$source)), " regulators, ", length(unique(network$target)), " targets")
network_overlap <- length(intersect(unique(network$target), gene_ids))
message("Network targets among the genes of the counts: ", network_overlap, " of ", length(unique(network$target)))
if (network_overlap == 0) stop("No target of the network is among the gene identifiers of the counts; the identifier spaces do not match")

# ── Filter ────────────────────────────────────────────────────────────────────
group_sizes <- table(metadata$condition)
min_samples <- as.integer(min(group_sizes))
keep <- rowSums(counts >= MIN_COUNT) >= min_samples
message("Low count filter: keep genes with >= ", MIN_COUNT, " counts in >= ", min_samples, " samples: ", sum(keep), " of ", nrow(counts), " kept")
counts <- counts[keep, , drop = FALSE]

# ── Contrast statistic ────────────────────────────────────────────────────────
dds <- DESeqDataSetFromMatrix(countData = counts, colData = metadata, design = ~ condition)

if (is.na(RESULTS_PATH)) {
  message("Fitting DESeq2 Wald: ", TEST_LEVEL, " vs ", REFERENCE_LEVEL)
  dds <- DESeq(dds, quiet = TRUE)
  coefficient <- paste0("condition_", make.names(TEST_LEVEL), "_vs_", make.names(REFERENCE_LEVEL))
  if (!coefficient %in% resultsNames(dds)) {
    stop("The coefficient ", coefficient, " is not in resultsNames: ", paste(resultsNames(dds), collapse = ", "))
  }
  res <- results(dds, name = coefficient)
  contrast_stat <- setNames(res$stat, rownames(res))
  statistic_source <- "deseq2_wald"
} else {
  message("Reading the contrast statistic from ", RESULTS_PATH)
  results_df <- read.csv(RESULTS_PATH, check.names = FALSE, stringsAsFactors = FALSE)
  for (column in c("gene", "stat")) {
    if (!column %in% colnames(results_df)) stop("The results table has no column ", column, "; it needs gene and stat")
  }
  results_df <- results_df[!duplicated(results_df$gene), ]
  contrast_stat <- setNames(as.numeric(results_df$stat), as.character(results_df$gene))
  statistic_source <- "results_table"
}
contrast_stat <- contrast_stat[is.finite(contrast_stat)]
if (length(contrast_stat) == 0) stop("No gene has a finite contrast statistic")
message("Genes with a finite contrast statistic: ", length(contrast_stat))

# ── Regulator activity on the contrast ────────────────────────────────────────
tested_edges <- network[network$target %in% names(contrast_stat), ]
n_targets <- table(tested_edges$source)
contrast_matrix <- matrix(contrast_stat, ncol = 1, dimnames = list(names(contrast_stat), "contrast"))
message("Running decoupleR ", ACTIVITY_METHOD, " on the contrast statistic with minsize ", MIN_REGULON_SIZE)
activity <- as.data.frame(run_activity(contrast_matrix, network, .source = "source", .target = "target", .mor = "mor", minsize = MIN_REGULON_SIZE))
if (nrow(activity) == 0) stop("No regulator has at least ", MIN_REGULON_SIZE, " targets among the tested genes")
activity_table <- data.frame(
  regulator = activity$source,
  score = activity$score,
  pvalue = activity$p_value,
  padj = p.adjust(activity$p_value, method = "BH"),
  n_targets = as.integer(n_targets[activity$source]),
  stringsAsFactors = FALSE
)
activity_table <- activity_table[order(activity_table$pvalue, na.last = TRUE), ]
write.csv(activity_table, out("activity.csv"), row.names = FALSE)

n_regulators_tested <- nrow(activity_table)
n_significant <- sum(!is.na(activity_table$padj) & activity_table$padj < ALPHA)
n_up <- sum(!is.na(activity_table$padj) & activity_table$padj < ALPHA & activity_table$score > 0)
n_down <- n_significant - n_up
message("Tested ", n_regulators_tested, " regulators; ", n_significant, " at padj < ", ALPHA, " (", n_up, " up, ", n_down, " down)")

# ── Per-sample scores on the variance stabilized matrix ───────────────────────
vsd <- vst(dds, blind = TRUE, nsub = min(1000L, nrow(dds)))
vst_matrix <- assay(vsd)
message("Running decoupleR ", ACTIVITY_METHOD, " on the VST matrix for the per-sample scores")
sample_scores <- as.data.frame(run_activity(vst_matrix, network, .source = "source", .target = "target", .mor = "mor", minsize = MIN_REGULON_SIZE))
score_matrix <- matrix(NA_real_, nrow = length(unique(sample_scores$source)), ncol = ncol(vst_matrix),
                       dimnames = list(sort(unique(sample_scores$source)), colnames(vst_matrix)))
score_matrix[cbind(sample_scores$source, sample_scores$condition)] <- sample_scores$score
write.csv(data.frame(regulator = rownames(score_matrix), score_matrix, check.names = FALSE), out("scores.csv"), row.names = FALSE)

# ── Figures ───────────────────────────────────────────────────────────────────
top <- head(activity_table[order(activity_table$padj, activity_table$pvalue), ], N_TOP_REGULATORS)
top$significant <- !is.na(top$padj) & top$padj < ALPHA
top$regulator <- factor(top$regulator, levels = rev(top$regulator))
bar_plot <- ggplot(top, aes(x = score, y = regulator, fill = significant)) +
  geom_col() +
  scale_fill_manual(values = c(`FALSE` = "grey60", `TRUE` = "#21908C"), name = paste0("padj < ", ALPHA)) +
  geom_vline(xintercept = 0, linetype = "dashed") +
  xlab(paste0("Activity score (", ACTIVITY_METHOD, " t-value)")) + ylab(NULL) +
  ggtitle(paste0("Top regulators: ", TEST_LEVEL, " vs ", REFERENCE_LEVEL)) +
  theme_classic()
save_figure(bar_plot, "top_regulators", width = 6, height = 6)

heatmap_regulators <- intersect(as.character(head(activity_table$regulator, N_TOP_REGULATORS)), rownames(score_matrix))
heatmap_matrix <- score_matrix[heatmap_regulators, , drop = FALSE]
heatmap_matrix <- heatmap_matrix[apply(heatmap_matrix, 1, function(row) all(is.finite(row)) && sd(row) > 0), , drop = FALSE]
annotation <- data.frame(condition = metadata$condition, row.names = colnames(score_matrix))
draw_heatmap <- function() {
  pheatmap(heatmap_matrix, scale = "row", annotation_col = annotation, cluster_rows = nrow(heatmap_matrix) > 1,
           main = paste0("Per-sample ", ACTIVITY_METHOD, " scores, top regulators (row scaled)"), fontsize_row = 7)
}
png(fig("score_heatmap.png"), width = 6, height = 6, units = "in", res = 300)
draw_heatmap()
dev.off()
pdf(fig("score_heatmap.pdf"), width = 6, height = 6)
draw_heatmap()
dev.off()

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-decoupler-tf-activity@1.0.0",
  method = paste0("decoupleR ", ACTIVITY_METHOD),
  activity_method = ACTIVITY_METHOD,
  contrast = list(factor = "condition", test = TEST_LEVEL, reference = REFERENCE_LEVEL),
  statistic_source = statistic_source,
  network = list(
    name = REGULON_COLLECTION,
    path = NETWORK_PATH,
    n_edges = nrow(network),
    n_regulators = length(unique(network$source)),
    n_targets_in_counts = network_overlap
  ),
  min_regulon_size = MIN_REGULON_SIZE,
  n_samples = ncol(counts),
  group_sizes = as.list(group_sizes),
  n_genes_input = length(gene_ids),
  n_genes_after_filter = nrow(counts),
  n_genes_with_statistic = length(contrast_stat),
  n_regulators_tested = n_regulators_tested,
  n_significant = n_significant,
  n_up = n_up,
  n_down = n_down,
  alpha = ALPHA,
  adjustment = "BH",
  min_count = MIN_COUNT,
  per_sample_input = "vst",
  versions = list(
    R = R.version.string,
    decoupleR = as.character(packageVersion("decoupleR")),
    DESeq2 = as.character(packageVersion("DESeq2"))
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("activity.csv"))
