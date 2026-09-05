#!/usr/bin/env Rscript
# tpl-ora-go — GO over-representation with enrichGO and rrvgo term reduction.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: hypergeometric over-representation of a discrete gene list against
# the terms of one Gene Ontology with clusterProfiler::enrichGO and an organism
# annotation package. The universe is the set of genes that the differential
# expression test tested (every row with a non-missing adjusted p-value), never
# the whole genome. Benjamini-Hochberg adjustment over the tested terms, and
# every term is reported. The GO terms nest, thus the significant terms are
# reduced to representative terms by semantic similarity with rrvgo (Wu et al.
# 2021; Sayols 2023; Supek et al. 2011; Reimand et al. 2019).

suppressPackageStartupMessages({
  library(clusterProfiler)
  library(rrvgo)
  library(ggplot2)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
RESULTS_PATH         <- {{results_path}}  # [adaptable: results_path]
ORG_PACKAGE          <- {{org_package}}  # [adaptable: org_package]
ONTOLOGY             <- {{ontology}}  # [adaptable: ontology]
ALPHA                <- {{alpha}}  # [adaptable: alpha]
LFC_CUTOFF           <- {{lfc_cutoff}}  # [adaptable: lfc_cutoff]
MIN_SIZE             <- {{min_size}}  # [adaptable: min_size]
MAX_SIZE             <- {{max_size}}  # [adaptable: max_size]
TERM_PADJ_CUTOFF     <- {{term_padj_cutoff}}
SIMILARITY_METHOD    <- {{similarity_method}}  # [adaptable: similarity_method]
SIMILARITY_THRESHOLD <- {{similarity_threshold}}  # [adaptable: similarity_threshold]
OUTPUT_PREFIX        <- {{output_prefix}}  # [adaptable: output_prefix]
KEY_TYPE             <- "SYMBOL"
P_ADJUST_METHOD      <- "BH"
N_TOP_TERMS          <- 20

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))

save_figure <- function(plot, name, width = 9, height = 6) {
  ggsave(fig(paste0(name, ".png")), plot, width = width, height = height, dpi = 300)
  ggsave(fig(paste0(name, ".pdf")), plot, width = width, height = height)
}

# ── Inputs ────────────────────────────────────────────────────────────────────
if (!ORG_PACKAGE %in% c("org.Hs.eg.db", "org.Mm.eg.db")) stop("The organism package must be org.Hs.eg.db or org.Mm.eg.db, not ", ORG_PACKAGE)
if (!ONTOLOGY %in% c("BP", "MF", "CC")) stop("The ontology must be one of BP, MF, CC, not ", ONTOLOGY)
if (!SIMILARITY_METHOD %in% c("Resnik", "Lin", "Rel", "Jiang", "Wang")) stop("The similarity method must be one of Resnik, Lin, Rel, Jiang, Wang, not ", SIMILARITY_METHOD)
if (MIN_SIZE > MAX_SIZE) stop("min_size (", MIN_SIZE, ") is larger than max_size (", MAX_SIZE, ")")
if (!file.exists(RESULTS_PATH)) stop("The results table does not exist: ", RESULTS_PATH)

message("Loading the organism annotation package ", ORG_PACKAGE)
suppressPackageStartupMessages(library(ORG_PACKAGE, character.only = TRUE))
orgdb <- get(ORG_PACKAGE)
known_symbols <- AnnotationDbi::keys(orgdb, keytype = KEY_TYPE)

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

# The gene list: under the adjusted p-value cutoff and over the fold change cutoff, both signs.
selected <- tested$adjusted_pvalue < ALPHA & !is.na(tested$log2_fold_change) & abs(tested$log2_fold_change) >= LFC_CUTOFF
gene_list <- unique(tested$gene[selected])
message("Gene list: ", length(gene_list), " genes at padj < ", ALPHA, ", |log2 fold change| >= ", LFC_CUTOFF)

# The unmapped share: a symbol that the annotation package does not know cannot reach a GO term.
mapped_universe <- intersect(universe, known_symbols)
mapped_list <- intersect(gene_list, known_symbols)
unmapped_share_universe <- 1 - length(mapped_universe) / length(universe)
unmapped_share_gene_list <- if (length(gene_list) == 0) NA_real_ else 1 - length(mapped_list) / length(gene_list)
message(sprintf("Symbols known to %s: universe %d of %d (%.1f%% unmapped), gene list %d of %d (%.1f%% unmapped)",
  ORG_PACKAGE, length(mapped_universe), length(universe), 100 * unmapped_share_universe,
  length(mapped_list), length(gene_list), 100 * ifelse(is.na(unmapped_share_gene_list), 0, unmapped_share_gene_list)))
if (length(mapped_universe) == 0) {
  stop("No universe gene is a symbol of ", ORG_PACKAGE, ". Make sure that the gene column holds gene symbols of the organism.")
}
if (unmapped_share_universe > 0.5) {
  message("Warning: more than half of the universe is unknown to ", ORG_PACKAGE, "; the unmapped genes leave the test")
}

