---
name: dna-methylation
description: DNA methylation analysis — array (450K/EPIC), bisulfite-seq, DMP/DMR detection, clocks, deconvolution, and EWAS
version: 1.0.0
tags: [methylation, 450k, epic, bisulfite-seq, wgbs, rrbs, dmp, dmr]
---

# DNA Methylation Analysis

Comprehensive guidelines for methylation array processing, bisulfite sequencing analysis, differential methylation, epigenetic clocks, cell type deconvolution, and epigenome-wide association studies.

## Environment Constraint: Array Annotation Is Not Staged

**Read this before planning any array pipeline.** The analysis packages (`minfi`, `ChAMP`, `DMRcate`, `missMethyl`, `EpiDISH`, `methylclock`) are installed, but the Illumina **array manifest and annotation packages they depend on are not** — no `IlluminaHumanMethylation450kanno.*`, `IlluminaHumanMethylationEPICanno.*`, `IlluminaHumanMethylationEPICv2anno.*`, and no matching `*manifest` package. There is also no network egress, so they cannot be installed at runtime, and Bioconductor's `ExperimentHub`/`AnnotationHub` fetches fail even though those client packages are present.

What this means in practice:

| Step | Status |
|-|-|
| IDAT → RGChannelSet → normalized betas (`minfi`, `ChAMP`) | **Cannot run.** Requires the manifest package to decode probe addresses. |
| Genomic mapping / probe annotation (`mapToGenome()`, `getAnnotation()`) | **Cannot run.** Requires the anno package. |
| Array DMR calling (`DMRcate::cpg.annotate(datatype = "array")`) | **Cannot run.** Resolves probe coordinates from the anno package. |
| Deconvolution from an existing beta matrix (`EpiDISH`) | **Runs.** Self-contained references, no annotation dependency. |
| Epigenetic clocks (`methylclock`) | Runs on a beta matrix, but needs clock coefficients — see `references/methylclock-api.md`. |
| Bisulfite-seq (Bismark → `dmrseq` / `DSS`) | **Downstream only.** `dmrseq`/`DSS` run on a methylation/coverage matrix you already have. The upstream Bismark toolchain (Trim Galore, alignment, dedup, extraction) is not guaranteed in the sandbox — verify those binaries before planning a from-FASTQ run (see §2). |

**How to proceed**: verify the annotation package actually loads before building a pipeline around it. If it does not, say so plainly — name the missing package and the step it blocks — and then do the analysis the data *does* support. A beta or M-value matrix that arrives already processed (from GEO, a collaborator, or an upstream step) still supports DMP testing, deconvolution, clocks, and EWAS modelling; only the probe-to-genome annotation is missing, and results can be reported by CpG ID. Do not silently substitute a different array's annotation, and do not present an unannotated result as though it were annotated.

Everything below stays technically correct and applies as written if these packages are ever staged.

## Method-Selection Decision Tree

### 1. Array Data (Illumina 450K / EPIC / EPICv2)

```
IDAT files
  → minfi::read.metharray.exp() (R)
    → QC: detection p-values, sample-level QC (sex check, SNP probes)
      → Probe filtering: remove failed (p > 0.01), cross-reactive, SNP-at-CpG probes
        → Normalization:
          → Noob (default — background correction + dye-bias normalization)
          → SWAN (alternative — type I/II probe adjustment)
          → Functional normalization (for large cohorts with known technical variation)
            → Beta-values (0-1 scale) AND M-values (logit-transformed)
```

**Alternative pipeline (more automated)**:

```
IDAT files
  → ChAMP::champ.load() (R)
    → champ.filter() (cross-reactive, SNP, detection p-value)
      → champ.norm() with BMIQ (type I/II correction)
        → champ.DMP() → champ.DMR()
```

- minfi is preferred for flexibility; ChAMP for rapid exploratory analysis.
- ALWAYS verify the correct array annotation: 450K (`IlluminaHumanMethylation450kanno`) vs EPIC (`IlluminaHumanMethylationEPICanno`) vs EPICv2. Wrong annotation silently produces incorrect results. **None of these packages are staged here** — confirm the one you need loads before starting, and if it does not, report the blocker rather than falling back to another platform's annotation (see Environment Constraint above).

### 2. Bisulfite Sequencing (WGBS / RRBS)

The alignment stages below rely on the Bismark toolchain (Trim Galore, `bismark`,
`deduplicate_bismark`, `bismark_methylation_extractor`), which is **not guaranteed
to be installed** — confirm each binary is on `PATH` before building a from-FASTQ
pipeline, and if it is absent, report that and start from a coverage/methylation
matrix instead. The downstream DMR steps (`dmrseq`, `DSS`) run either way.

```
FASTQ files
  → Trim: Trim Galore (adapter + RRBS-specific trimming with --rrbs flag)
    → Alignment: Bismark (bowtie2 backend, bisulfite-aware)
      → Deduplication: Bismark deduplicate_bismark (skip for RRBS — no PCR dedup needed)
        → Methylation extraction: Bismark bismark_methylation_extractor
          → Coverage filtering: require >= 5x (WGBS) or >= 10x (RRBS) per CpG
            → Merge CpG strand information (combine + and - strand)
```

- WGBS provides genome-wide coverage; RRBS enriches for CpG islands.
- Coverage filtering is critical — low-coverage CpGs introduce noise. Remove CpGs below threshold before any analysis.

### 3. DMP Analysis (Differentially Methylated Positions)

```
Beta-values (for reporting) + M-values (for statistics)
  → Convert: M = log2(beta / (1 - beta))
    → Design matrix: model.matrix(~ group + covariates)
      → limma on M-values: lmFit → eBayes → topTable
        → Filter: padj < 0.05 AND abs(delta_beta) > 0.05
```

