#!/usr/bin/env Rscript
# tpl-fgsea-preranked — fgsea preranked gene set enrichment analysis.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: preranked GSEA (Subramanian et al. 2005) on the full ranked list of
# tested genes, computed with the fgsea multilevel algorithm (Korotkevich et
# al. 2021), a gene set size window, Benjamini-Hochberg adjustment, and a
# collapse of the significant sets to the main pathways.

suppressPackageStartupMessages({
  library(fgsea)
  library(ggplot2)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
RESULTS_PATH  <- {{results_path}}  # [adaptable: results_path]
RANK_METRIC   <- {{rank_metric}}  # [adaptable: rank_metric]
GMT_PATH      <- {{gmt_path}}  # [adaptable: gmt_path]
MIN_SIZE      <- {{min_size}}  # [adaptable: min_size]
MAX_SIZE      <- {{max_size}}  # [adaptable: max_size]
EPS           <- {{eps}}
SEED          <- {{seed}}  # [adaptable: seed]
OUTPUT_PREFIX <- {{output_prefix}}  # [adaptable: output_prefix]
PADJ_CUTOFF   <- 0.05
N_TOP_SETS    <- 20

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
message("Reading the results table from ", RESULTS_PATH)
if (!file.exists(RESULTS_PATH)) stop("The results table does not exist: ", RESULTS_PATH)
results <- read.csv(RESULTS_PATH, check.names = FALSE, stringsAsFactors = FALSE)
needed <- switch(RANK_METRIC,
  stat = c("gene", "stat"),
  signed_log10p = c("gene", "log2_fold_change", "pvalue"),
  log2_fold_change = c("gene", "log2_fold_change"),
  stop("Unknown rank metric ", RANK_METRIC)
)
absent <- setdiff(needed, colnames(results))
if (length(absent) > 0) {
  stop("The rank metric ", RANK_METRIC, " needs the columns ", paste(needed, collapse = ", "),
       " but the results table has no column ", paste(absent, collapse = ", "))
}
results$gene <- as.character(results$gene)
message("Results table: ", nrow(results), " genes, columns: ", paste(colnames(results), collapse = ", "))

message("Reading the gene sets from ", GMT_PATH)
if (!file.exists(GMT_PATH)) stop("The gene set file does not exist: ", GMT_PATH)
pathways <- gmtPathways(GMT_PATH)
if (length(pathways) == 0) stop("The gene set file holds no gene set: ", GMT_PATH)
DATABASE <- basename(GMT_PATH)
message("Gene sets: ", length(pathways), " in ", DATABASE)

# ── Ranking ───────────────────────────────────────────────────────────────────
if (RANK_METRIC == "stat") {
  score <- as.numeric(results$stat)
} else if (RANK_METRIC == "signed_log10p") {
  pvalue <- as.numeric(results$pvalue)
  smallest <- suppressWarnings(min(pvalue[!is.na(pvalue) & pvalue > 0]))
  if (!is.finite(smallest)) smallest <- .Machine$double.xmin
  pvalue[!is.na(pvalue) & pvalue == 0] <- smallest
  score <- sign(as.numeric(results$log2_fold_change)) * -log10(pvalue)
} else {
  score <- as.numeric(results$log2_fold_change)
}

keep <- !is.na(results$gene) & nzchar(results$gene) & is.finite(score)
message("Ranking by ", RANK_METRIC, ": ", sum(keep), " of ", nrow(results), " genes have a finite value; ", sum(!keep), " dropped")
ranked <- data.frame(gene = results$gene[keep], score = score[keep], stringsAsFactors = FALSE)
if (nrow(ranked) == 0) stop("No gene has a finite ", RANK_METRIC, " value")

n_duplicate <- sum(duplicated(ranked$gene))
if (n_duplicate > 0) {
  message("Duplicate gene identifiers: ", n_duplicate, "; the entry with the largest absolute score is kept")
  ranked <- ranked[order(-abs(ranked$score)), ]
  ranked <- ranked[!duplicated(ranked$gene), ]
}

set.seed(SEED)
tied <- duplicated(ranked$score) | duplicated(ranked$score, fromLast = TRUE)
if (any(tied)) {
  jitter_scale <- 1e-6 * (max(abs(ranked$score)) + 1)
  ranked$score[tied] <- ranked$score[tied] + runif(sum(tied), -jitter_scale, jitter_scale)
  message("Tied scores: ", sum(tied), " genes; the ties are broken with a jitter of at most ", signif(jitter_scale, 3))
}
ranks <- setNames(ranked$score, ranked$gene)
ranks <- sort(ranks, decreasing = TRUE)

set_genes <- unique(unlist(pathways, use.names = FALSE))
n_in_sets <- sum(names(ranks) %in% set_genes)
if (n_in_sets == 0) {
  stop("No ranked gene is a member of a gene set. The gene identifiers of the results table and of the GMT file do not match.")
}
message("Ranked genes: ", length(ranks), "; in at least one gene set: ", n_in_sets)

# ── Enrichment ────────────────────────────────────────────────────────────────
set.seed(SEED)
fgsea_res <- fgseaMultilevel(pathways = pathways, stats = ranks, minSize = MIN_SIZE, maxSize = MAX_SIZE, eps = EPS, nproc = 1)
fgsea_res <- fgsea_res[order(fgsea_res$padj, fgsea_res$pval), ]
n_tested <- nrow(fgsea_res)
n_significant <- sum(!is.na(fgsea_res$padj) & fgsea_res$padj < PADJ_CUTOFF)
n_up <- sum(!is.na(fgsea_res$padj) & fgsea_res$padj < PADJ_CUTOFF & fgsea_res$NES > 0)
n_down <- n_significant - n_up
message("Tested ", n_tested, " of ", length(pathways), " sets with ", MIN_SIZE, " to ", MAX_SIZE, " ranked members; ",
        n_significant, " at padj < ", PADJ_CUTOFF, " (", n_up, " positive, ", n_down, " negative NES)")

results_table <- data.frame(
  pathway = fgsea_res$pathway,
  pvalue = fgsea_res$pval,
  padj = fgsea_res$padj,
  ES = fgsea_res$ES,
  NES = fgsea_res$NES,
  size = fgsea_res$size,
  leading_edge = vapply(fgsea_res$leadingEdge, function(genes) paste(genes, collapse = ";"), character(1)),
  stringsAsFactors = FALSE
)
write.csv(results_table, out("results.csv"), row.names = FALSE)

# ── Collapse ──────────────────────────────────────────────────────────────────
significant <- fgsea_res[!is.na(fgsea_res$padj) & fgsea_res$padj < PADJ_CUTOFF, ]
if (nrow(significant) > 0) {
  set.seed(SEED)
  collapsed <- collapsePathways(significant[order(significant$pval), ], pathways, ranks)
  main_pathways <- collapsed$mainPathways
  parents <- collapsed$parentPathways
  folded <- vapply(main_pathways, function(main) {
    members <- names(parents)[!is.na(parents) & parents == main]
    paste(members, collapse = ";")
  }, character(1))
} else {
  main_pathways <- character(0)
  folded <- character(0)
}
collapsed_table <- results_table[match(main_pathways, results_table$pathway), , drop = FALSE]
collapsed_table$collapsed_sets <- unname(folded)
write.csv(collapsed_table, out("collapsed.csv"), row.names = FALSE)
message("Collapsed ", nrow(significant), " significant sets to ", length(main_pathways), " main pathways")

# ── Figures ───────────────────────────────────────────────────────────────────
top_sets <- head(results_table[!is.na(results_table$padj), ], N_TOP_SETS)
top_sets$pathway <- factor(top_sets$pathway, levels = top_sets$pathway[order(top_sets$NES)])
dot_plot <- ggplot(top_sets, aes(x = NES, y = pathway, size = size, color = padj)) +
  geom_vline(xintercept = 0, linetype = "dashed", color = "grey60") +
  geom_point() +
  scale_color_viridis_c(direction = -1, name = "padj") +
  scale_size_continuous(name = "Set size", range = c(1.5, 6)) +
  xlab("Normalized enrichment score") + ylab(NULL) +
  ggtitle(paste0("Top ", nrow(top_sets), " gene sets by adjusted p-value (", RANK_METRIC, ")")) +
  theme_classic() +
  theme(axis.text.y = element_text(size = 7))
save_figure(dot_plot, "dot_plot", width = 8, height = max(4, 0.25 * nrow(top_sets) + 1.5))

significant_table <- results_table[!is.na(results_table$padj) & results_table$padj < PADJ_CUTOFF, ]
if (nrow(significant_table) > 0) {
  significant_table$pathway <- factor(significant_table$pathway, levels = significant_table$pathway[order(significant_table$NES)])
  significant_table$direction <- ifelse(significant_table$NES > 0, "positive", "negative")
  bar_plot <- ggplot(significant_table, aes(x = NES, y = pathway, fill = direction)) +
    geom_col() +
    scale_fill_manual(values = c(negative = "#3B528B", positive = "#F98E09"), name = "NES sign") +
    xlab("Normalized enrichment score") + ylab(NULL) +
    ggtitle(paste0("Gene sets at padj < ", PADJ_CUTOFF, " (", nrow(significant_table), ")")) +
    theme_classic() +
    theme(axis.text.y = element_text(size = 7))
  bar_height <- max(4, 0.25 * nrow(significant_table) + 1.5)
} else {
  bar_plot <- ggplot() +
    annotate("text", x = 0, y = 0, label = paste0("No gene set at padj < ", PADJ_CUTOFF)) +
    ggtitle("Gene sets at padj < 0.05") +
    theme_void()
  bar_height <- 4
}
save_figure(bar_plot, "nes_bar_plot", width = 8, height = bar_height)

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-fgsea-preranked@1.0.0",
  method = "fgsea multilevel preranked GSEA",
  inputs = list(results_path = RESULTS_PATH, gmt_path = GMT_PATH),
  database = DATABASE,
  rank_metric = RANK_METRIC,
  n_genes_input = nrow(results),
  n_genes_ranked = length(ranks),
  n_genes_in_sets = n_in_sets,
  n_sets_input = length(pathways),
  n_sets_tested = n_tested,
  n_significant = n_significant,
  n_up = n_up,
  n_down = n_down,
  n_main_pathways = length(main_pathways),
  padj_cutoff = PADJ_CUTOFF,
  min_size = MIN_SIZE,
  max_size = MAX_SIZE,
  eps = EPS,
  seed = SEED,
  versions = list(
    R = R.version.string,
    fgsea = as.character(packageVersion("fgsea")),
    ggplot2 = as.character(packageVersion("ggplot2"))
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("results.csv"))
