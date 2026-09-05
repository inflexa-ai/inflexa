#!/usr/bin/env Rscript
# tpl-camera-hallmark — camera competitive gene set test on a limma-voom fit.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: edgeR filterByExpr and TMM library size scaling factors, voom
# precision weights on log-CPM, a fixed-effects linear model on the condition
# coefficient (Law et al. 2014; Ritchie et al. 2015), then camera on that fit
# with the MSigDB Hallmark collection (Wu and Smyth 2012; Liberzon et al.
# 2015). camera is a competitive test: it asks whether the genes of a set are
# more differentially expressed than the genes outside the set, and it
# inflates the variance of the set statistic by a factor that matches the
# inter-gene correlation. Benjamini-Hochberg adjustment gives the FDR column.

suppressPackageStartupMessages({
  library(edgeR)
  library(limma)
  library(ggplot2)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
COUNTS_PATH             <- {{counts_path}}  # [adaptable: counts_path]
METADATA_PATH           <- {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN        <- {{sample_id_column}}  # [adaptable: sample_id_column]
CONDITION_COLUMN        <- {{condition_column}}  # [adaptable: condition_column]
REFERENCE_LEVEL         <- {{reference_level}}  # [adaptable: reference_level]
TEST_LEVEL              <- {{test_level}}  # [adaptable: test_level]
DESIGN                  <- {{design}}  # [adaptable: design]
GMT_PATH                <- {{gmt_path}}  # [adaptable: gmt_path]
MIN_COUNT               <- {{min_count}}  # [adaptable: min_count]
MIN_TOTAL_COUNT         <- {{min_total_count}}  # [adaptable: min_total_count]
NORMALIZATION_METHOD    <- {{normalization_method}}  # [adaptable: normalization_method]
INTER_GENE_COR          <- {{inter_gene_cor}}  # [adaptable: inter_gene_cor]
ESTIMATE_INTER_GENE_COR <- {{estimate_inter_gene_cor}}  # [adaptable: estimate_inter_gene_cor]
USE_RANKS               <- {{use_ranks}}  # [adaptable: use_ranks]
MIN_SIZE                <- {{min_size}}  # [adaptable: min_size]
MAX_SIZE                <- {{max_size}}  # [adaptable: max_size]
PADJ_CUTOFF             <- {{padj_cutoff}}
N_TOP_SETS              <- {{n_top_sets}}  # [adaptable: n_top_sets]
OUTPUT_PREFIX           <- {{output_prefix}}  # [adaptable: output_prefix]

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))

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

if (MIN_SIZE > MAX_SIZE) stop("min_size (", MIN_SIZE, ") is larger than max_size (", MAX_SIZE, ")")
if (!ESTIMATE_INTER_GENE_COR && (INTER_GENE_COR < 0 || INTER_GENE_COR >= 1)) {
  stop("inter_gene_cor must be at least 0 and under 1, not ", INTER_GENE_COR)
}

# ── Inputs ────────────────────────────────────────────────────────────────────
message("Reading counts from ", COUNTS_PATH)
if (!file.exists(COUNTS_PATH)) stop("The count matrix does not exist: ", COUNTS_PATH)
counts_df <- read.csv(COUNTS_PATH, check.names = FALSE, stringsAsFactors = FALSE)
gene_ids <- as.character(counts_df[[1]])
counts <- as.matrix(counts_df[, -1, drop = FALSE])
storage.mode(counts) <- "numeric"
rownames(counts) <- gene_ids
if (any(counts < 0, na.rm = TRUE) || any(abs(counts - round(counts)) > 1e-6, na.rm = TRUE)) {
  stop("The count matrix must hold non-negative integers. voom takes raw counts, not TPM or FPKM.")
}
counts <- round(counts)
if (any(duplicated(gene_ids))) stop("The count matrix holds a duplicate gene identifier: ", gene_ids[duplicated(gene_ids)][1])

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
message("Samples: ", ncol(counts), "; genes: ", nrow(counts), "; design: ", deparse(DESIGN))
message("Condition levels: ", paste(levels(metadata$condition), collapse = ", "), " (reference ", REFERENCE_LEVEL, ")")

message("Reading the gene sets from ", GMT_PATH)
if (!file.exists(GMT_PATH)) stop("The gene set file does not exist: ", GMT_PATH)
gmt_lines <- readLines(GMT_PATH, warn = FALSE)
gmt_lines <- gmt_lines[nzchar(trimws(gmt_lines))]
gmt_fields <- strsplit(gmt_lines, "\t", fixed = TRUE)
if (any(lengths(gmt_fields) < 3)) stop("A line of the GMT file has fewer than three tab-separated fields: name, description, then the genes")
pathways <- lapply(gmt_fields, function(fields) unique(fields[-(1:2)][nzchar(fields[-(1:2)])]))
names(pathways) <- vapply(gmt_fields, function(fields) fields[1], character(1))
if (length(pathways) == 0) stop("The gene set file holds no gene set: ", GMT_PATH)
if (any(duplicated(names(pathways)))) stop("The GMT file holds a duplicate gene set name: ", names(pathways)[duplicated(names(pathways))][1])
DATABASE <- basename(GMT_PATH)
message("Gene sets: ", length(pathways), " in ", DATABASE)

# ── Model design ──────────────────────────────────────────────────────────────
design <- model.matrix(DESIGN, data = metadata)
coefficient <- paste0("condition", TEST_LEVEL)
if (!coefficient %in% colnames(design)) {
  stop("The coefficient ", coefficient, " is not in the design columns: ", paste(colnames(design), collapse = ", "))
}
if (qr(design)$rank < ncol(design)) stop("The design matrix is not of full rank. Remove a term that is confounded with another term.")
residual_df <- nrow(design) - ncol(design)
if (residual_df < 1) stop("The design leaves no residual degrees of freedom. camera needs at least one.")
contrast_column <- which(colnames(design) == coefficient)

# ── Filter and normalize ──────────────────────────────────────────────────────
dge <- DGEList(counts = counts, group = metadata$condition)
keep <- filterByExpr(dge, design = design, min.count = MIN_COUNT, min.total.count = MIN_TOTAL_COUNT)
message("filterByExpr with min.count ", MIN_COUNT, " and min.total.count ", MIN_TOTAL_COUNT, ": ", sum(keep), " of ", nrow(dge), " genes kept")
dge <- dge[keep, , keep.lib.sizes = FALSE]
dge <- calcNormFactors(dge, method = NORMALIZATION_METHOD)
message("Library size scaling (", NORMALIZATION_METHOD, "): ", paste(sprintf("%s=%.3f", colnames(dge), dge$samples$norm.factors), collapse = ", "))

# ── voom and the linear model ─────────────────────────────────────────────────
v <- voom(dge, design, plot = FALSE)
fit <- lmFit(v, design)
fit <- eBayes(fit)
moderated_t <- fit$t[, contrast_column]
names(moderated_t) <- rownames(fit)
message("Moderated t-statistics on ", coefficient, " for ", length(moderated_t), " genes")

# ── Gene set index ────────────────────────────────────────────────────────────
index <- ids2indices(pathways, rownames(v), remove.empty = FALSE)
set_sizes <- lengths(index)
n_in_sets <- sum(rownames(v) %in% unique(unlist(pathways, use.names = FALSE)))
if (n_in_sets == 0) {
  stop("No fitted gene is a member of a gene set. The gene identifiers of the count matrix and of the GMT file do not match.")
}
message("Fitted genes in at least one gene set: ", n_in_sets, " of ", nrow(v))
in_window <- set_sizes >= MIN_SIZE & set_sizes <= MAX_SIZE
index <- index[in_window]
if (length(index) == 0) stop("No gene set has ", MIN_SIZE, " to ", MAX_SIZE, " members among the fitted genes")
message("Sets with ", MIN_SIZE, " to ", MAX_SIZE, " fitted members: ", length(index), " of ", length(pathways))

# ── camera ────────────────────────────────────────────────────────────────────
# inter.gene.cor: a fixed value applies one variance inflation factor to every
# set. NA makes camera estimate the correlation of each set from the residuals
# of the fit, which is the original procedure of Wu and Smyth (2012) and gives
# a Correlation column. The test is on the design contrast, one coefficient.
inter_gene_cor <- if (ESTIMATE_INTER_GENE_COR) NA else INTER_GENE_COR
message("camera on ", coefficient, ": inter.gene.cor = ", if (is.na(inter_gene_cor)) "NA (estimated per set)" else inter_gene_cor,
        ", use.ranks = ", USE_RANKS)
camera_res <- camera(v, index = index, design = design, contrast = contrast_column,
                     inter.gene.cor = inter_gene_cor, use.ranks = USE_RANKS, sort = FALSE)
camera_res$pathway <- rownames(camera_res)

set_mean_t <- vapply(index, function(members) mean(moderated_t[members]), numeric(1))
set_genes <- vapply(index, function(members) paste(rownames(v)[members], collapse = ";"), character(1))
results_table <- data.frame(
  pathway = camera_res$pathway,
  size = camera_res$NGenes,
  direction = camera_res$Direction,
  pvalue = camera_res$PValue,
  padj = camera_res$FDR,
  mean_moderated_t = set_mean_t[camera_res$pathway],
  inter_gene_cor = if ("Correlation" %in% colnames(camera_res)) camera_res$Correlation else INTER_GENE_COR,
  genes = set_genes[camera_res$pathway],
  stringsAsFactors = FALSE
)
results_table <- results_table[order(results_table$padj, results_table$pvalue), ]
rownames(results_table) <- NULL
write.csv(results_table, out("results.csv"), row.names = FALSE)

n_tested <- nrow(results_table)
n_significant <- sum(!is.na(results_table$padj) & results_table$padj < PADJ_CUTOFF)
n_up <- sum(!is.na(results_table$padj) & results_table$padj < PADJ_CUTOFF & results_table$direction == "Up")
n_down <- n_significant - n_up
message("Tested ", n_tested, " sets; ", n_significant, " at FDR < ", PADJ_CUTOFF, " (", n_up, " up, ", n_down, " down)")

# ── Figures ───────────────────────────────────────────────────────────────────
top_sets <- head(results_table[!is.na(results_table$padj), ], N_TOP_SETS)
top_sets$signed_log10_fdr <- ifelse(top_sets$direction == "Up", 1, -1) * -log10(pmax(top_sets$padj, .Machine$double.xmin))
top_sets$pathway <- factor(top_sets$pathway, levels = top_sets$pathway[order(top_sets$signed_log10_fdr)])
top_sets_plot <- ggplot(top_sets, aes(x = signed_log10_fdr, y = pathway, fill = direction)) +
  geom_col() +
  geom_vline(xintercept = c(-1, 1) * -log10(PADJ_CUTOFF), linetype = "dashed", color = "grey40") +
  scale_fill_manual(values = c(Down = "#3B528B", Up = "#F98E09"), name = "Direction") +
  xlab("Signed -log10 FDR (positive: up in the test level)") + ylab(NULL) +
  ggtitle(paste0("camera: top ", nrow(top_sets), " gene sets, ", TEST_LEVEL, " vs ", REFERENCE_LEVEL)) +
  theme_classic() +
  theme(axis.text.y = element_text(size = 7))
save_figure(top_sets_plot, "top_sets", width = 8, height = max(4, 0.25 * nrow(top_sets) + 1.5))

top_set_name <- as.character(results_table$pathway[1])
draw_barcode <- function() {
  barcodeplot(moderated_t, index = index[[top_set_name]],
              main = paste0(top_set_name, " (FDR ", signif(results_table$padj[1], 3), ")"),
              xlab = paste0("Moderated t, ", TEST_LEVEL, " vs ", REFERENCE_LEVEL))
}
save_base_figure(draw_barcode, "barcode_top_set", width = 7, height = 4.5)

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-camera-hallmark@1.0.0",
  method = "camera competitive gene set test on a limma-voom fit",
  contrast = list(factor = "condition", test = TEST_LEVEL, reference = REFERENCE_LEVEL, coefficient = coefficient),
  design = deparse(DESIGN),
  inputs = list(counts_path = COUNTS_PATH, metadata_path = METADATA_PATH, gmt_path = GMT_PATH),
  database = DATABASE,
  n_samples = ncol(counts),
  group_sizes = as.list(group_sizes),
  residual_df = residual_df,
  n_genes_input = length(gene_ids),
  n_genes_after_filter = nrow(dge),
  n_genes_in_sets = n_in_sets,
  n_sets_input = length(pathways),
  n_sets_tested = n_tested,
  n_significant = n_significant,
  n_up = n_up,
  n_down = n_down,
  top_set = top_set_name,
  padj_cutoff = PADJ_CUTOFF,
  adjust_method = "BH",
  inter_gene_cor = if (ESTIMATE_INTER_GENE_COR) "estimated" else INTER_GENE_COR,
  estimate_inter_gene_cor = ESTIMATE_INTER_GENE_COR,
  use_ranks = USE_RANKS,
  min_size = MIN_SIZE,
  max_size = MAX_SIZE,
  min_count = MIN_COUNT,
  min_total_count = MIN_TOTAL_COUNT,
  normalization_method = NORMALIZATION_METHOD,
  library_sizes = as.list(setNames(dge$samples$lib.size, colnames(dge))),
  norm_factors = as.list(setNames(round(dge$samples$norm.factors, 4), colnames(dge))),
  versions = list(
    R = R.version.string,
    limma = as.character(packageVersion("limma")),
    edgeR = as.character(packageVersion("edgeR")),
    ggplot2 = as.character(packageVersion("ggplot2"))
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("results.csv"))
