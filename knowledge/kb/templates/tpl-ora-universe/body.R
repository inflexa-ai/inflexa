#!/usr/bin/env Rscript
# tpl-ora-universe — Over-representation analysis with an explicit universe.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: hypergeometric over-representation of a discrete gene list against
# gene sets with clusterProfiler::enricher. The universe is the set of genes
# that the differential expression test tested (every row with a non-missing
# adjusted p-value), never the whole genome. Benjamini-Hochberg adjustment over
# the tested sets, and every set is reported (Reimand et al. 2019; Wijesooriya
# et al. 2022; Timmons et al. 2015).

suppressPackageStartupMessages({
  library(clusterProfiler)
  library(ggplot2)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
RESULTS_PATH    <- {{results_path}}  # [adaptable: results_path]
GMT_PATH        <- {{gmt_path}}  # [adaptable: gmt_path]
PADJ_CUTOFF     <- {{padj_cutoff}}  # [adaptable: padj_cutoff]
LFC_CUTOFF      <- {{lfc_cutoff}}  # [adaptable: lfc_cutoff]
DIRECTION       <- {{direction}}  # [adaptable: direction]
MIN_SIZE        <- {{min_size}}  # [adaptable: min_size]
MAX_SIZE        <- {{max_size}}  # [adaptable: max_size]
OUTPUT_PREFIX   <- {{output_prefix}}  # [adaptable: output_prefix]
P_ADJUST_METHOD <- "BH"
SET_PADJ_CUTOFF <- 0.05
N_TOP_SETS      <- 20

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))

save_figure <- function(plot, name, width = 8, height = 6) {
  ggsave(fig(paste0(name, ".png")), plot, width = width, height = height, dpi = 300)
  ggsave(fig(paste0(name, ".pdf")), plot, width = width, height = height)
}

# ── Inputs ────────────────────────────────────────────────────────────────────
if (!DIRECTION %in% c("both", "up", "down")) stop("The direction must be one of both, up, down, not ", DIRECTION)
if (MIN_SIZE > MAX_SIZE) stop("min_size (", MIN_SIZE, ") is larger than max_size (", MAX_SIZE, ")")
if (!file.exists(RESULTS_PATH)) stop("The results table does not exist: ", RESULTS_PATH)
if (!file.exists(GMT_PATH)) stop("The GMT file does not exist: ", GMT_PATH)

message("Reading the differential expression results from ", RESULTS_PATH)
results <- read.csv(RESULTS_PATH, check.names = FALSE, stringsAsFactors = FALSE)
required_columns <- c("gene", "log2_fold_change", "adjusted_pvalue")
absent <- setdiff(required_columns, colnames(results))
if (length(absent) > 0) stop("The results table has no column ", paste(absent, collapse = ", "))
results$gene <- as.character(results$gene)
results$log2_fold_change <- suppressWarnings(as.numeric(results$log2_fold_change))
results$adjusted_pvalue <- suppressWarnings(as.numeric(results$adjusted_pvalue))
if (any(is.na(results$gene) | results$gene == "")) stop("The results table has an empty gene identifier")
if (nrow(results) == 0) stop("The results table has no rows")

# The universe: every tested gene, that is every row with an adjusted p-value.
tested <- results[!is.na(results$adjusted_pvalue), , drop = FALSE]
universe <- unique(tested$gene)
if (length(universe) == 0) stop("No gene has an adjusted p-value, thus the universe is empty")
message("Universe: ", length(universe), " tested genes of ", length(unique(results$gene)), " rows in the table")

# The gene list: under the adjusted p-value cutoff, over the fold change cutoff, in the direction.
selected <- tested$adjusted_pvalue < PADJ_CUTOFF & !is.na(tested$log2_fold_change) & abs(tested$log2_fold_change) >= LFC_CUTOFF
if (DIRECTION == "up") selected <- selected & tested$log2_fold_change > 0
if (DIRECTION == "down") selected <- selected & tested$log2_fold_change < 0
gene_list <- unique(tested$gene[selected])
message("Gene list: ", length(gene_list), " genes at padj < ", PADJ_CUTOFF, ", |log2 fold change| >= ", LFC_CUTOFF, ", direction ", DIRECTION)

message("Reading the gene sets from ", GMT_PATH)
term2gene <- read.gmt(GMT_PATH)
if (nrow(term2gene) == 0) stop("The GMT file holds no gene set")
term2gene$term <- as.character(term2gene$term)
term2gene$gene <- as.character(term2gene$gene)
n_sets_in_gmt <- length(unique(term2gene$term))
annotated_universe <- intersect(universe, unique(term2gene$gene))
annotated_list <- intersect(gene_list, unique(term2gene$gene))
message("Gene sets: ", n_sets_in_gmt, "; universe genes in a set: ", length(annotated_universe), "; gene list genes in a set: ", length(annotated_list))
if (length(annotated_universe) == 0) {
  stop("No universe gene is in a gene set. Make sure that the results table and the GMT use the same identifier space.")
}
if (length(annotated_universe) < 0.1 * length(universe)) {
  message("Warning: fewer than 10% of the universe is in a gene set; the identifier spaces can differ")
}

