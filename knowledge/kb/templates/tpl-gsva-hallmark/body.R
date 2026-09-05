#!/usr/bin/env Rscript
# tpl-gsva-hallmark — GSVA per-sample pathway scores with limma on the scores.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: edgeR filterByExpr and library size scaling, log-CPM, GSVA scores per
# gene set and per sample from the gene ranks within each sample with the
# Gaussian kernel (Hanzelmann et al. 2013), then a limma linear model with the
# design on the score matrix, moderated t-test on the condition coefficient,
# and Benjamini-Hochberg adjustment (Ritchie et al. 2015).

suppressPackageStartupMessages({
  library(GSVA)
  library(edgeR)
  library(limma)
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
GMT_PATH             <- {{gmt_path}}  # [adaptable: gmt_path]
MIN_COUNT            <- {{min_count}}  # [adaptable: min_count]
MIN_TOTAL_COUNT      <- {{min_total_count}}  # [adaptable: min_total_count]
NORMALIZATION_METHOD <- {{normalization_method}}  # [adaptable: normalization_method]
KCDF                 <- {{kcdf}}
MIN_SIZE             <- {{min_size}}  # [adaptable: min_size]
MAX_SIZE             <- {{max_size}}  # [adaptable: max_size]
N_TOP_SETS           <- {{n_top_sets}}  # [adaptable: n_top_sets]
OUTPUT_PREFIX        <- {{output_prefix}}  # [adaptable: output_prefix]
PADJ_CUTOFF          <- 0.05

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))

save_figure <- function(plot, name, width = 6, height = 5) {
  ggsave(fig(paste0(name, ".png")), plot, width = width, height = height, dpi = 300)
  ggsave(fig(paste0(name, ".pdf")), plot, width = width, height = height)
}

if (MIN_SIZE > MAX_SIZE) stop("min_size (", MIN_SIZE, ") is larger than max_size (", MAX_SIZE, ")")

# ── Inputs ────────────────────────────────────────────────────────────────────
message("Reading counts from ", COUNTS_PATH)
if (!file.exists(COUNTS_PATH)) stop("The count matrix does not exist: ", COUNTS_PATH)
counts_df <- read.csv(COUNTS_PATH, check.names = FALSE, stringsAsFactors = FALSE)
gene_ids <- as.character(counts_df[[1]])
counts <- as.matrix(counts_df[, -1, drop = FALSE])
storage.mode(counts) <- "numeric"
rownames(counts) <- gene_ids
if (any(counts < 0, na.rm = TRUE) || any(abs(counts - round(counts)) > 1e-6, na.rm = TRUE)) {
  stop("The count matrix must hold non-negative integers. The log-CPM starts from raw counts, not TPM or FPKM.")
}
counts <- round(counts)
if (any(duplicated(gene_ids))) stop("The count matrix holds duplicate gene identifiers")

message("Reading the sample table from ", METADATA_PATH)
if (!file.exists(METADATA_PATH)) stop("The sample table does not exist: ", METADATA_PATH)
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
group_sizes <- table(metadata$condition)
if (min(group_sizes[c(REFERENCE_LEVEL, TEST_LEVEL)]) < 2) {
  stop("limma on the scores needs at least two samples in each of ", REFERENCE_LEVEL, " and ", TEST_LEVEL)
}
message("Samples: ", ncol(counts), "; genes: ", nrow(counts), "; design: ", deparse(DESIGN))
message("Condition levels: ", paste(levels(metadata$condition), collapse = ", "), " (reference ", REFERENCE_LEVEL, ")")

