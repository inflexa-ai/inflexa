#!/usr/bin/env Rscript
# tpl-goseq-hallmark — goseq over-representation with a gene length correction.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: a long gene collects more reads, thus a count-based test calls it
# more easily, and a discrete gene list is enriched for long genes. goseq fits
# a probability weighting function (PWF) of the chance of a call against the
# gene length, then it weights the null of each category with that function
# through the Wallenius non-central hypergeometric distribution (Young et al.
# 2010). The universe is the set of tested genes with a length, never the
# whole genome. Benjamini-Hochberg adjustment over the tested sets, and every
# set is reported. The lengths come from a table and the categories from a
# GMT file, thus the script makes no genome or annotation download.

suppressPackageStartupMessages({
  library(goseq)
  library(ggplot2)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
RESULTS_PATH    <- {{results_path}}  # [adaptable: results_path]
LENGTHS_PATH    <- {{lengths_path}}  # [adaptable: lengths_path]
GMT_PATH        <- {{gmt_path}}  # [adaptable: gmt_path]
ALPHA           <- {{alpha}}  # [adaptable: alpha]
TEST_METHOD     <- {{test_method}}
OUTPUT_PREFIX   <- {{output_prefix}}  # [adaptable: output_prefix]
P_ADJUST_METHOD <- "BH"
SET_PADJ_CUTOFF <- 0.05
N_PWF_BINS      <- 30

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))

save_figure <- function(plot, name, width = 7, height = 5) {
  ggsave(fig(paste0(name, ".png")), plot, width = width, height = height, dpi = 300)
  ggsave(fig(paste0(name, ".pdf")), plot, width = width, height = height)
}

# ── Inputs ────────────────────────────────────────────────────────────────────
if (!file.exists(RESULTS_PATH)) stop("The results table does not exist: ", RESULTS_PATH)
if (!file.exists(LENGTHS_PATH)) stop("The gene length table does not exist: ", LENGTHS_PATH)
if (!file.exists(GMT_PATH)) stop("The GMT file does not exist: ", GMT_PATH)
if (ALPHA <= 0 || ALPHA > 1) stop("alpha must be in (0, 1], not ", ALPHA)

message("Reading the differential expression results from ", RESULTS_PATH)
results <- read.csv(RESULTS_PATH, check.names = FALSE, stringsAsFactors = FALSE)
required_columns <- c("gene", "adjusted_pvalue")
absent <- setdiff(required_columns, colnames(results))
if (length(absent) > 0) stop("The results table has no column ", paste(absent, collapse = ", "))
results$gene <- as.character(results$gene)
results$adjusted_pvalue <- suppressWarnings(as.numeric(results$adjusted_pvalue))
if (any(is.na(results$gene) | results$gene == "")) stop("The results table has an empty gene identifier")
if (nrow(results) == 0) stop("The results table has no rows")
if (any(duplicated(results$gene))) stop("The results table holds a duplicated gene identifier")

message("Reading the gene lengths from ", LENGTHS_PATH)
lengths_table <- read.csv(LENGTHS_PATH, check.names = FALSE, stringsAsFactors = FALSE)
absent <- setdiff(c("gene", "length"), colnames(lengths_table))
if (length(absent) > 0) stop("The gene length table has no column ", paste(absent, collapse = ", "))
lengths_table$gene <- as.character(lengths_table$gene)
lengths_table$length <- suppressWarnings(as.numeric(lengths_table$length))
lengths_table <- lengths_table[!is.na(lengths_table$length) & lengths_table$length > 0, , drop = FALSE]
if (nrow(lengths_table) == 0) stop("The gene length table holds no positive length")
if (any(duplicated(lengths_table$gene))) {
  message("The gene length table holds a duplicated gene identifier; the script keeps the first row of each")
  lengths_table <- lengths_table[!duplicated(lengths_table$gene), , drop = FALSE]
}
gene_length <- setNames(lengths_table$length, lengths_table$gene)