- **CRITICAL**: Run statistics on M-values, NOT beta-values. Beta-values have heteroscedasticity (variance depends on mean) which violates linear model assumptions. Report results using delta-beta for biological interpretation.
- A delta-beta threshold of 0.05 (5% methylation difference) filters statistically significant but biologically trivial changes.

### 4. DMR Detection (Differentially Methylated Regions)

```
From array data (limma results)
  → DMRcate (kernel smoothing, default)
    → cpg.annotate() from limma results → dmrcate() → extractRanges()
      → Minimum 3 CpGs per DMR, bandwidth 1000bp

From bisulfite-seq data (BSseq objects)
  → dmrseq (regression-based, preferred for BS-seq)
    → Filter low-coverage CpGs → dmrseq() with appropriate testCovariate
  → DSS (Bayesian, alternative)
    → DMLtest() → callDMR()
```

- DMRcate is the standard for array-based DMR calling. It takes limma results as input.
- dmrseq is preferred for BS-seq because it models spatial correlation between CpGs.

### 5. Methylation Clocks

```
Beta-values at specific CpG sets
  → methylclock package (R)
    → Horvath clock (353 CpGs, multi-tissue)
    → Hannum clock (71 CpGs, blood)
    → PhenoAge (513 CpGs, mortality-associated)
    → GrimAge (1030 CpGs, lifespan predictor)
```

- Clocks require specific CpG subsets — verify all required CpGs are present in the array platform.
- EPICv2 drops some CpGs present on 450K/EPIC. Check compatibility before applying clocks.

### 6. Cell Type Deconvolution

```
Blood samples
  → minfi::estimateCellCounts() (Houseman reference, default)
    → Returns proportions of CD8T, CD4T, NK, Bcell, Mono, Gran

Any tissue with reference
  → EpiDISH (more reference panels, RPC/CBS/CP methods)
    → epidish() with appropriate reference matrix
```

- **ALWAYS** perform cell type deconvolution for blood-based methylation studies. Cell composition is the strongest confounder in blood methylation data. Ignoring it produces false positives.
- Include estimated cell proportions as covariates in DMP/EWAS models.

### 7. EWAS (Epigenome-Wide Association Study)

```
M-values + phenotype + covariates
  → SVA: sva() or SmartSVA to estimate surrogate variables for hidden confounders
    → limma model: ~ trait + age + sex + cell_proportions + SVs
      → topTable with BH FDR correction
        → Annotate results with gene/CpG island context
```

- Include age, sex, estimated cell proportions, and surrogate variables as covariates.
- SVA captures technical batch effects and unknown biological confounders.

## Anti-Patterns

- **Statistics on beta-values**: Do NOT run limma, t-tests, or regression on beta-values. Beta-values are heteroscedastic. Use M-values for all statistical testing; report delta-beta for biological interpretation.
- **Wrong array annotation**: Do NOT use 450K annotation manifests for EPIC data or vice versa. EPICv2 has a different probe set from EPIC v1. Mismatched annotations silently corrupt results.
- **Not filtering cross-reactive probes**: Do NOT skip cross-reactive probe removal. ~6% of 450K probes and ~5% of EPIC probes map to multiple genomic locations. Published lists (Chen 2013, Pidsley 2016, Peters 2024) must be applied.
- **Not filtering SNP probes**: Do NOT retain probes with known SNPs at the CpG site or single-base extension. These create artifactual methylation differences driven by genotype, not epigenetic state.
- **Ignoring cell composition in blood**: Do NOT analyze blood methylation data without adjusting for cell type proportions. Cell composition differences between groups drive the majority of apparent methylation differences.
- **Deduplicating RRBS**: Do NOT run PCR deduplication on RRBS data. RRBS uses restriction enzyme digestion, so identical fragment positions are expected. Deduplication removes real signal.
- **Low coverage CpGs in BS-seq**: Do NOT include CpGs with <5x coverage in statistical analyses. Low-coverage estimates are noisy and introduce false discoveries.

## Output Conventions

- Methylation matrices: AnnData (.h5ad) with CpGs as `var`, samples as `obs`, beta-values as `X`, M-values in a layer.
- DMP results: CSV with `cpg_id`, `chromosome`, `position`, `gene`, `delta_beta`, `logFC_M`, `pvalue`, `padj`.
- DMR results: CSV with `chr`, `start`, `end`, `n_cpgs`, `mean_delta_beta`, `pvalue`, `padj`, `overlapping_genes`.
- Figures: density plots of beta distributions, volcano plots (delta-beta vs -log10 p), DMR genome browser tracks, cell proportion bar plots.
- Clock results: table of predicted ages per sample with clock name and residuals.

## Additional Available Packages

- **missMethyl** (R): GO and pathway testing for methylation data. CRITICAL — adjusts for the probe-number bias (genes with more CpG probes are more likely to appear significant). Use `gometh()` / `gsameth()` instead of standard enrichment tools when input is a list of CpG sites or DMPs.

## References

- `references/minfi-api.md` — IDAT loading, normalization, QC, and cell deconvolution
- `references/champ-api.md` — ChAMP automated pipeline for array methylation
- `references/dmrcate-api.md` — DMR detection from limma results
- `references/epidish-api.md` — EpiDISH cell type deconvolution (RPC/CBS/CP methods, reference panels, CellDMC)
- `references/methylclock-api.md` — Epigenetic age prediction (Horvath, Hannum, PhenoAge, GrimAge clocks)