message("Reading the gene sets from ", GMT_PATH)
if (!file.exists(GMT_PATH)) stop("The gene set file does not exist: ", GMT_PATH)
gmt_lines <- readLines(GMT_PATH, warn = FALSE)
gmt_lines <- gmt_lines[nzchar(trimws(gmt_lines))]
gene_sets <- lapply(strsplit(gmt_lines, "\t", fixed = TRUE), function(fields) unique(fields[-(1:2)][nzchar(fields[-(1:2)])]))
names(gene_sets) <- vapply(strsplit(gmt_lines, "\t", fixed = TRUE), function(fields) fields[1], character(1))
if (length(gene_sets) == 0) stop("The gene set file holds no gene set: ", GMT_PATH)
if (any(duplicated(names(gene_sets)))) stop("The gene set file holds a duplicate set name")
DATABASE <- basename(GMT_PATH)
message("Gene sets: ", length(gene_sets), " in ", DATABASE)

# ── Filter and log-CPM ────────────────────────────────────────────────────────
design <- model.matrix(DESIGN, data = metadata)
dge <- DGEList(counts = counts, samples = metadata)
keep <- filterByExpr(dge, design = design, min.count = MIN_COUNT, min.total.count = MIN_TOTAL_COUNT)
message("filterByExpr with min.count ", MIN_COUNT, " and min.total.count ", MIN_TOTAL_COUNT, ": ", sum(keep), " of ", nrow(dge), " genes kept")
dge <- dge[keep, , keep.lib.sizes = FALSE]
dge <- calcNormFactors(dge, method = NORMALIZATION_METHOD)
message("Scaling factors (", NORMALIZATION_METHOD, "): ", paste(sprintf("%s=%.2f", colnames(dge), dge$samples$norm.factors), collapse = ", "))
log_cpm <- cpm(dge, log = TRUE)

set_genes <- unique(unlist(gene_sets, use.names = FALSE))
n_in_sets <- sum(rownames(log_cpm) %in% set_genes)
if (n_in_sets == 0) {
  stop("No filtered gene is a member of a gene set. The gene identifiers of the count matrix and of the GMT file do not match.")
}
message("Filtered genes: ", nrow(log_cpm), "; in at least one gene set: ", n_in_sets)

# ── GSVA scores ───────────────────────────────────────────────────────────────
message("GSVA with the ", KCDF, " kernel on log-CPM, sets with ", MIN_SIZE, " to ", MAX_SIZE, " members")
gsva_param <- gsvaParam(exprData = log_cpm, geneSets = gene_sets, minSize = MIN_SIZE, maxSize = MAX_SIZE, kcdf = KCDF)
scores <- gsva(gsva_param, verbose = FALSE)
scores <- as.matrix(scores)
if (nrow(scores) == 0) stop("No gene set has between ", MIN_SIZE, " and ", MAX_SIZE, " members among the filtered genes")
set_sizes <- vapply(gene_sets[rownames(scores)], function(genes) sum(genes %in% rownames(log_cpm)), integer(1))
message("Scored ", nrow(scores), " of ", length(gene_sets), " sets in ", ncol(scores), " samples")
write.csv(data.frame(pathway = rownames(scores), scores, check.names = FALSE), out("scores.csv"), row.names = FALSE)

# ── limma on the scores ───────────────────────────────────────────────────────
coefficient <- paste0("condition", TEST_LEVEL)
if (!coefficient %in% colnames(design)) {
  stop("The coefficient ", coefficient, " is not in the design columns: ", paste(colnames(design), collapse = ", "))
}
fit <- lmFit(scores, design)
fit <- eBayes(fit)
top <- topTable(fit, coef = coefficient, number = Inf, sort.by = "none")
results_table <- data.frame(
  pathway = rownames(top),
  log_fold_change_score = top$logFC,
  t = top$t,
  pvalue = top$P.Value,
  padj = top$adj.P.Val,
  size = unname(set_sizes[rownames(top)]),
  stringsAsFactors = FALSE
)
results_table <- results_table[order(results_table$padj, results_table$pvalue), ]
write.csv(results_table, out("results.csv"), row.names = FALSE)

n_tested <- nrow(results_table)
n_significant <- sum(!is.na(results_table$padj) & results_table$padj < PADJ_CUTOFF)
n_up <- sum(!is.na(results_table$padj) & results_table$padj < PADJ_CUTOFF & results_table$log_fold_change_score > 0)
n_down <- n_significant - n_up
message("Tested ", n_tested, " sets with limma on the scores; ", n_significant, " at padj < ", PADJ_CUTOFF, " (", n_up, " up, ", n_down, " down in ", TEST_LEVEL, ")")