# The universe: every tested gene, that is every row with an adjusted p-value.
tested <- results[!is.na(results$adjusted_pvalue), , drop = FALSE]
if (nrow(tested) == 0) stop("No gene has an adjusted p-value, thus the universe is empty")
n_tested <- nrow(tested)
has_length <- tested$gene %in% names(gene_length)
message("Tested genes: ", n_tested, " of ", nrow(results), " rows; with a length: ", sum(has_length))
if (sum(has_length) == 0) {
  stop("No tested gene has a length. Make sure that the results table and the gene length table use the same identifier space.")
}
if (sum(has_length) < 0.5 * n_tested) {
  message("Warning: fewer than half of the tested genes have a length; the identifier spaces can differ")
}
tested <- tested[has_length, , drop = FALSE]
universe <- tested$gene

# The DE vector: 1 for a call under alpha, 0 otherwise, named by gene.
de_vector <- as.integer(tested$adjusted_pvalue < ALPHA)
names(de_vector) <- universe
n_de <- sum(de_vector)
message("Universe: ", length(universe), " genes; called at padj < ", ALPHA, ": ", n_de)
if (n_de == 0) stop("No gene is called at padj < ", ALPHA, ", thus there is no list to test")
if (n_de == length(universe)) stop("Every universe gene is called at padj < ", ALPHA, ", thus there is no null to test against")

message("Reading the gene sets from ", GMT_PATH)
gmt_lines <- readLines(GMT_PATH, warn = FALSE)
gmt_lines <- gmt_lines[nzchar(trimws(gmt_lines))]
if (length(gmt_lines) == 0) stop("The GMT file holds no gene set")
gmt_fields <- strsplit(gmt_lines, "\t", fixed = TRUE)
gene_sets <- lapply(gmt_fields, function(fields) unique(fields[-(1:2)][nzchar(fields[-(1:2)])]))
names(gene_sets) <- vapply(gmt_fields, function(fields) fields[1], character(1))
if (any(duplicated(names(gene_sets)))) stop("The GMT file holds a duplicated gene set name")
n_sets_in_gmt <- length(gene_sets)
gene2cat <- data.frame(
  gene = unlist(gene_sets, use.names = FALSE),
  category = rep(names(gene_sets), lengths(gene_sets)),
  stringsAsFactors = FALSE
)
annotated_universe <- intersect(universe, unique(gene2cat$gene))
annotated_list <- intersect(names(de_vector)[de_vector == 1], unique(gene2cat$gene))
message("Gene sets: ", n_sets_in_gmt, "; universe genes in a set: ", length(annotated_universe), "; called genes in a set: ", length(annotated_list))
if (length(annotated_universe) == 0) {
  stop("No universe gene is in a gene set. Make sure that the results table and the GMT use the same identifier space.")
}
if (length(annotated_universe) < 0.1 * length(universe)) {
  message("Warning: fewer than 10% of the universe is in a gene set; the identifier spaces can differ")
}
gene2cat <- gene2cat[gene2cat$gene %in% universe, , drop = FALSE]

# ── Probability weighting function ────────────────────────────────────────────
bias_data <- unname(gene_length[universe])
message("Fitting the probability weighting function of the call against the gene length")
pwf <- nullp(de_vector, bias.data = bias_data, plot.fit = FALSE)
pwf_table <- data.frame(
  gene = rownames(pwf),
  de = as.integer(pwf$DEgenes),
  length = pwf$bias.data,
  pwf = pwf$pwf,
  stringsAsFactors = FALSE
)
write.csv(pwf_table, out("pwf.csv"), row.names = FALSE)
message("PWF range: ", sprintf("%.3f", min(pwf$pwf)), " to ", sprintf("%.3f", max(pwf$pwf)), "; ",
        "the call rate is ", sprintf("%.3f", n_de / length(universe)))

# ── Test ──────────────────────────────────────────────────────────────────────
empty_results <- data.frame(
  pathway = character(0), size = integer(0), num_de = integer(0),
  pvalue = numeric(0), padj = numeric(0), genes = character(0), stringsAsFactors = FALSE
)

