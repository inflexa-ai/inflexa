---
name: bulk-transcriptomics
description: Bulk RNA-seq and microarray differential expression analysis including method selection, batch correction, and complex experimental designs
version: 1.0.0
tags: [bulk-rna-seq, microarray, differential-expression, deseq2, limma, edger]
---

# Bulk Transcriptomics

Method selection and execution guidance for bulk RNA-seq and microarray differential expression analysis.

## Method Selection Decision Tree

Choose the DE method based on input data type, sample size, and experimental design:

```
Input data?
├── Raw integer counts (RNA-seq)
│   ├── Simple design (2 conditions, no interaction terms)
│   │   ├── n >= 3 per group, n <= 50 per group → PyDESeq2 (Python, default)
│   │   ├── n < 3 per group → edgeR QLF via rpy2 (better small-sample performance)
│   │   └── n > 50 per group → limma-voom via rpy2 (faster, scales well)
│   ├── Complex design (interaction terms, >2 factors, nested)
│   │   ├── Standard factorial/interaction → DESeq2 via rpy2 (full formula support)
│   │   └── Large n or many covariates → limma-voom via rpy2
│   ├── Longitudinal / repeated measures
│   │   └── dream (variancePartition) via rpy2 (mixed-effects voom)
│   └── Batch effects present
│       ├── Known batches → sva ComBat_seq on raw counts, then DE as above
│       └── Unknown confounders → svaseq to estimate surrogate variables, include in model
├── Pre-normalized data (TPM, FPKM, RPKM, log-CPM)
│   └── limma via rpy2 (do NOT use DESeq2/edgeR — they require raw counts)
└── Microarray CEL files
    └── oligo/affy RMA normalization via rpy2 → limma for DE
```

## Workflow Phases

1. **Data ingestion**: Load count matrix + sample metadata. Verify counts are raw integers.
2. **QC**: Library size distribution, gene detection rates, PCA for outlier detection.
3. **Filtering**: Remove low-count genes (e.g., keep genes with >= 10 counts in >= n samples where n is the smallest group size).
4. **Batch assessment**: PCA colored by batch — if batch clusters dominate, apply correction.
5. **Normalization**: Handled internally by each method (DESeq2 median-of-ratios, edgeR TMM, limma-voom). Do NOT pre-normalize.
6. **DE testing**: Apply the method from the decision tree. Extract results with log2FC, p-value, adjusted p-value.
7. **Downstream**: Pathway enrichment via decoupler, volcano/MA plots.

## Batch Correction Protocol

- **ComBat_seq**: Operates on raw counts. Preserves count nature for downstream DESeq2/edgeR. Always include biological variables of interest in the model to avoid removing real signal.
- **svaseq**: Estimates surrogate variables from residuals. Add SVs as covariates in the DE model formula — do NOT adjust the counts directly.
- **Order**: Batch correct BEFORE DE, but AFTER filtering.

## Contrast Specification

- PyDESeq2: `stat_res = ds.summary(contrast=["condition", "treated", "control"])`
- DESeq2 via rpy2: `results(dds, contrast=c("condition", "treated", "control"))` or use `resultsNames()` for coefficient-based.
- limma: Define contrast matrix with `makeContrasts()`. For interaction: `makeContrasts(groupB.time2 - groupA.time2 - groupB.time1 + groupA.time1, levels=design)`.
- edgeR: `glmQLFTest(fit, contrast=con)` with the same contrast matrix as limma.

## Output Conventions

- Save DE results as CSV with columns: gene, log2FoldChange, pvalue, padj, baseMean (or logCPM).
- Save normalized count matrix as CSV or in AnnData .h5ad.
- Volcano plot (log2FC vs -log10 padj) and MA plot (baseMean vs log2FC) as PNG/PDF.
- PCA plot of samples (top 500 variable genes) colored by condition and batch.

## Anti-Patterns

- **DESeq2/PyDESeq2 on TPM/FPKM**: These methods model raw counts with a negative binomial distribution. Normalized values break the statistical model and produce invalid results.
- **Wrong contrast syntax**: PyDESeq2 uses `["factor", "numerator", "denominator"]`. DESeq2 via rpy2 uses `c("factor", "numerator", "denominator")`. Mixing them up silently returns wrong comparisons.
- **Skipping normalization check**: Always verify library sizes are not wildly different before DE. Extreme outliers can dominate results.
- **Ignoring batch effects**: If samples were processed in batches (different days, lanes, plates), check PCA. Uncorrected batch effects inflate false positives.
- **Pre-filtering too aggressively**: Overly strict gene filters reduce power. Keep genes expressed in at least the smallest group size.
- **ComBat_seq without biological covariates**: Omitting the condition variable from `ComBat_seq(covar_mod=...)` can remove real biological signal along with batch effects.
- **Using svaseq-corrected counts for DE**: SVs should be added as covariates in the model formula, not used to adjust the count matrix.
- **Applying voom to already-normalized data**: voom expects raw counts (or logCPM from edgeR's `cpm()`). Feeding it log-transformed or TPM data produces incorrect precision weights.

## Additional Available Packages

### R (via rpy2)

- **xCell2** (AlmogAngel/xCell2): Cell type deconvolution from bulk expression data. Estimates 64+ cell type scores from bulk RNA-seq. Use when sample-level cell type composition is needed without single-cell data.

### Entry point

These workflows begin from a **count matrix**. Read alignment and
quantification are upstream of this pack: if you were given FASTQ rather than
counts, say so and stop — do not plan a from-FASTQ pipeline, and do not
substitute a different starting point to avoid the gap.

## References

API references for all supported packages:

- `references/pydeseq2-api.md` — Pure Python DESeq2 implementation (default for simple designs)
- `references/deseq2-rpy2-api.md` — R DESeq2 via rpy2 (complex designs, interaction terms, LRT)
- `references/edger-rpy2-api.md` — R edgeR via rpy2 (small sample sizes, QLF tests)
- `references/limma-rpy2-api.md` — R limma/voom via rpy2 (large samples, pre-normalized data, microarray)
- `references/sva-rpy2-api.md` — R sva via rpy2 (ComBat_seq batch correction, surrogate variables)
- `references/oligo-affy-rpy2-api.md` — R oligo/affy via rpy2 (microarray CEL file preprocessing, RMA)
