#!/usr/bin/env Rscript
# tpl-progeny-pathway-activity — pathway activity with the PROGENy footprint
# model and decoupleR.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: the PROGENy model gives each signaling pathway a weighted set of the
# genes that respond to a perturbation of the pathway (Schubert et al. 2018).
# The decoupleR multivariate linear model (mlm) regresses the gene-level Wald
# statistic of one contrast on the weights of the top responsive genes of every
# pathway at once, and the t-value of each slope is the activity score
# (Badia-i-Mompel et al. 2022). The same model on the variance stabilized
# matrix gives one score per pathway and sample. The score is a footprint of
# the pathway, not the expression of its members.

suppressPackageStartupMessages({
  library(DESeq2)
  library(decoupleR)
  library(ggplot2)
  library(pheatmap)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
COUNTS_PATH          <- {{counts_path}}  # [adaptable: counts_path]
METADATA_PATH        <- {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN     <- {{sample_id_column}}  # [adaptable: sample_id_column]
CONDITION_COLUMN     <- {{condition_column}}  # [adaptable: condition_column]
REFERENCE_LEVEL      <- {{reference_level}}  # [adaptable: reference_level]
TEST_LEVEL           <- {{test_level}}  # [adaptable: test_level]
DESIGN               <- {{design}}  # [adaptable: design]
{{#if results_path}}
RESULTS_PATH         <- {{results_path}}  # [adaptable: results_path]
{{/if}}
{{#unless results_path}}
RESULTS_PATH         <- NA_character_  # [adaptable: results_path] NA: the script fits the contrast itself
{{/unless}}
MODEL_PATH           <- {{model_path}}  # [adaptable: model_path]
TOP_RESPONSIVE_GENES <- {{top_responsive_genes}}  # [adaptable: top_responsive_genes]
ACTIVITY_METHOD      <- {{activity_method}}  # [adaptable: activity_method]
MIN_SIZE             <- {{min_size}}  # [adaptable: min_size]
MIN_COUNT            <- {{min_count}}  # [adaptable: min_count]
ALPHA                <- {{alpha}}  # [adaptable: alpha]
OUTPUT_PREFIX        <- {{output_prefix}}  # [adaptable: output_prefix]

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))

save_figure <- function(plot, name, width = 6, height = 5) {
  ggsave(fig(paste0(name, ".png")), plot, width = width, height = height, dpi = 300)
  ggsave(fig(paste0(name, ".pdf")), plot, width = width, height = height)
}

if (!ACTIVITY_METHOD %in% c("mlm", "ulm")) stop("activity_method must be mlm or ulm, not ", ACTIVITY_METHOD)
run_activity <- if (ACTIVITY_METHOD == "mlm") decoupleR::run_mlm else decoupleR::run_ulm

# ── Inputs ────────────────────────────────────────────────────────────────────
message("Reading counts from ", COUNTS_PATH)
counts_df <- read.csv(COUNTS_PATH, check.names = FALSE, stringsAsFactors = FALSE)
gene_ids <- as.character(counts_df[[1]])
counts <- as.matrix(counts_df[, -1, drop = FALSE])
storage.mode(counts) <- "numeric"
rownames(counts) <- gene_ids
if (any(counts < 0, na.rm = TRUE) || any(abs(counts - round(counts)) > 1e-6, na.rm = TRUE)) {
  stop("The count matrix must hold non-negative integers. The script takes raw counts, not TPM or FPKM.")
}
counts <- round(counts)
if (any(duplicated(gene_ids))) stop("The count matrix holds a duplicated gene identifier; the model needs one row per gene symbol.")

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
for (column in setdiff(all.vars(DESIGN), "condition")) {
  if (!column %in% colnames(metadata)) stop("The design names ", column, " but the sample table has no such column")
  if (is.character(metadata[[column]])) metadata[[column]] <- factor(metadata[[column]])
}
message("Samples: ", ncol(counts), "; genes: ", nrow(counts), "; design: ", deparse(DESIGN))
message("Condition levels: ", paste(levels(metadata$condition), collapse = ", "), " (reference ", REFERENCE_LEVEL, ")")

# ── The footprint model ───────────────────────────────────────────────────────
message("Loading the PROGENy model from ", MODEL_PATH)
model_object <- load(MODEL_PATH)
if (length(model_object) != 1) stop("The model file must hold one object, but it holds ", length(model_object))
model <- as.data.frame(get(model_object[1]))
needed <- c("gene", "pathway", "weight", "p.value")
if (!all(needed %in% colnames(model))) {
  stop("The model object ", model_object[1], " must hold the columns ", paste(needed, collapse = ", "), " but holds ", paste(colnames(model), collapse = ", "))
}
model$gene <- as.character(model$gene)
model$pathway <- as.character(model$pathway)
model <- model[!is.na(model$gene) & !is.na(model$weight) & !is.na(model$p.value), ]
model <- model[order(model$pathway, model$p.value), ]
network <- do.call(rbind, lapply(split(model, model$pathway), head, TOP_RESPONSIVE_GENES))
network <- data.frame(source = network$pathway, target = network$gene, mor = network$weight, stringsAsFactors = FALSE)
rownames(network) <- NULL
message("Model ", model_object[1], ": ", length(unique(model$pathway)), " pathways, ", nrow(model), " gene-pathway weights; top ", TOP_RESPONSIVE_GENES, " responsive genes per pathway kept: ", nrow(network), " edges")

# ── Filter and normalize ──────────────────────────────────────────────────────
group_sizes <- table(metadata$condition)
min_samples <- as.integer(min(group_sizes))
keep <- rowSums(counts >= MIN_COUNT) >= min_samples
message("Low count filter: keep genes with >= ", MIN_COUNT, " counts in >= ", min_samples, " samples: ", sum(keep), " of ", nrow(counts), " kept")
counts <- counts[keep, , drop = FALSE]

dds <- DESeqDataSetFromMatrix(countData = counts, colData = metadata, design = DESIGN)
vsd <- vst(dds, blind = TRUE)
vst_matrix <- assay(vsd)

# ── The contrast statistic ────────────────────────────────────────────────────
if (!is.na(RESULTS_PATH)) {
  message("Reading the contrast statistic from the results table ", RESULTS_PATH)
  results_table <- read.csv(RESULTS_PATH, check.names = FALSE, stringsAsFactors = FALSE)
  if (!all(c("gene", "stat") %in% colnames(results_table))) stop("The results table must hold the columns gene and stat")
  results_table <- results_table[!is.na(results_table$stat) & !duplicated(results_table$gene), ]
  statistic <- setNames(as.numeric(results_table$stat), as.character(results_table$gene))
  statistic_source <- paste0("results table ", basename(RESULTS_PATH), ", column stat")
} else {
  message("Fitting DESeq2 for the contrast ", TEST_LEVEL, " vs ", REFERENCE_LEVEL)
  dds <- DESeq(dds, quiet = TRUE)
  coefficient <- paste0("condition_", make.names(TEST_LEVEL), "_vs_", make.names(REFERENCE_LEVEL))
  if (!coefficient %in% resultsNames(dds)) {
    stop("The coefficient ", coefficient, " is not in resultsNames: ", paste(resultsNames(dds), collapse = ", "))
  }
  res <- results(dds, name = coefficient)
  statistic <- setNames(res$stat, rownames(res))
  statistic <- statistic[!is.na(statistic)]
  statistic_source <- paste0("DESeq2 Wald statistic of ", coefficient)
}
message("Contrast statistic: ", length(statistic), " genes from ", statistic_source)

# ── Coverage of the model ─────────────────────────────────────────────────────
covered <- network[network$target %in% names(statistic), ]
n_targets <- table(factor(covered$source, levels = unique(network$source)))
model_genes <- unique(network$target)
coverage <- length(intersect(model_genes, names(statistic))) / length(model_genes)
message("Model coverage: ", length(intersect(model_genes, names(statistic))), " of ", length(model_genes), " responsive genes are among the tested genes (", round(100 * coverage), "%)")
if (coverage < 0.1) stop("Fewer than 10% of the responsive genes are in the data. Make sure that the gene column holds symbols of the same organism as the model.")
if (all(n_targets < MIN_SIZE)) stop("No pathway has at least ", MIN_SIZE, " responsive genes among the tested genes")

# ── Activity on the contrast ──────────────────────────────────────────────────
contrast_name <- paste0(make.names(TEST_LEVEL), "_vs_", make.names(REFERENCE_LEVEL))
contrast_matrix <- matrix(statistic, ncol = 1, dimnames = list(names(statistic), contrast_name))
message("Running decoupleR ", ACTIVITY_METHOD, " on the contrast statistic")
contrast_activity <- as.data.frame(run_activity(mat = contrast_matrix, network = network, minsize = MIN_SIZE))
activity <- data.frame(
  pathway = contrast_activity$source,
  score = contrast_activity$score,
  pvalue = contrast_activity$p_value,
  stringsAsFactors = FALSE
)
activity$padj <- p.adjust(activity$pvalue, method = "BH")
activity$n_targets <- as.integer(n_targets[activity$pathway])
activity <- activity[order(activity$pvalue), ]
write.csv(activity, out("activity.csv"), row.names = FALSE)

n_significant <- sum(!is.na(activity$padj) & activity$padj < ALPHA)
n_up <- sum(!is.na(activity$padj) & activity$padj < ALPHA & activity$score > 0)
n_down <- n_significant - n_up
message("Pathways scored: ", nrow(activity), "; ", n_significant, " at padj < ", ALPHA, " (", n_up, " up, ", n_down, " down)")

# ── Activity per sample ───────────────────────────────────────────────────────
message("Running decoupleR ", ACTIVITY_METHOD, " on the variance stabilized matrix, one score per pathway and sample")
sample_activity <- as.data.frame(run_activity(mat = vst_matrix, network = network, minsize = MIN_SIZE))
score_matrix <- with(sample_activity, tapply(score, list(source, condition), function(x) x[1]))
score_matrix <- score_matrix[, colnames(vst_matrix), drop = FALSE]
write.csv(data.frame(pathway = rownames(score_matrix), score_matrix, check.names = FALSE), out("scores.csv"), row.names = FALSE)

# ── Figures ───────────────────────────────────────────────────────────────────
bar_df <- activity
bar_df$significant <- !is.na(bar_df$padj) & bar_df$padj < ALPHA
bar_df$pathway <- factor(bar_df$pathway, levels = bar_df$pathway[order(bar_df$score)])
bar_plot <- ggplot(bar_df, aes(x = pathway, y = score, fill = significant)) +
  geom_col() +
  coord_flip() +
  scale_fill_manual(values = c(`FALSE` = "grey60", `TRUE` = "#21908C"), name = paste0("padj < ", ALPHA)) +
  geom_hline(yintercept = 0) +
  xlab(NULL) + ylab(paste0("PROGENy activity score (", ACTIVITY_METHOD, " t-value)")) +
  ggtitle(paste0("Pathway footprint activity: ", TEST_LEVEL, " vs ", REFERENCE_LEVEL)) +
  theme_classic()
save_figure(bar_plot, "activity_bar")

heat_matrix <- score_matrix[order(activity$pvalue[match(rownames(score_matrix), activity$pathway)]), , drop = FALSE]
heat_matrix <- heat_matrix[apply(heat_matrix, 1, function(row) sd(row, na.rm = TRUE) > 0), , drop = FALSE]
annotation <- data.frame(condition = metadata$condition, row.names = colnames(vst_matrix))
heat_title <- paste0("PROGENy ", ACTIVITY_METHOD, " score per sample, scaled by pathway")
png(fig("score_heatmap.png"), width = 7, height = 5, units = "in", res = 300)
pheatmap(heat_matrix, scale = "row", annotation_col = annotation, cluster_rows = FALSE, main = heat_title)
dev.off()
pdf(fig("score_heatmap.pdf"), width = 7, height = 5)
pheatmap(heat_matrix, scale = "row", annotation_col = annotation, cluster_rows = FALSE, main = heat_title)
dev.off()

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-progeny-pathway-activity@1.0.0",
  method = paste0("decoupleR ", ACTIVITY_METHOD, " on the PROGENy footprint model"),
  activity_method = ACTIVITY_METHOD,
  footprint_model = list(path = basename(MODEL_PATH), object = model_object[1], n_pathways = length(unique(model$pathway))),
  top_responsive_genes = TOP_RESPONSIVE_GENES,
  min_size = MIN_SIZE,
  interpretation = "footprint_not_membership",
  interpretation_note = paste0(
    "Each score is the transcriptional footprint of the pathway: the fit of the contrast statistic (or of the sample expression) ",
    "to the weights of the top ", TOP_RESPONSIVE_GENES, " genes that respond to a perturbation of the pathway. ",
    "It is not the expression of the pathway members. A member can change without a change in the activity, and the reverse."
  ),
  contrast = list(factor = "condition", test = TEST_LEVEL, reference = REFERENCE_LEVEL),
  statistic_source = statistic_source,
  design = deparse(DESIGN),
  n_samples = ncol(counts),
  group_sizes = as.list(group_sizes),
  n_genes_input = length(gene_ids),
  n_genes_after_filter = nrow(counts),
  n_genes_with_statistic = length(statistic),
  model_coverage = round(coverage, 4),
  n_pathways_tested = nrow(activity),
  n_significant = n_significant,
  n_up = n_up,
  n_down = n_down,
  alpha = ALPHA,
  min_count = MIN_COUNT,
  versions = list(
    R = R.version.string,
    decoupleR = as.character(packageVersion("decoupleR")),
    DESeq2 = as.character(packageVersion("DESeq2"))
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("activity.csv"))
