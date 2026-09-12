#!/usr/bin/env Rscript
# tpl-dose-ora — Disease Ontology over-representation with DOSE enrichDO.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: hypergeometric over-representation of a discrete human gene list
# against the terms of the Human Disease Ontology with DOSE::enrichDO (Yu et
# al. 2015). DOSE 4 reads its gene sets from a file that it downloads, and the
# sandbox has no network, thus the script builds the same gene sets from the
# HDO.db annotation package: each term holds its own genes and the genes of
# its offspring. DOSE takes Entrez gene identifiers, thus the script maps the
# symbols of the results table with org.Hs.eg.db and reports the unmapped share. The
# universe is the set of genes that the differential expression test tested
# (every row with a non-missing adjusted p-value), never the whole genome.
# Benjamini-Hochberg adjustment over the tested terms, and every term is
# reported. The test is a complement to the GO over-representation, with the
# same universe rules (Reimand et al. 2019).

suppressPackageStartupMessages({
  library(DOSE)
  library(HDO.db)
  library(AnnotationDbi)
  library(ggplot2)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
RESULTS_PATH     <- {{results_path}}  # [adaptable: results_path]
ONTOLOGY         <- {{ontology}}
ALPHA            <- {{alpha}}  # [adaptable: alpha]
LFC_CUTOFF       <- {{lfc_cutoff}}  # [adaptable: lfc_cutoff]
MIN_SIZE         <- {{min_size}}  # [adaptable: min_size]
MAX_SIZE         <- {{max_size}}  # [adaptable: max_size]
TERM_PADJ_CUTOFF <- {{term_padj_cutoff}}
OUTPUT_PREFIX    <- {{output_prefix}}  # [adaptable: output_prefix]
ORG_PACKAGE      <- "org.Hs.eg.db"  # the Disease Ontology annotates human genes
KEY_TYPE         <- "SYMBOL"
P_ADJUST_METHOD  <- "BH"
N_TOP_TERMS      <- 20

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))

save_figure <- function(plot, name, width = 9, height = 6) {
  ggsave(fig(paste0(name, ".png")), plot, width = width, height = height, dpi = 300)
  ggsave(fig(paste0(name, ".pdf")), plot, width = width, height = height)
}

# ── Inputs ────────────────────────────────────────────────────────────────────
if (ONTOLOGY != "HDO") stop("The ontology is pinned to HDO, the Human Disease Ontology of DOSE 4, not ", ONTOLOGY)
if (MIN_SIZE > MAX_SIZE) stop("min_size (", MIN_SIZE, ") is larger than max_size (", MAX_SIZE, ")")
if (!file.exists(RESULTS_PATH)) stop("The results table does not exist: ", RESULTS_PATH)

message("Loading the organism annotation package ", ORG_PACKAGE)
suppressPackageStartupMessages(library(ORG_PACKAGE, character.only = TRUE))
orgdb <- get(ORG_PACKAGE)

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

# ── The Disease Ontology gene sets from HDO.db ───────────────────────────────
# DOSE keeps its gene sets in an in-process cache, keyed by the ontology. The
# script fills that cache from HDO.db before the test: a term holds the genes
# annotated to it and to every offspring term, the same propagation as the
# file that DOSE downloads.
hdo <- HDO.db::HDO_dbconn()
direct <- DBI::dbGetQuery(hdo, "select doid, gene from do_gene")
offspring <- DBI::dbGetQuery(hdo, "select doid, offspring from do_offspring")
do_terms <- DBI::dbGetQuery(hdo, "select doid, term from do_term")
hdo_metadata <- DBI::dbGetQuery(hdo, "select name, value from metadata")
inherited <- merge(offspring, direct, by.x = "offspring", by.y = "doid")[, c("doid", "gene")]
term2gene <- unique(rbind(direct, inherited))
colnames(term2gene) <- c("gsid", "gene")
term2gene$gene <- as.character(term2gene$gene)
term2name <- unique(data.frame(gsid = do_terms$doid, name = do_terms$term, stringsAsFactors = FALSE))
hdo_source_date <- hdo_metadata$value[hdo_metadata$name == "HDOSOURCEDATE"]
gene_sets <- gson::gson(
  gsid2gene = term2gene, gsid2name = term2name, species = "Homo sapiens", gsname = ONTOLOGY,
  keytype = "ENTREZID", version = as.character(packageVersion("HDO.db")), accessed_date = as.character(Sys.Date())
)
assign(sprintf(".%s_DOSE_GSON", ONTOLOGY), gene_sets, envir = DOSE:::get_dose_env())
message("Disease Ontology gene sets from HDO.db ", packageVersion("HDO.db"), " (source date ", hdo_source_date, "): ", nrow(term2name), " terms, ", nrow(term2gene), " term-gene pairs after the propagation to the ancestors")

