#!/usr/bin/env Rscript
# tpl-variance-partition — the share of the variance of each gene explained by
# each factor of the design (variancePartition).
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: edgeR filterByExpr and TMM library size scaling, log2 CPM with the
# voom precision weights from the mixed model (voomWithDreamWeights), then one
# linear mixed model per gene with each categorical variable as a random
# effect and each numeric variable as a fixed effect. The variance of each
# gene divides into the share of each term and a residual share (Hoffman and
# Schadt 2016; Hoffman and Roussos 2021; Law et al. 2014). Every model fits in
# a serial loop (BiocParallel SerialParam), one gene at a time. The result is
# a diagnostic of the design: it has no p-value.

suppressPackageStartupMessages({
  library(edgeR)
  library(limma)
  library(variancePartition)
  library(BiocParallel)
  library(ggplot2)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
COUNTS_PATH          <- {{counts_path}}  # [adaptable: counts_path]
METADATA_PATH        <- {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN     <- {{sample_id_column}}  # [adaptable: sample_id_column]
FORMULA_TEXT         <- {{formula}}  # [adaptable: formula]
USE_VOOM_WEIGHTS     <- {{use_voom_weights}}  # [adaptable: use_voom_weights]
MIN_COUNT            <- {{min_count}}  # [adaptable: min_count]
MIN_TOTAL_COUNT      <- {{min_total_count}}  # [adaptable: min_total_count]
NORMALIZATION_METHOD <- {{normalization_method}}  # [adaptable: normalization_method]
REML                 <- {{reml}}  # [adaptable: reml]
N_TOP_GENES_BARS     <- {{n_top_genes_bars}}  # [adaptable: n_top_genes_bars]
OUTPUT_PREFIX        <- {{output_prefix}}  # [adaptable: output_prefix]

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
RESULTS_PATH <- file.path("output", paste0(OUTPUT_PREFIX, ".csv"))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))

save_figure <- function(plot, name, width = 6, height = 5) {
  ggsave(fig(paste0(name, ".png")), plot, width = width, height = height, dpi = 300)
  ggsave(fig(paste0(name, ".pdf")), plot, width = width, height = height)
}

# ── Inputs ────────────────────────────────────────────────────────────────────
message("Reading counts from ", COUNTS_PATH)
counts_df <- read.csv(COUNTS_PATH, check.names = FALSE, stringsAsFactors = FALSE)
gene_ids <- as.character(counts_df[[1]])
counts <- as.matrix(counts_df[, -1, drop = FALSE])
storage.mode(counts) <- "numeric"
rownames(counts) <- gene_ids
if (any(is.na(counts))) stop("The count matrix holds a missing value. The mixed model does not permit NA.")
if (any(counts < 0) || any(abs(counts - round(counts)) > 1e-6)) {
  stop("The count matrix must hold non-negative integers. The log-CPM and the voom weights take raw counts, not TPM or FPKM.")
}
counts <- round(counts)

message("Reading the sample table from ", METADATA_PATH)
metadata <- read.csv(METADATA_PATH, check.names = FALSE, stringsAsFactors = FALSE)
if (!SAMPLE_ID_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", SAMPLE_ID_COLUMN)
rownames(metadata) <- as.character(metadata[[SAMPLE_ID_COLUMN]])
missing <- setdiff(colnames(counts), rownames(metadata))
if (length(missing) > 0) stop("Samples in the counts but not in the sample table: ", paste(missing, collapse = ", "))
metadata <- metadata[colnames(counts), , drop = FALSE]

# ── The formula ───────────────────────────────────────────────────────────────
# A term `(1 | column)` is a random effect, and the column must be categorical.
# A bare term `column` is a fixed effect, and the column must be numeric.
FORMULA <- tryCatch(as.formula(FORMULA_TEXT), error = function(error) stop("The formula text does not parse: ", FORMULA_TEXT, " (", conditionMessage(error), ")"))
if (!inherits(FORMULA, "formula")) stop("The formula must be an R formula, for example ~ (1 | condition) + age")
if (length(FORMULA) != 2) stop("The formula must have no response. Write ~ (1 | condition) + age, not y ~ ...")
term_labels <- labels(terms(FORMULA))
if (length(term_labels) == 0) stop("The formula names no term. Give at least one column of the sample table.")
if (any(grepl(":", term_labels, fixed = TRUE) | grepl("*", term_labels, fixed = TRUE))) {
  stop("The formula holds an interaction. Give each column as one term: (1 | column) or column.")
}
is_random <- grepl("|", term_labels, fixed = TRUE)
random_terms <- trimws(sub("^.*\\|", "", term_labels[is_random]))
if (any(!grepl("^\\s*1\\s*\\|", term_labels[is_random]))) {
  stop("A random term must be a random intercept, (1 | column). The formula holds: ", paste(term_labels[is_random], collapse = ", "))
}
fixed_terms <- trimws(term_labels[!is_random])
variables <- c(random_terms, fixed_terms)
if (any(duplicated(variables))) stop("The formula names a column two times: ", paste(variables[duplicated(variables)], collapse = ", "))
for (column in variables) {
  if (!column %in% colnames(metadata)) stop("The formula names ", column, " but the sample table has no such column")
  if (column == SAMPLE_ID_COLUMN) stop("The formula names the sample identifier column ", column, ". Each sample is its own level, thus the term is the residual.")
  if (any(is.na(metadata[[column]]))) stop("The column ", column, " has a missing value. The mixed model does not permit NA.")
}
for (column in random_terms) {
  if (is.numeric(metadata[[column]])) message("The random term ", column, " is numeric; the script treats each distinct value as a level")
  metadata[[column]] <- factor(metadata[[column]])
  n_levels <- nlevels(metadata[[column]])
  if (n_levels < 2) stop("The random term ", column, " has one level only. Remove it from the formula.")
  if (n_levels >= nrow(metadata)) stop("The random term ", column, " has one level per sample. Its share is the residual share. Remove it from the formula.")
}
for (column in fixed_terms) {
  if (!is.numeric(metadata[[column]])) {
    message("The fixed term ", column, " is categorical; a categorical column is better as a random effect, (1 | ", column, ")")
    metadata[[column]] <- factor(metadata[[column]])
    if (nlevels(metadata[[column]]) < 2) stop("The fixed term ", column, " has one level only. Remove it from the formula.")
  } else if (length(unique(metadata[[column]])) < 2) {
    stop("The fixed term ", column, " is constant. Remove it from the formula.")
  }
}
message("Samples: ", ncol(counts), "; genes: ", nrow(counts), "; formula: ", deparse(FORMULA))
message("Random terms: ", if (length(random_terms) > 0) paste(sprintf("%s (%d levels)", random_terms, vapply(random_terms, function(column) nlevels(metadata[[column]]), integer(1))), collapse = ", ") else "none")
message("Fixed terms: ", if (length(fixed_terms) > 0) paste(fixed_terms, collapse = ", ") else "none")

# ── Filter and normalize ──────────────────────────────────────────────────────
grouping <- if (length(random_terms) > 0) metadata[[random_terms[1]]] else NULL
dge <- DGEList(counts = counts)
keep <- filterByExpr(dge, group = grouping, min.count = MIN_COUNT, min.total.count = MIN_TOTAL_COUNT)
message("filterByExpr with min.count ", MIN_COUNT, " and min.total.count ", MIN_TOTAL_COUNT, ": ", sum(keep), " of ", nrow(dge), " genes kept")
dge <- dge[keep, , keep.lib.sizes = FALSE]
dge <- normLibSizes(dge, method = NORMALIZATION_METHOD)
message("Library size scaling (", NORMALIZATION_METHOD, "): ", paste(sprintf("%s=%.3f", colnames(dge), dge$samples$norm.factors), collapse = ", "))

# ── The expression the model fits ─────────────────────────────────────────────
BPPARAM <- SerialParam()
if (USE_VOOM_WEIGHTS) {
  # voomWithDreamWeights fits the mixed model to each gene to get the residual
  # standard deviation, thus the precision weights agree with the random effects.
  message("voomWithDreamWeights on ", nrow(dge), " genes, serial")
  expression <- voomWithDreamWeights(dge, FORMULA, metadata, BPPARAM = BPPARAM, plot = FALSE)
  log_cpm <- expression$E
  input_description <- "log2 CPM with voom precision weights from the mixed model (voomWithDreamWeights)"
} else {
  message("log2 CPM of edgeR with equal weights on ", nrow(dge), " genes")
  log_cpm <- cpm(dge, log = TRUE)
  expression <- log_cpm
  input_description <- "log2 CPM of edgeR with equal weights"
}
write.csv(data.frame(gene = rownames(log_cpm), log_cpm, check.names = FALSE), out("logcpm.csv"), row.names = FALSE)

# ── The variance partition ────────────────────────────────────────────────────
message("fitExtractVarPartModel with REML ", REML, " on ", nrow(dge), " genes, serial")
var_part <- fitExtractVarPartModel(expression, FORMULA, metadata, REML = REML, BPPARAM = BPPARAM)
var_part <- sortCols(var_part)
shares <- as.data.frame(var_part)
if (!"Residuals" %in% colnames(shares)) stop("The variance partition has no Residuals column: ", paste(colnames(shares), collapse = ", "))
terms_in_order <- setdiff(colnames(shares), "Residuals")
message("Fitted ", nrow(shares), " genes; terms by median share: ", paste(terms_in_order, collapse = ", "))

# ── Results table ─────────────────────────────────────────────────────────────
results_table <- data.frame(gene = rownames(shares), shares[, c(terms_in_order, "Residuals"), drop = FALSE], check.names = FALSE, stringsAsFactors = FALSE)
write.csv(results_table, RESULTS_PATH, row.names = FALSE)

median_share <- vapply(colnames(shares), function(column) median(shares[[column]]), numeric(1))
mean_share <- vapply(colnames(shares), function(column) mean(shares[[column]]), numeric(1))
dominant <- colnames(shares)[max.col(as.matrix(shares), ties.method = "first")]
n_genes_dominant <- vapply(colnames(shares), function(column) sum(dominant == column), integer(1))
for (column in colnames(shares)) {
  message(sprintf("  %s: median share %.3f, mean share %.3f, dominant in %d genes", column, median_share[[column]], mean_share[[column]], n_genes_dominant[[column]]))
}

# The canonical correlation between the variables: a value near one marks two
# variables that carry the same information, thus their shares are not separable.
canonical <- NULL
if (length(variables) >= 2) {
  canonical <- canCorPairs(FORMULA, metadata)
  write.csv(data.frame(variable = rownames(canonical), canonical, check.names = FALSE), out("canonical_correlation.csv"), row.names = FALSE)
  pairs <- which(upper.tri(canonical), arr.ind = TRUE)
  for (index in seq_len(nrow(pairs))) {
    message(sprintf("  canonical correlation %s ~ %s: %.3f", rownames(canonical)[pairs[index, 1]], colnames(canonical)[pairs[index, 2]], canonical[pairs[index, 1], pairs[index, 2]]))
  }
} else {
  message("One variable only: no canonical correlation")
}

# ── Figures ───────────────────────────────────────────────────────────────────
violin_plot <- plotVarPart(var_part, main = "Share of the variance per term across the genes")
save_figure(violin_plot, "violin", width = 6, height = 5)

explained <- 1 - shares$Residuals
top_genes <- rownames(shares)[order(explained, decreasing = TRUE)][seq_len(min(N_TOP_GENES_BARS, nrow(shares)))]
bars_plot <- plotPercentBars(var_part[top_genes, , drop = FALSE]) +
  ggtitle(paste0("Top ", length(top_genes), " genes by the explained share"))
save_figure(bars_plot, "percent_bars", width = 7, height = 6)

if (!is.null(canonical)) {
  canonical_df <- expand.grid(row = rownames(canonical), column = colnames(canonical), stringsAsFactors = FALSE)
  canonical_df$correlation <- as.vector(canonical)
  canonical_plot <- ggplot(canonical_df, aes(x = column, y = row, fill = correlation)) +
    geom_tile() +
    geom_text(aes(label = sprintf("%.2f", correlation)), size = 3) +
    scale_fill_gradient(low = "white", high = "#440154", limits = c(0, 1), name = "canonical\ncorrelation") +
    xlab(NULL) + ylab(NULL) +
    ggtitle("Canonical correlation between the variables") +
    theme_classic() +
    theme(axis.text.x = element_text(angle = 30, hjust = 1))
} else {
  canonical_plot <- ggplot() +
    annotate("text", x = 0, y = 0, label = paste0("One variable, ", variables[1], ": no canonical correlation")) +
    theme_void()
}
save_figure(canonical_plot, "canonical_correlation", width = 6, height = 5)

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-variance-partition@1.0.0",
  method = "variancePartition linear mixed model per gene",
  formula = deparse(FORMULA),
  random_terms = as.list(random_terms),
  fixed_terms = as.list(fixed_terms),
  n_terms = length(variables),
  n_random_terms = length(random_terms),
  n_fixed_terms = length(fixed_terms),
  input = input_description,
  use_voom_weights = USE_VOOM_WEIGHTS,
  reml = REML,
  parallel = "SerialParam",
  n_samples = ncol(counts),
  levels = lapply(setNames(random_terms, random_terms), function(column) as.list(table(metadata[[column]]))),
  n_genes_input = length(gene_ids),
  n_genes_after_filter = nrow(dge),
  n_genes_fitted = nrow(shares),
  terms_by_median_share = as.list(terms_in_order),
  median_share = as.list(round(median_share, 6)),
  mean_share = as.list(round(mean_share, 6)),
  n_genes_dominant = as.list(n_genes_dominant),
  canonical_correlation = if (is.null(canonical)) NULL else lapply(setNames(seq_len(nrow(canonical)), rownames(canonical)), function(row) as.list(round(canonical[row, ], 6))),
  min_count = MIN_COUNT,
  min_total_count = MIN_TOTAL_COUNT,
  normalization_method = NORMALIZATION_METHOD,
  library_sizes = as.list(setNames(dge$samples$lib.size, colnames(dge))),
  norm_factors = as.list(setNames(round(dge$samples$norm.factors, 4), colnames(dge))),
  versions = list(
    R = R.version.string,
    variancePartition = as.character(packageVersion("variancePartition")),
    limma = as.character(packageVersion("limma")),
    edgeR = as.character(packageVersion("edgeR")),
    BiocParallel = as.character(packageVersion("BiocParallel")),
    lme4 = if (requireNamespace("lme4", quietly = TRUE)) as.character(packageVersion("lme4")) else NA
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA, null = "null")
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", RESULTS_PATH)