# ── Figures ───────────────────────────────────────────────────────────────────
top_sets <- head(results_table[!is.na(results_table$padj), ], N_TOP_SETS)
heatmap_matrix <- scores[top_sets$pathway, , drop = FALSE]
annotation <- data.frame(condition = metadata$condition, row.names = colnames(scores))
heatmap_height <- max(4, 0.18 * nrow(heatmap_matrix) + 2)
heatmap_width <- max(6, 0.3 * ncol(heatmap_matrix) + 4)
heatmap_title <- paste0("GSVA scores of the top ", nrow(heatmap_matrix), " sets by adjusted p-value")
png(fig("score_heatmap.png"), width = heatmap_width, height = heatmap_height, units = "in", res = 300)
pheatmap(heatmap_matrix, annotation_col = annotation, cluster_rows = FALSE, fontsize_row = 6, fontsize_col = 7, main = heatmap_title)
dev.off()
pdf(fig("score_heatmap.pdf"), width = heatmap_width, height = heatmap_height)
pheatmap(heatmap_matrix, annotation_col = annotation, cluster_rows = FALSE, fontsize_row = 6, fontsize_col = 7, main = heatmap_title)
dev.off()

top_sets$pathway <- factor(top_sets$pathway, levels = top_sets$pathway[order(top_sets$log_fold_change_score)])
top_sets$significant <- top_sets$padj < PADJ_CUTOFF
difference_plot <- ggplot(top_sets, aes(x = log_fold_change_score, y = pathway, fill = significant)) +
  geom_col() +
  scale_fill_manual(values = c(`FALSE` = "grey60", `TRUE` = "#21908C"), name = paste0("padj < ", PADJ_CUTOFF)) +
  geom_vline(xintercept = 0, linetype = "dashed", color = "grey40") +
  xlab(paste0("GSVA score difference: ", TEST_LEVEL, " minus ", REFERENCE_LEVEL)) + ylab(NULL) +
  ggtitle(paste0("Top ", nrow(top_sets), " gene sets by adjusted p-value")) +
  theme_classic() +
  theme(axis.text.y = element_text(size = 7))
save_figure(difference_plot, "score_difference", width = 8, height = max(4, 0.25 * nrow(top_sets) + 1.5))

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-gsva-hallmark@1.0.0",
  method = "GSVA scores with limma moderated t-test on the score matrix",
  inputs = list(counts_path = COUNTS_PATH, metadata_path = METADATA_PATH, gmt_path = GMT_PATH),
  database = DATABASE,
  contrast = list(factor = "condition", test = TEST_LEVEL, reference = REFERENCE_LEVEL),
  design = deparse(DESIGN),
  n_samples = ncol(counts),
  group_sizes = as.list(group_sizes),
  n_genes_input = length(gene_ids),
  n_genes_after_filter = nrow(log_cpm),
  n_genes_in_sets = n_in_sets,
  n_sets_input = length(gene_sets),
  n_sets_scored = nrow(scores),
  n_sets_tested = n_tested,
  n_significant = n_significant,
  n_up = n_up,
  n_down = n_down,
  padj_cutoff = PADJ_CUTOFF,
  kcdf = KCDF,
  min_size = MIN_SIZE,
  max_size = MAX_SIZE,
  min_count = MIN_COUNT,
  min_total_count = MIN_TOTAL_COUNT,
  normalization_method = NORMALIZATION_METHOD,
  versions = list(
    R = R.version.string,
    GSVA = as.character(packageVersion("GSVA")),
    edgeR = as.character(packageVersion("edgeR")),
    limma = as.character(packageVersion("limma")),
    ggplot2 = as.character(packageVersion("ggplot2")),
    pheatmap = as.character(packageVersion("pheatmap"))
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("results.csv"))