if (length(annotated_list) == 0) {
  message("The called list has no gene in a gene set; no set is tested")
  results_table <- empty_results
} else {
  message("Testing each gene set with goseq, method ", TEST_METHOD)
  enrichment <- goseq(pwf, gene2cat = gene2cat, method = TEST_METHOD, use_genes_without_cat = FALSE)
  called_genes <- names(de_vector)[de_vector == 1]
  set_genes <- vapply(as.character(enrichment$category), function(category) {
    members <- gene2cat$gene[gene2cat$category == category]
    paste(sort(intersect(members, called_genes)), collapse = ";")
  }, character(1))
  results_table <- data.frame(
    pathway = as.character(enrichment$category),
    size = as.integer(enrichment$numInCat),
    num_de = as.integer(enrichment$numDEInCat),
    pvalue = enrichment$over_represented_pvalue,
    padj = p.adjust(enrichment$over_represented_pvalue, method = P_ADJUST_METHOD),
    genes = unname(set_genes),
    stringsAsFactors = FALSE
  )
  results_table <- results_table[order(results_table$pvalue, results_table$padj), , drop = FALSE]
  rownames(results_table) <- NULL
}

n_sets_tested <- nrow(results_table)
n_significant <- sum(results_table$padj < SET_PADJ_CUTOFF)
message("Tested ", n_sets_tested, " gene sets; ", n_significant, " at padj < ", SET_PADJ_CUTOFF)
write.csv(results_table, out("results.csv"), row.names = FALSE)

# ── Figure ────────────────────────────────────────────────────────────────────
# The proportion of called genes per length bin, with the fitted curve.
pwf_sorted <- pwf_table[order(pwf_table$length), , drop = FALSE]
n_bins <- min(N_PWF_BINS, max(1, floor(nrow(pwf_sorted) / 10)))
pwf_sorted$bin <- cut(seq_len(nrow(pwf_sorted)), breaks = n_bins, labels = FALSE)
bins <- do.call(rbind, lapply(split(pwf_sorted, pwf_sorted$bin), function(rows) {
  data.frame(length = median(rows$length), proportion_de = mean(rows$de), n_genes = nrow(rows))
}))
pwf_plot <- ggplot() +
  geom_point(data = bins, aes(x = length, y = proportion_de, size = n_genes), color = "grey40", alpha = 0.8) +
  geom_line(data = pwf_sorted, aes(x = length, y = pwf), color = "#440154", linewidth = 1) +
  geom_hline(yintercept = n_de / length(universe), linetype = "dashed", color = "grey60") +
  scale_x_log10() +
  scale_size_continuous(name = "Genes in bin") +
  xlab("Gene length") + ylab("Proportion called differentially expressed") +
  ggtitle(paste0("goseq probability weighting function, ", n_de, " of ", length(universe), " genes at padj < ", ALPHA)) +
  theme_classic()
save_figure(pwf_plot, "pwf")

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-goseq-hallmark@1.0.0",
  method = "goseq over-representation with a gene length probability weighting function",
  inputs = list(results_path = RESULTS_PATH, lengths_path = LENGTHS_PATH, gmt_path = GMT_PATH),
  universe = "tested_genes_with_length",
  n_tested = n_tested,
  n_universe = length(universe),
  n_universe_annotated = length(annotated_universe),
  n_de = n_de,
  n_de_annotated = length(annotated_list),
  n_sets_in_gmt = n_sets_in_gmt,
  n_sets_tested = n_sets_tested,
  n_significant = n_significant,
  alpha = ALPHA,
  test_method = TEST_METHOD,
  p_adjust_method = P_ADJUST_METHOD,
  set_padj_cutoff = SET_PADJ_CUTOFF,
  pwf_range = list(min = min(pwf$pwf), max = max(pwf$pwf)),
  versions = list(
    R = R.version.string,
    goseq = as.character(packageVersion("goseq")),
    ggplot2 = as.character(packageVersion("ggplot2"))
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("results.csv"))