# ── Test ──────────────────────────────────────────────────────────────────────
empty_results <- data.frame(
  pathway = character(0), term = character(0), gene_ratio = character(0), bg_ratio = character(0),
  fold_enrichment = numeric(0), pvalue = numeric(0), padj = numeric(0),
  count = integer(0), genes = character(0), stringsAsFactors = FALSE
)

ratio_value <- function(ratio) {
  parts <- strsplit(as.character(ratio), "/", fixed = TRUE)
  vapply(parts, function(part) as.numeric(part[1]) / as.numeric(part[2]), numeric(1))
}

if (length(mapped_list) == 0) {
  message("The gene list has no symbol known to ", ORG_PACKAGE, "; no term is tested")
  results_table <- empty_results
} else {
  enrichment <- enrichGO(
    gene = gene_list,
    OrgDb = orgdb,
    keyType = KEY_TYPE,
    ont = ONTOLOGY,
    universe = universe,
    minGSSize = MIN_SIZE,
    maxGSSize = MAX_SIZE,
    pAdjustMethod = P_ADJUST_METHOD,
    pvalueCutoff = 1,
    qvalueCutoff = 1
  )
  if (is.null(enrichment) || nrow(as.data.frame(enrichment)) == 0) {
    message("No ", ONTOLOGY, " term passes the size filter [", MIN_SIZE, ", ", MAX_SIZE, "] on the universe; no term is tested")
    results_table <- empty_results
  } else {
    enrichment_df <- as.data.frame(enrichment)
    results_table <- data.frame(
      pathway = as.character(enrichment_df$ID),
      term = as.character(enrichment_df$Description),
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

n_terms_tested <- nrow(results_table)
significant <- results_table[results_table$padj < TERM_PADJ_CUTOFF, , drop = FALSE]
n_significant <- nrow(significant)
message("Tested ", n_terms_tested, " ", ONTOLOGY, " terms; ", n_significant, " at padj < ", TERM_PADJ_CUTOFF)
write.csv(results_table, out("results.csv"), row.names = FALSE)

# ── Term reduction ────────────────────────────────────────────────────────────
# rrvgo scores each term, computes the semantic similarity between the terms,
# clusters them at the threshold, and names the highest scored term of each
# cluster the parent. The score is -log10 of the adjusted p-value.
empty_reduced <- data.frame(
  pathway = character(0), term = character(0), padj = numeric(0), cluster = integer(0),
  parent = character(0), parent_term = character(0), representative = logical(0),
  score = numeric(0), size = integer(0), term_uniqueness = numeric(0), term_dispensability = numeric(0),
  stringsAsFactors = FALSE
)
n_terms_without_ic <- 0L

if (n_significant == 0) {
  message("No significant term; the reduction has nothing to do")
  reduced_table <- empty_reduced
} else if (n_significant == 1) {
  message("One significant term; it is its own representative")
  reduced_table <- data.frame(
    pathway = significant$pathway, term = significant$term, padj = significant$padj, cluster = 1L,
    parent = significant$pathway, parent_term = significant$term, representative = TRUE,
    score = -log10(pmax(significant$padj, .Machine$double.xmin)), size = NA_integer_,
    term_uniqueness = NA_real_, term_dispensability = NA_real_, stringsAsFactors = FALSE
  )
} else {
  message("Reducing ", n_significant, " significant terms with rrvgo (", SIMILARITY_METHOD, ", threshold ", SIMILARITY_THRESHOLD, ")")
  similarity <- calculateSimMatrix(significant$pathway, orgdb = ORG_PACKAGE, ont = ONTOLOGY, method = SIMILARITY_METHOD)
  n_terms_without_ic <- n_significant - nrow(similarity)
  if (n_terms_without_ic > 0) message(n_terms_without_ic, " significant terms have no information content in ", ORG_PACKAGE, " and leave the reduction")
  scores <- setNames(-log10(pmax(significant$padj, .Machine$double.xmin)), significant$pathway)
  reduced <- reduceSimMatrix(similarity, scores = scores, threshold = SIMILARITY_THRESHOLD, orgdb = ORG_PACKAGE)
  padj_by_term <- setNames(significant$padj, significant$pathway)
  reduced_table <- data.frame(
    pathway = as.character(reduced$go),
    term = as.character(reduced$term),
    padj = unname(padj_by_term[as.character(reduced$go)]),
    cluster = as.integer(reduced$cluster),
    parent = as.character(reduced$parent),
    parent_term = as.character(reduced$parentTerm),
    representative = as.character(reduced$go) == as.character(reduced$parent),
    score = reduced$score,
    size = as.integer(reduced$size),
    term_uniqueness = reduced$termUniqueness,
    term_dispensability = reduced$termDispensability,
    stringsAsFactors = FALSE
  )
  reduced_table <- reduced_table[order(reduced_table$cluster, -reduced_table$representative, reduced_table$padj), , drop = FALSE]
  rownames(reduced_table) <- NULL
}

n_representative <- sum(reduced_table$representative)
message("Representative terms: ", n_representative, " of ", nrow(reduced_table), " reduced terms")
write.csv(reduced_table, out("reduced.csv"), row.names = FALSE)

# ── Figures ───────────────────────────────────────────────────────────────────
top_terms <- head(results_table[order(results_table$padj, results_table$pvalue), , drop = FALSE], N_TOP_TERMS)
dot_title <- paste0("GO ", ONTOLOGY, " ORA, padj < ", ALPHA, ": top ", nrow(top_terms), " terms by padj")
dot_height <- max(4, 0.3 * nrow(top_terms) + 1.5)

if (nrow(top_terms) == 0) {
  blank <- ggplot() + annotate("text", x = 0, y = 0, label = "No GO term was tested") + theme_void() + ggtitle(dot_title)
  save_figure(blank, "dotplot", height = 4)
} else {
  top_terms$label <- factor(paste0(top_terms$term, " (", top_terms$pathway, ")"), levels = rev(paste0(top_terms$term, " (", top_terms$pathway, ")")))
  dot_plot <- ggplot(top_terms, aes(x = fold_enrichment, y = label, size = count, color = padj)) +
    geom_point() +
    scale_color_viridis_c(direction = -1, name = "padj") +
    scale_size_continuous(name = "Count") +
    xlab("Fold enrichment") + ylab(NULL) +
    ggtitle(dot_title) +
    theme_classic()
  save_figure(dot_plot, "dotplot", height = dot_height)
}

representatives <- reduced_table[reduced_table$representative, , drop = FALSE]
reduced_title <- paste0("GO ", ONTOLOGY, " ORA, rrvgo reduction at ", SIMILARITY_THRESHOLD, ": ", nrow(representatives), " representative terms")
if (nrow(representatives) == 0) {
  blank <- ggplot() + annotate("text", x = 0, y = 0, label = "No significant GO term") + theme_void() + ggtitle(reduced_title)
  save_figure(blank, "reduced_barplot", height = 4)
} else {
  cluster_sizes <- table(reduced_table$cluster)
  representatives$n_terms <- as.integer(cluster_sizes[as.character(representatives$cluster)])
  representatives$neg_log10_padj <- -log10(pmax(representatives$padj, .Machine$double.xmin))
  representatives <- representatives[order(representatives$neg_log10_padj), , drop = FALSE]
  representatives$label <- factor(paste0(representatives$term, " (", representatives$pathway, ")"), levels = paste0(representatives$term, " (", representatives$pathway, ")"))
  reduced_plot <- ggplot(representatives, aes(x = neg_log10_padj, y = label, fill = n_terms)) +
    geom_col() +
    geom_vline(xintercept = -log10(TERM_PADJ_CUTOFF), linetype = "dashed") +
    scale_fill_viridis_c(name = "Terms in cluster") +
    xlab("-log10 adjusted p-value of the representative") + ylab(NULL) +
    ggtitle(reduced_title) +
    theme_classic()
  save_figure(reduced_plot, "reduced_barplot", height = max(4, 0.3 * nrow(representatives) + 1.5))
}

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-ora-go@1.0.0",
  method = "clusterProfiler enrichGO, hypergeometric over-representation, rrvgo term reduction",
  inputs = list(results_path = RESULTS_PATH),
  org_package = ORG_PACKAGE,
  ontology = ONTOLOGY,
  key_type = KEY_TYPE,
  universe = "tested_genes",
  n_input_genes = length(gene_list),
  n_input_genes_mapped = length(mapped_list),
  unmapped_share_gene_list = unmapped_share_gene_list,
  n_universe = length(universe),
  n_universe_mapped = length(mapped_universe),
  unmapped_share_universe = unmapped_share_universe,
  n_terms_tested = n_terms_tested,
  n_significant = n_significant,
  n_terms_without_ic = n_terms_without_ic,
  n_reduced = nrow(reduced_table),
  n_representative = n_representative,
  alpha = ALPHA,
  lfc_cutoff = LFC_CUTOFF,
  min_size = MIN_SIZE,
  max_size = MAX_SIZE,
  p_adjust_method = P_ADJUST_METHOD,
  term_padj_cutoff = TERM_PADJ_CUTOFF,
  similarity_method = SIMILARITY_METHOD,
  similarity_threshold = SIMILARITY_THRESHOLD,
  versions = list(
    R = R.version.string,
    clusterProfiler = as.character(packageVersion("clusterProfiler")),
    rrvgo = as.character(packageVersion("rrvgo")),
    GO.db = as.character(packageVersion("GO.db")),
    org_package = as.character(packageVersion(ORG_PACKAGE)),
    ggplot2 = as.character(packageVersion("ggplot2"))
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA, na = "null")
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("results.csv"), " and ", out("reduced.csv"))