# ── Symbols to Entrez identifiers ─────────────────────────────────────────────
# enrichDO takes Entrez identifiers. A symbol with no Entrez identifier, or one
# that maps to several, leaves the test, and the summary reports the share.
symbol_map <- suppressMessages(AnnotationDbi::select(orgdb, keys = universe, keytype = KEY_TYPE, columns = "ENTREZID"))
symbol_map <- symbol_map[!is.na(symbol_map$ENTREZID), , drop = FALSE]
symbol_map <- symbol_map[!duplicated(symbol_map$SYMBOL) & !duplicated(symbol_map$ENTREZID), , drop = FALSE]
entrez_of <- setNames(as.character(symbol_map$ENTREZID), symbol_map$SYMBOL)
symbol_of <- setNames(names(entrez_of), entrez_of)
universe_entrez <- unname(entrez_of[intersect(universe, names(entrez_of))])
list_entrez <- unname(entrez_of[intersect(gene_list, names(entrez_of))])
unmapped_share_universe <- 1 - length(universe_entrez) / length(universe)
unmapped_share_gene_list <- if (length(gene_list) == 0) NA_real_ else 1 - length(list_entrez) / length(gene_list)
message(sprintf("Entrez identifiers from %s: universe %d of %d (%.1f%% unmapped), gene list %d of %d (%.1f%% unmapped)",
  ORG_PACKAGE, length(universe_entrez), length(universe), 100 * unmapped_share_universe,
  length(list_entrez), length(gene_list), 100 * ifelse(is.na(unmapped_share_gene_list), 0, unmapped_share_gene_list)))
if (length(universe_entrez) == 0) stop("No universe gene maps to an Entrez identifier. Make sure that the gene column holds human gene symbols.")
if (unmapped_share_universe > 0.5) message("Warning: more than half of the universe has no Entrez identifier; the unmapped genes leave the test")

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

if (length(list_entrez) == 0) {
  message("The gene list has no Entrez identifier; no term is tested")
  results_table <- empty_results
} else {
  enrichment <- enrichDO(
    gene = list_entrez,
    ont = ONTOLOGY,
    universe = universe_entrez,
    minGSSize = MIN_SIZE,
    maxGSSize = MAX_SIZE,
    pAdjustMethod = P_ADJUST_METHOD,
    pvalueCutoff = 1,
    qvalueCutoff = 1,
    readable = FALSE
  )
  if (is.null(enrichment) || nrow(as.data.frame(enrichment)) == 0) {
    message("No ", ONTOLOGY, " term passes the size filter [", MIN_SIZE, ", ", MAX_SIZE, "] on the universe; no term is tested")
    results_table <- empty_results
  } else {
    enrichment_df <- as.data.frame(enrichment)
    gene_symbols <- vapply(strsplit(as.character(enrichment_df$geneID), "/", fixed = TRUE), function(ids) {
      paste(ifelse(ids %in% names(symbol_of), symbol_of[ids], ids), collapse = ";")
    }, character(1))
    results_table <- data.frame(
      pathway = as.character(enrichment_df$ID),
      term = as.character(enrichment_df$Description),
      gene_ratio = as.character(enrichment_df$GeneRatio),
      bg_ratio = as.character(enrichment_df$BgRatio),
      fold_enrichment = ratio_value(enrichment_df$GeneRatio) / ratio_value(enrichment_df$BgRatio),
      pvalue = enrichment_df$pvalue,
      padj = enrichment_df$p.adjust,
      count = as.integer(enrichment_df$Count),
      genes = gene_symbols,
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

# ── Figures ───────────────────────────────────────────────────────────────────
top_terms <- head(results_table[order(results_table$padj, results_table$pvalue), , drop = FALSE], N_TOP_TERMS)
dot_title <- paste0("Disease Ontology ORA (", ONTOLOGY, "), padj < ", ALPHA, ": top ", nrow(top_terms), " terms by padj")
if (nrow(top_terms) == 0) {
  blank <- ggplot() + annotate("text", x = 0, y = 0, label = "No Disease Ontology term was tested") + theme_void() + ggtitle(dot_title)
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
  save_figure(dot_plot, "dotplot", height = max(4, 0.3 * nrow(top_terms) + 1.5))
}

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-dose-ora@1.0.0",
  method = "DOSE enrichDO, hypergeometric over-representation against the Disease Ontology",
  inputs = list(results_path = RESULTS_PATH),
  org_package = ORG_PACKAGE,
  ontology = ONTOLOGY,
  ontology_source = list(package = "HDO.db", version = as.character(packageVersion("HDO.db")), source_date = hdo_source_date, n_terms = nrow(term2name), n_term_gene_pairs = nrow(term2gene)),
  key_type = KEY_TYPE,
  identifier_space = "Entrez identifiers mapped from the symbols",
  universe = "tested_genes",
  n_input_genes = length(gene_list),
  n_input_genes_mapped = length(list_entrez),
  unmapped_share_gene_list = unmapped_share_gene_list,
  n_universe = length(universe),
  n_universe_mapped = length(universe_entrez),
  unmapped_share_universe = unmapped_share_universe,
  n_terms_tested = n_terms_tested,
  n_significant = n_significant,
  alpha = ALPHA,
  lfc_cutoff = LFC_CUTOFF,
  min_size = MIN_SIZE,
  max_size = MAX_SIZE,
  p_adjust_method = P_ADJUST_METHOD,
  term_padj_cutoff = TERM_PADJ_CUTOFF,
  versions = list(
    R = R.version.string,
    DOSE = as.character(packageVersion("DOSE")),
    HDO.db = as.character(packageVersion("HDO.db")),
    org_package = as.character(packageVersion(ORG_PACKAGE)),
    ggplot2 = as.character(packageVersion("ggplot2"))
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA, na = "null")
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("results.csv"))