# ── Test ──────────────────────────────────────────────────────────────────────
empty_results <- data.frame(
  pathway = character(0), gene_ratio = character(0), bg_ratio = character(0),
  fold_enrichment = numeric(0), pvalue = numeric(0), padj = numeric(0),
  count = integer(0), genes = character(0), stringsAsFactors = FALSE
)

ratio_value <- function(ratio) {
  parts <- strsplit(as.character(ratio), "/", fixed = TRUE)
  vapply(parts, function(part) as.numeric(part[1]) / as.numeric(part[2]), numeric(1))
}

if (length(annotated_list) == 0) {
  message("The gene list has no gene in a gene set; no set is tested")
  results_table <- empty_results
} else {
  enrichment <- enricher(
    gene = gene_list,
    universe = universe,
    TERM2GENE = term2gene,
    minGSSize = MIN_SIZE,
    maxGSSize = MAX_SIZE,
    pAdjustMethod = P_ADJUST_METHOD,
    pvalueCutoff = 1,
    qvalueCutoff = 1
  )
  if (is.null(enrichment)) {
    message("No gene set passes the size filter [", MIN_SIZE, ", ", MAX_SIZE, "] on the universe; no set is tested")
    results_table <- empty_results
  } else {
    enrichment_df <- as.data.frame(enrichment)
    results_table <- data.frame(
      pathway = as.character(enrichment_df$ID),
      gene_ratio = as.character(enrichment_df$GeneRatio),
      bg_ratio = as.character(enrichment_df$BgRatio),
      fold_enrichment = ratio_value(enrichment_df$GeneRatio) / ratio_value(enrichment_df$BgRatio),
      pvalue = enrichment_df$pvalue,
      padj = enrichment_df$p.adjust,
      count = as.integer(enrichment_df$Count),
      genes = gsub("/", ";", as.character(enrichment_df$geneID), fixed = TRUE),
      stringsAsFactors = FALSE
    )
    results_table <- results_table[order(results_table$pvalue, results_table$padj), , drop = FALSE]
    rownames(results_table) <- NULL
  }
}

n_sets_tested <- nrow(results_table)
n_significant <- sum(results_table$padj < SET_PADJ_CUTOFF)
message("Tested ", n_sets_tested, " gene sets; ", n_significant, " at padj < ", SET_PADJ_CUTOFF)
write.csv(results_table, out("results.csv"), row.names = FALSE)

# ── Figures ───────────────────────────────────────────────────────────────────
top_sets <- head(results_table[order(results_table$padj, results_table$pvalue), , drop = FALSE], N_TOP_SETS)
plot_title <- paste0("ORA, ", DIRECTION, " genes, padj < ", PADJ_CUTOFF, ": top ", nrow(top_sets), " sets by padj")
figure_height <- max(4, 0.3 * nrow(top_sets) + 1.5)

if (nrow(top_sets) == 0) {
  blank <- ggplot() + annotate("text", x = 0, y = 0, label = "No gene set was tested") + theme_void() + ggtitle(plot_title)
  save_figure(blank, "dotplot", height = 4)
  save_figure(blank, "barplot", height = 4)
} else {
  top_sets$pathway <- factor(top_sets$pathway, levels = rev(top_sets$pathway))
  top_sets$neg_log10_padj <- -log10(pmax(top_sets$padj, .Machine$double.xmin))

  dot_plot <- ggplot(top_sets, aes(x = fold_enrichment, y = pathway, size = count, color = padj)) +
    geom_point() +
    scale_color_viridis_c(direction = -1, name = "padj") +
    scale_size_continuous(name = "Count") +
    xlab("Fold enrichment") + ylab(NULL) +
    ggtitle(plot_title) +
    theme_classic()
  save_figure(dot_plot, "dotplot", height = figure_height)

  bar_plot <- ggplot(top_sets, aes(x = neg_log10_padj, y = pathway, fill = count)) +
    geom_col() +
    geom_vline(xintercept = -log10(SET_PADJ_CUTOFF), linetype = "dashed") +
    scale_fill_viridis_c(name = "Count") +
    xlab("-log10 adjusted p-value") + ylab(NULL) +
    ggtitle(plot_title) +
    theme_classic()
  save_figure(bar_plot, "barplot", height = figure_height)
}

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-ora-universe@1.0.0",
  method = "clusterProfiler enricher, hypergeometric over-representation",
  inputs = list(results_path = RESULTS_PATH, gmt_path = GMT_PATH),
  universe = "tested_genes",
  direction = DIRECTION,
  n_input_genes = length(gene_list),
  n_input_genes_annotated = length(annotated_list),
  n_universe = length(universe),
  n_universe_annotated = length(annotated_universe),
  n_sets_in_gmt = n_sets_in_gmt,
  n_sets_tested = n_sets_tested,
  n_significant = n_significant,
  padj_cutoff = PADJ_CUTOFF,
  lfc_cutoff = LFC_CUTOFF,
  min_size = MIN_SIZE,
  max_size = MAX_SIZE,
  p_adjust_method = P_ADJUST_METHOD,
  set_padj_cutoff = SET_PADJ_CUTOFF,
  versions = list(
    R = R.version.string,
    clusterProfiler = as.character(packageVersion("clusterProfiler")),
    ggplot2 = as.character(packageVersion("ggplot2"))
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("results.csv"))
