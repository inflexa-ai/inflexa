#!/usr/bin/env Rscript
# 01_gene_id_mapping.R
#
# Maps every tested gene symbol in the DESeq2 treated-vs-control results table
# to an Entrez Gene ID via org.Hs.eg.db, and reports the mapped/unmapped share.
# This is a reporting/QC step: the DESeq2 results table's "gene" column already
# carries HGNC-style symbols, which is also the identifier space of the Hallmark
# and Reactome GMT files used for fgsea (both are symbol-keyed, per the
# reference-store catalogue), so the GSEA itself ranks and tests on symbols
# directly and does not require the Entrez mapping. The mapping share below
# quantifies how much of the tested gene list is recognized as real HGNC gene
# symbols by a curated annotation database, which is informative given this
# dataset's mix of real symbols and non-standard "GENE#####" placeholder IDs
# (noted at T1S2).

suppressPackageStartupMessages({
  library(org.Hs.eg.db)
  library(AnnotationDbi)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
RESULTS_PATH   <- "/eval-e2e-smoke-with-two-group-n6-enrich-s1-1/runs/619852b4-1723-48f1-b3fe-f19dbee5d2d9/T1S2/output/deseq2_results.csv"
OUTPUT_TABLE   <- "output/gene_id_mapping.csv"
OUTPUT_SUMMARY <- "output/gene_id_mapping_summary.json"

dir.create("output", showWarnings = FALSE, recursive = TRUE)

# ── Load the full tested-gene list (no threshold) ────────────────────────────
message("Reading DESeq2 results from ", RESULTS_PATH)
results <- read.csv(RESULTS_PATH, check.names = FALSE, stringsAsFactors = FALSE)
results$gene <- as.character(results$gene)

# "Tested" here means every gene DESeq2's Wald test produced a `stat` value
# for after the low-count pre-filter -- this is the FULL ranked list handed to
# fgsea below, deliberately not narrowed to genes with a non-NA `padj`.
# independent filtering only blanks `padj` for low-mean genes (380 of them,
# per T1S2); it does not blank `stat`, so those 380 genes are still ranked and
# tested by GSEA and are included here. No p-value/padj threshold is applied.
tested <- results[!is.na(results$stat) & is.finite(results$stat), , drop = FALSE]
n_input <- nrow(results)
n_tested <- nrow(tested)
message("Results table: ", n_input, " genes total; ", n_tested, " with a finite Wald `stat` (the full, unthresholded ranked list used for GSEA; na_reason breakdown: ",
        paste(names(table(tested$na_reason)), table(tested$na_reason), sep = "=", collapse = ", "), ")")

# ── Map symbol -> Entrez via org.Hs.eg.db ────────────────────────────────────
symbols <- unique(tested$gene)
message("Mapping ", length(symbols), " unique gene symbols to Entrez IDs via org.Hs.eg.db ", as.character(packageVersion("org.Hs.eg.db")))
entrez <- suppressMessages(AnnotationDbi::mapIds(
  org.Hs.eg.db,
  keys = symbols,
  column = "ENTREZID",
  keytype = "SYMBOL",
  multiVals = "first"
))

mapping_table <- data.frame(
  gene_symbol = symbols,
  entrez_id = unname(entrez[symbols]),
  mapped = !is.na(entrez[symbols]),
  stringsAsFactors = FALSE
)
mapping_table <- merge(
  tested[, c("gene", "stat", "pvalue", "adjusted_pvalue")],
  mapping_table,
  by.x = "gene", by.y = "gene_symbol", all.x = TRUE
)
names(mapping_table)[names(mapping_table) == "gene"] <- "gene_symbol"
mapping_table <- mapping_table[order(-mapping_table$mapped, mapping_table$gene_symbol), ]
write.csv(mapping_table, OUTPUT_TABLE, row.names = FALSE)

n_mapped_unique <- sum(!is.na(entrez))
n_unmapped_unique <- length(symbols) - n_mapped_unique
n_mapped_rows <- sum(mapping_table$mapped)
n_unmapped_rows <- nrow(mapping_table) - n_mapped_rows

message(sprintf(
  "Entrez mapping: %d of %d unique tested gene symbols mapped (%.1f%%); %d unmapped (%.1f%%)",
  n_mapped_unique, length(symbols), 100 * n_mapped_unique / length(symbols),
  n_unmapped_unique, 100 * n_unmapped_unique / length(symbols)
))

# Break down the unmapped set by whether it looks like the dataset's non-HGNC
# placeholder identifier ("GENE" followed by digits) vs. anything else.
unmapped_symbols <- symbols[is.na(entrez[symbols])]
n_placeholder <- sum(grepl("^GENE[0-9]+$", unmapped_symbols))
n_other_unmapped <- length(unmapped_symbols) - n_placeholder
message(sprintf(
  "Of the %d unmapped symbols: %d match the placeholder pattern 'GENE#####' (non-HGNC IDs the dataset carries), %d are unmapped for another reason",
  length(unmapped_symbols), n_placeholder, n_other_unmapped
))

summary_record <- list(
  results_path = RESULTS_PATH,
  n_genes_input_table = n_input,
  n_genes_tested = n_tested,
  n_unique_symbols_tested = length(symbols),
  n_mapped_unique_symbols = n_mapped_unique,
  n_unmapped_unique_symbols = n_unmapped_unique,
  fraction_mapped = n_mapped_unique / length(symbols),
  fraction_unmapped = n_unmapped_unique / length(symbols),
  n_unmapped_placeholder_gene_ids = n_placeholder,
  n_unmapped_other = n_other_unmapped,
  mapping_source = "org.Hs.eg.db",
  org_hs_eg_db_version = as.character(packageVersion("org.Hs.eg.db")),
  keytype = "SYMBOL",
  target = "ENTREZID",
  note = "GSEA ranking and testing (fgsea vs Hallmark/Reactome) is performed directly on gene symbols, which is the native identifier space of both GMT collections; this Entrez mapping is a reporting/QC step on gene identifier quality, not an input to the enrichment test."
)
write_json(summary_record, OUTPUT_SUMMARY, auto_unbox = TRUE, pretty = TRUE, digits = NA)
message("Done: ", OUTPUT_TABLE)
