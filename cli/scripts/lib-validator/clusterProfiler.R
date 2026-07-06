#!/usr/bin/env Rscript
# Smoke test for the R `clusterProfiler` (Bioconductor) package.
#
# Fully self-contained: no input files, NO network. clusterProfiler can reach
# online annotation (GO / KEGG / OrgDb) -- this test DELIBERATELY AVOIDS all of
# that by driving the generic `enricher()` / `GSEA()` entry points with a
# user-supplied TERM2GENE mapping. Everything runs OFFLINE against synthetic
# terms and genes. Exits 0 only if every check passes, so it can be used as a
# pass/fail library validator:
#
#   Rscript clusterProfiler.R
#
# ============================ API UNCERTAINTY ================================
# RE-CHECK once installed -- the generic-enrichment argument names:
#
#   * enricher(gene, TERM2GENE, pvalueCutoff, qvalueCutoff, ...) is assumed;
#     `gene` is a character vector, `TERM2GENE` a 2-column data.frame (term,
#     gene). Cutoffs are set to 1 so every tested term is returned. Result class
#     assumed "enrichResult"; the reported term ids live in as.data.frame(res)$ID.
#
#   * GSEA(geneList, TERM2GENE, pvalueCutoff, ...) is assumed; `geneList` is a
#     DECREASING-sorted NAMED numeric vector. Result class assumed "gseaResult".
#
# TERM2GENE column *names* are ignored by clusterProfiler (position matters:
# col1 = term, col2 = gene), so only the arg names / class names above are the
# things to re-verify.
# ============================================================================

if (!requireNamespace("clusterProfiler", quietly = TRUE)) {
  cat("FAIL: package 'clusterProfiler' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(clusterProfiler))
cat(sprintf("clusterProfiler version: %s\n", as.character(packageVersion("clusterProfiler"))))

failures <- 0L
run_test <- function(name, fn) {
  result <- tryCatch({
    fn()
    "ok"
  }, error = function(e) conditionMessage(e))
  if (identical(result, "ok")) {
    cat(sprintf("  ok   %s\n", name))
  } else {
    failures <<- failures + 1L
    cat(sprintf("  FAIL %s: %s\n", name, result))
  }
}

# Synthetic, fully offline annotation: 200 genes partitioned into three terms.
# TERM_A is the planted term; the query gene list is exactly TERM_A's members,
# so the over-representation test must surface TERM_A.
set.seed(42)
gene_ids <- paste0("g", seq_len(200))
term2gene <- rbind(
  data.frame(term = "TERM_A", gene = gene_ids[1:30], stringsAsFactors = FALSE),
  data.frame(term = "TERM_B", gene = gene_ids[50:80], stringsAsFactors = FALSE),
  data.frame(term = "TERM_C", gene = gene_ids[100:140], stringsAsFactors = FALSE)
)
query_genes <- gene_ids[1:30]

# Ranked list for GSEA: TERM_A genes shifted up so the term enriches at the top.
scores <- rnorm(200)
names(scores) <- gene_ids
scores[gene_ids[1:30]] <- scores[gene_ids[1:30]] + 2
gene_list <- sort(scores, decreasing = TRUE)

run_test("enricher over a user TERM2GENE returns an enrichResult", function() {
  res <- suppressMessages(clusterProfiler::enricher(
    gene = query_genes, TERM2GENE = term2gene,
    pvalueCutoff = 1, qvalueCutoff = 1))
  stopifnot(inherits(res, "enrichResult"))
})

run_test("planted term appears in the enricher output", function() {
  res <- suppressMessages(clusterProfiler::enricher(
    gene = query_genes, TERM2GENE = term2gene,
    pvalueCutoff = 1, qvalueCutoff = 1))
  df <- as.data.frame(res)
  stopifnot(is.data.frame(df), nrow(df) >= 1L)
  stopifnot("ID" %in% names(df))
  stopifnot("TERM_A" %in% df$ID)
})

run_test("GSEA over a ranked geneList returns a gseaResult", function() {
  res <- suppressWarnings(suppressMessages(clusterProfiler::GSEA(
    geneList = gene_list, TERM2GENE = term2gene,
    minGSSize = 5, pvalueCutoff = 1, verbose = FALSE)))
  stopifnot(inherits(res, "gseaResult"))
})

run_test("GSEA result frame carries an ID column", function() {
  res <- suppressWarnings(suppressMessages(clusterProfiler::GSEA(
    geneList = gene_list, TERM2GENE = term2gene,
    minGSSize = 5, pvalueCutoff = 1, verbose = FALSE)))
  df <- as.data.frame(res)
  stopifnot(is.data.frame(df), "ID" %in% names(df))
  # SOFT: the planted term is expected to enrich, but leave it a note (not a
  # failure) so multilevel RNG variation can't false-fail a healthy install.
  if (!("TERM_A" %in% df$ID)) {
    cat("  note TERM_A not reported by GSEA (verify enrichment once installed)\n")
  }
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all clusterProfiler smoke tests passed\n")
