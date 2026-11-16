---
name: immune-profiling
description: Read before you estimate immune cell composition, score immune signatures, compare checkpoint genes, classify the tumor microenvironment, or analyze TCR or BCR repertoires. It tells which deconvolution methods are available, what their output means, and the statistics for many immune scores.
metadata:
  version: 1.0.0
  tags: [immunology, immuno-oncology, deconvolution, immune-signatures, TME, checkpoint, TCR, BCR, IO-response]
---

# Immune Profiling

This skill guides immune cell quantification, immune signature
assessment, and tumor microenvironment characterization from omics
data. Applicable to both bulk and single-cell modalities.

## Method Selection Decision Tree

Choose the method based on input data and analytical goal:

1. **Immune cell composition from bulk expression**
   - Use deconvolution to estimate immune cell fractions from bulk
     RNA-seq or microarray. See `references/immune-deconvolution.md`
     for API patterns and method selection.
   - **Method selection**:
     - MCP-counter: robust marker-based scores (not fractions). Best
       for comparing across samples. Fast, no reference required.
     - xCell: enrichment-based, 64 cell types including stroma. Good
       for broad profiling. Returns enrichment scores, not fractions.
     - EPIC: constrained least squares. Returns absolute fractions
       that sum to 1. Includes "other cells" category.
     - quanTIseq: designed for tumor deconvolution. Returns absolute
       fractions. Includes 10 immune cell types.
     - CIBERSORTx: **not available here.** Its source and the LM22
       signature matrix are distributed only through a registered,
       licensed download from the Alizadeh lab site, which needs both
       an account and network egress. `immunedeconv` exposes a
       `cibersort` method, but it errors unless you have already
       placed those licensed files on disk. Do not plan around it and
       do not report it as attempted — pick from the methods above.
   - **When to use multiple methods**: Always run at least 2 methods
     and compare. Concordant results across methods strengthen
     conclusions. Report discordances.

2. **Immune cell composition from single-cell**
   - Cell type annotation is the primary method — no deconvolution
     needed. Use canonical immune markers for annotation.
   - For pseudobulk comparison: aggregate single-cell data by sample,
     compute cell type proportions, then compare across conditions.
   - For cell state analysis: subclustering within immune populations
     (e.g., CD8+ T cell exhaustion states).

3. **Immune signature scoring**
   - Score samples for curated immune gene signatures. See
     `references/immune-signatures.md` for signature definitions
     and scoring methods.
   - **Key signatures**:
     - Tumor Inflammation Signature (TIS, 18-gene): IO response
       predictor validated across tumor types.
     - Interferon-gamma signature (IFN-g, 6 or 10-gene): immune
       activation, IO response predictor.
     - Cytolytic activity (CYT): geometric mean of GZMA and PRF1.
       Simple, robust, widely used.
     - Immunoscore-like: CD3/CD8 density proxy from gene expression.
     - T cell exhaustion: LAG3, HAVCR2 (TIM-3), PDCD1 (PD-1), TIGIT,
       CTLA4 co-expression.
   - **Scoring methods**: ssGSEA (per-sample), mean z-score, or
     decoupler `dc.mt.ulm` / `dc.mt.mlm` with custom gene sets. Lower
     decoupler's `tmin` (default 5) to the length of your shortest
     signature, or short ones are dropped without an error — CYT is
     2 genes, so `tmin=2`.

4. **Checkpoint expression analysis**
   - Compare the expression of the immune checkpoint genes across
     conditions, cell types, or treatment groups.

5. **TCR/BCR repertoire analysis**
   - Repertoire work goes through **scirpy** — it reads 10x VDJ and AIRR
     files, pairs chains, and calls clonotypes by CDR3 distance. Clonotype
     counts do not exist until it has run, so start there, not at the metrics.
   - It covers clonal expansion, alpha diversity (normalized Shannon, D50)
     and pairwise repertoire overlap. Simpson, Gini and Morisita-Horn it does
     not — compute those from the clonotype counts it produces.
   - For scRNA-seq with VDJ: link clonotype to cell phenotype
     (exhaustion, activation, memory markers).

