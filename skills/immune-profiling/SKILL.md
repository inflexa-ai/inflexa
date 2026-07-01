---
name: immune-profiling
description: Immune cell deconvolution, immune signature scoring, checkpoint expression panels, TCR/BCR repertoire analysis, tumor microenvironment characterization, and IO response prediction
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
     - CIBERSORTx: gold standard but requires registration/license.
       If available in sandbox packages, preferred for high-resolution
       (22 immune subsets via LM22).
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
     decoupler `run_ulm` / `run_mlm` with custom gene sets.

4. **Checkpoint expression analysis**
   - Extract and visualize expression of immune checkpoint genes across
     conditions, cell types, or treatment groups.
   - **Core checkpoint panel**: PDCD1 (PD-1), CD274 (PD-L1), PDCD1LG2
     (PD-L2), CTLA4, LAG3, HAVCR2 (TIM-3), TIGIT, TNFRSF9 (4-1BB),
     TNFRSF4 (OX40), ICOS, IDO1, VSIR (VISTA).
   - Report as heatmap (samples x checkpoints) with condition
     annotation.

5. **TCR/BCR repertoire analysis**
   - When TCR or BCR data is available (10x VDJ, AIRR-seq):
     - Clonality: Shannon entropy, Gini index, clonal proportion.
     - Diversity: species richness, Simpson's index, Chao1.
     - Clonal expansion: fraction of top-N clonotypes.
     - Repertoire overlap: Jaccard/Morisita-Horn between samples.
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

When immune profiling is part of a translational analysis:

### Immune Phenotypes
| Phenotype | Signature | Clinical Implication |
|-----------|-----------|---------------------|
| Immune-hot (inflamed) | High TIS, high CD8, high IFN-g | Best IO response, checkpoint blockade candidate |
| Immune-excluded | High immune scores at margin, low intratumoral | May need combination therapy |
| Immune-desert (cold) | Low TIS, low CD8, low IFN-g | Poor IO candidate, consider priming strategies |

### Integrated TME Assessment
1. Run immune deconvolution (cell fractions)
2. Score immune signatures (TIS, IFN-g, CYT)
3. Assess checkpoint expression levels
4. Classify TME phenotype
5. Report with clinical IO context

## Analysis Integration Patterns

### With Differential Expression
When DE results are available from upstream steps:
- Overlay immune cell proportions on DE volcano plots
- Test whether immune infiltration correlates with DE gene modules
- Use immune cell fractions as covariates in DE to control for
  composition effects

### With Survival / Clinical Outcomes
- Stratify patients by immune cell proportions or signature scores
- Kaplan-Meier by high/low immune infiltration (median split or
  optimal cutpoint)
- Multivariate Cox including immune scores alongside clinical
  covariates

### With Drug Response
- Compare immune profiles between responders and non-responders
- Test whether baseline immune state predicts treatment response
- Assess on-treatment immune modulation (paired pre/post)

## References

| Reference | File | Contents |
|-----------|------|----------|
| Immune Deconvolution | `references/immune-deconvolution.md` | immunedeconv R wrapper, MCP-counter, xCell, EPIC, quanTIseq API patterns, bulk deconvolution workflow, comparison across methods |
| Immune Signatures | `references/immune-signatures.md` | TIS, IFN-g, CYT, exhaustion signature gene lists, ssGSEA/decoupler scoring, checkpoint heatmaps, TCR diversity metrics |

## Do NOT

- Report deconvolution fractions as absolute cell counts — they are
  relative proportions or enrichment scores, depending on the method
- Use a single deconvolution method without cross-validation against
  at least one other
- Apply CIBERSORTx LM22 reference to non-human data — species-specific
  references are required
- Interpret immune signatures as causal — "associated with IO
  response" not "predicts IO response" unless validated in the
  specific tumor type
- Classify TME phenotype from gene expression alone without noting
  that histological/spatial validation is the gold standard
- Assume all immune infiltration is anti-tumor — Tregs, M2
  macrophages, and MDSCs are immunosuppressive
- Score immune signatures without checking that the signature genes
  are actually expressed in the dataset
