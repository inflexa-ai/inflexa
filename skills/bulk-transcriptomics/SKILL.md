---
name: bulk-transcriptomics
description: Read before you analyze bulk RNA-seq counts or normalized microarray data. It gives the test for each design and sample size (no replicates, small groups, interactions, repeated measures), the input that each test accepts, batch correction, and contrast traps.
metadata:
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
│   │   ├── n = 2 per group → edgeR QLF via rpy2 (better small-sample performance)
│   │   ├── No biological replication in any group (1 vs 1) → NO inferential DE.
│   │   │     Report descriptive log2 fold changes only, and state why
│   │   │     (see Anti-Patterns)
│   │   └── n > 50 per group → limma-voom via rpy2 (faster, scales well)
│   ├── Complex design (interaction terms, >2 factors, nested)
│   │   ├── Standard factorial/interaction → DESeq2 via rpy2 (full formula support)
│   │   └── Large n or many covariates → limma-voom via rpy2
│   ├── Longitudinal / repeated measures
│   │   └── dream (variancePartition) via rpy2 (mixed-effects voom)
│   └── Batch effects present
│       ├── Known batches → sva ComBat_seq on raw counts, then DE as above
│       └── Unknown confounders → svaseq to estimate surrogate variables, include in model
├── Pre-normalized data (TPM, FPKM, RPKM, log-CPM, microarray intensities)
│   └── limma via rpy2 (do NOT use DESeq2/edgeR — they require raw counts)
└── Raw microarray CEL / intensity files
    └── Out of scope. Reading them resolves a platform design package per array
        design, which cannot be staged for every design and cannot be installed.
        Report that and ask for the normalized expression matrix — every array
        platform publishes one, and it enters the branch above.
```

## Goal and Constraints

The goal is a differential expression (DE) table for the contrast that the step names. The design must support the test that you select.

- Give raw integer counts to DESeq2, edgeR, and voom. Each method normalizes the counts internally.
- Filter the low-count genes: keep the genes with >= 10 counts in >= n samples, where n is the size of the smallest group.
- Make sure that the library sizes are not very different before the DE test. An extreme outlier can control the result.
- If a batch is known, keep the batch as a term of the design, or correct it with ComBat_seq on the raw counts. Correct after the gene filter and before the DE test.
- Add the surrogate variables from svaseq to the design formula as covariates. Do not adjust the counts with them.
- Write the DE table as CSV with the columns gene, log2FoldChange, pvalue, padj, and baseMean (or logCPM).

## Contrast Specification

- PyDESeq2: `stat_res = ds.summary(contrast=["condition", "treated", "control"])`
- DESeq2 via rpy2: `results(dds, contrast=c("condition", "treated", "control"))` or use `resultsNames()` for coefficient-based.
- limma: Define contrast matrix with `makeContrasts()`. For interaction: `makeContrasts(groupB.time2 - groupA.time2 - groupB.time1 + groupA.time1, levels=design)`.
- edgeR: `glmQLFTest(fit, contrast=con)` with the same contrast matrix as limma.

## Anti-Patterns

- **A request to read raw CEL files**: The platform design packages are not staged, and the sandbox cannot install them. Ask for the normalized expression matrix.
- **Wrong contrast syntax across the rpy2 bridge**: PyDESeq2 uses `["factor", "numerator", "denominator"]`. DESeq2 via rpy2 uses `c("factor", "numerator", "denominator")`. If you mix the two forms, the result is a wrong comparison with no error.
- **Inferential DE without biological replication**: With one sample per group, there is no within-group variance to estimate. The edgeR statistics assume replication — a 1 vs 1 run produces confident-looking p-values with no inferential basis. Refuse the test. Report descriptive log2 fold changes only, state that no replication exists, and name the design that supports inference (n >= 2 per group, n >= 3 preferred).
- **DESeq2/PyDESeq2 on TPM/FPKM**: These methods model raw counts with a negative binomial distribution. Normalized values give invalid results. Use limma.
- **voom on normalized data**: voom expects raw counts (or logCPM from edgeR's `cpm()`). Log or TPM input gives incorrect precision weights.
- **Ignoring batch effects**: If samples ran in batches (days, lanes, plates), do a check with PCA. An uncorrected batch inflates false positives.
- **ComBat_seq without biological covariates**: If you omit the condition from `ComBat_seq(covar_mod=...)`, the correction removes real biological signal with the batch effect.
- **svaseq-corrected counts for DE**: Add the surrogate variables to the design. Do not adjust the count matrix.
- **Pre-filtering too aggressively**: A strict gene filter reduces power. Keep the genes expressed in at least the smallest group size.

## Additional Available Packages

- **xCell2** (R via rpy2): Cell-type deconvolution from bulk expression — 64+ cell-type scores. Reach for it when sample-level composition is wanted and no single-cell data exists to deconvolve against.

## References

API references for all supported packages:

- `references/pydeseq2-api.md` — Pure Python DESeq2 implementation (default for simple designs)
- `references/deseq2-rpy2-api.md` — R DESeq2 via rpy2 (complex designs, interaction terms, LRT)
- `references/edger-rpy2-api.md` — R edgeR via rpy2 (small sample sizes, QLF tests)
- `references/limma-rpy2-api.md` — R limma/voom via rpy2 (large samples, pre-normalized data, microarray)
- `references/sva-rpy2-api.md` — R sva via rpy2 (ComBat_seq batch correction, surrogate variables)