## Immune Cell Canonical Markers

Use for annotation and validation of deconvolution results:

| Cell Type | Key Markers |
|-----------|------------|
| CD8+ T cells | CD8A, CD8B, GZMB, PRF1 |
| CD4+ T cells | CD4, IL7R, FOXP3 (Treg) |
| Tregs | FOXP3, IL2RA (CD25), CTLA4 |
| NK cells | NCAM1 (CD56), NKG7, GNLY, KLRD1 |
| B cells | CD19, MS4A1 (CD20), CD79A |
| Plasma cells | SDC1 (CD138), IGHG1, MZB1 |
| Monocytes | CD14, FCGR3A (CD16), CSF1R |
| M1 macrophages | NOS2, TNF, IL1B, CD80 |
| M2 macrophages | MRC1 (CD206), CD163, MSR1, ARG1 |
| cDC1 | CLEC9A, XCR1, BATF3 |
| cDC2 | CD1C, FCER1A, CLEC10A |
| pDC | CLEC4C, IL3RA, IRF7 |
| Neutrophils | FCGR3B, CXCR2, CSF3R |
| Mast cells | KIT, CPA3, TPSAB1 |

## Tumor Microenvironment (TME) Classification

A hot, excluded, or desert TME call comes from the deconvolution, the
signature scores (TIS, IFN-g, CYT), and the checkpoint expression
together. Say that a call from expression alone has no histological or
spatial confirmation.

## Statistics

- **Multiplicity over immune scores**: One run yields 10 to 64
  cell-type or signature scores. Correct every score-by-condition
  comparison (t-test, Wilcoxon, correlation) with Benjamini-Hochberg
  FDR across the full set of scores. Report q-values, not raw
  p-values.
- **Survival cutpoints**: The nominal log-rank p-value of an optimal
  cutpoint has no meaning — the scan over candidate cutpoints
  inflates it. Report the maxstat corrected p-value. A median split
  is pre-specified, and no correction is necessary. The
  `statistical-modeling` skill carries the full rule and the
  `surv_cutpoint` API pattern.
- **Cox models**: Include clinical covariates. Do a check of the
  proportional-hazards assumption, and apply the failure path that
  the `statistical-modeling` skill states.

## References

| Reference | File | Contents |
|-----------|------|----------|
| Immune Deconvolution | `references/immune-deconvolution.md` | immunedeconv R wrapper, MCP-counter, xCell, EPIC, quanTIseq API patterns, bulk deconvolution workflow, comparison across methods |
| Immune Signatures | `references/immune-signatures.md` | TIS, IFN-g, CYT, exhaustion signature gene lists, ssGSEA/decoupler scoring, checkpoint heatmaps, TCR diversity metrics |

## Anti-Patterns

- **A CIBERSORTx plan**: Its source and the LM22 matrix are available
  only through a licensed download over the network. The `cibersort` method of `immunedeconv`
  fails without them. Do not report it as attempted.
- **The default `tmin` of decoupler on a short signature**: The default
  is 5, and decoupler drops a shorter set with no error. Set `tmin` to
  the length of the shortest signature (CYT: `tmin=2`).
- **Deconvolution scores reported as fractions**: MCP-counter and xCell
  give scores. Only EPIC and quanTIseq give fractions. No method gives
  absolute cell counts.
- **One deconvolution method alone**: Compare with at least one other
  method, and report the discordances.
- **The nominal p-value of an optimized survival cutpoint**: Only the
  maxstat corrected p-value has meaning.
- **Immune scores compared across conditions without BH FDR over the
  full score set**.
- **Signature scores without an expression check**: Make sure that the
  signature genes are expressed in the dataset.
- **All infiltration as anti-tumor**: Tregs, M2 macrophages, and MDSCs
  are immunosuppressive.
- **Immune signatures as causal**: Write "associated with IO response",
  not "predicts IO response", unless a study validated it in that tumor
  type.
