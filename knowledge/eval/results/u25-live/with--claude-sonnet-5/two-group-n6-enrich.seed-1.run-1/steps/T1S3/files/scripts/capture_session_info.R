# Reproducibility record: capture sessionInfo() for the exact R packages
# used by the upstream DESeq2 (T1S2) and fgsea (T2S1) steps, in the shared
# sandbox R environment they both ran in. This is a report-consolidation
# step, not a re-analysis: no DESeq2/fgsea computation is repeated here.

suppressPackageStartupMessages({
  library(DESeq2)
  library(apeglm)
  library(fgsea)
  library(org.Hs.eg.db)
  library(AnnotationDbi)
  library(data.table)
  library(ggplot2)
  library(ggrepel)
  library(pheatmap)
  library(ggridges)
  library(BiocParallel)
})

dir.create("output", showWarnings = FALSE)

si <- sessionInfo()
writeLines(capture.output(print(si)), "output/session_info_R.txt")

pkgs <- c(
  "DESeq2", "apeglm", "fgsea", "org.Hs.eg.db", "AnnotationDbi",
  "data.table", "ggplot2", "ggrepel", "pheatmap", "ggridges", "BiocParallel"
)
versions <- data.frame(
  package = pkgs,
  version = vapply(pkgs, function(p) as.character(packageVersion(p)), character(1)),
  stringsAsFactors = FALSE
)
write.csv(versions, "output/package_versions_R.csv", row.names = FALSE)

message(sprintf("R version: %s", getRversion()))
message("sessionInfo written to output/session_info_R.txt")
message("Package version table written to output/package_versions_R.csv")
