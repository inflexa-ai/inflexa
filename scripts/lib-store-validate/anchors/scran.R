# Anchor: scran — compute size factors on a tiny SingleCellExperiment, then
# a quick modelGeneVar. Exercises scran's compiled normalization backend.
suppressPackageStartupMessages({
  library(scran)
  library(SingleCellExperiment)
})

set.seed(1)
n_genes <- 300L
n_cells <- 120L
counts <- matrix(rpois(n_genes * n_cells, lambda = 5),
                 nrow = n_genes, ncol = n_cells)
rownames(counts) <- paste0("g", seq_len(n_genes))
colnames(counts) <- paste0("c", seq_len(n_cells))
sce <- SingleCellExperiment(assays = list(counts = counts))

clusters <- quickCluster(sce, min.size = 20)
sce <- computeSumFactors(sce, clusters = clusters)
sf <- sizeFactors(sce)

stopifnot(length(sf) == n_cells)
stopifnot(all(is.finite(sf)))
stopifnot(all(sf > 0))
cat("scran anchor OK: size factors for", n_cells, "cells\n")
