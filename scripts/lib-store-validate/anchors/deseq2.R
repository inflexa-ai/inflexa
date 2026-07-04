# Anchor: DESeq2 — run a tiny real differential-expression pass end to end.
# A clean library() can pass while the compiled backend miscomputes; this does
# actual work (fit + results) on a synthetic count matrix.
suppressPackageStartupMessages(library(DESeq2))

set.seed(1)
n_genes <- 200L
n_samples <- 6L
counts <- matrix(rpois(n_genes * n_samples, lambda = 100),
                 nrow = n_genes, ncol = n_samples)
rownames(counts) <- paste0("g", seq_len(n_genes))
colnames(counts) <- paste0("s", seq_len(n_samples))
cond <- factor(rep(c("A", "B"), each = 3))
col_data <- DataFrame(condition = cond)

dds <- DESeqDataSetFromMatrix(countData = counts, colData = col_data, design = ~condition)
dds <- DESeq(dds, quiet = TRUE)
res <- results(dds)

stopifnot(nrow(res) == n_genes)
stopifnot("log2FoldChange" %in% colnames(res))
stopifnot(any(is.finite(res$log2FoldChange)))
cat("DESeq2 anchor OK: fitted", n_genes, "genes,", n_samples, "samples\n")
