# DMRcate API Reference

Detects differentially methylated regions (DMRs) from Illumina methylation array data using kernel smoothing on limma-derived per-CpG statistics. Takes limma model output, applies a Gaussian kernel to smooth test statistics across genomic coordinates, and segments the genome into DMRs.

## Setup

> **The array path through DMRcate cannot run here.** Two separate dependencies are missing:
>
> - **Array annotation packages are not staged.** `cpg.annotate(datatype = "array")` resolves each probe's genomic coordinates from the platform's `IlluminaHumanMethylation*anno.*` package (selected by `arraytype`). No such package is installed and there is no egress to install one, so the call errors out. `arraytype` cannot be set to something available — every value maps to an absent package.
> - **`DMRcatedata` is fetched over the network.** `rmSNPandCH()` and `extractRanges()` both pull their supporting data (SNP/cross-hybridising probe lists; gene annotation) from `DMRcatedata` via ExperimentHub, which reaches Bioconductor's servers. With no egress they fail unless ExperimentHub is pointed at an already-populated local cache and opened with `localHub = TRUE`.
>
> **Verify before you build**: check that the annotation package for your platform loads. If it does not, report the blocker plainly — name the package and the step — and do not fake it with another platform's annotation. The `datatype = "sequencing"` path is unaffected by the annotation gap, and for bisulfite data `dmrseq` or `DSS` are better choices anyway.
>
> Everything below is correct as written and applies unchanged once these are staged.

```r
library(DMRcate)
library(limma)
library(minfi)
```

## Full Pipeline: limma to DMRcate

### Step 1: Prepare Design Matrix

```r
# group: factor vector of sample conditions (e.g., "Tumor", "Normal")
group <- factor(pheno$condition, levels = c("Normal", "Tumor"))

# Intercept-free design: each group gets its own coefficient
design <- model.matrix(~0 + group)
colnames(design) <- levels(group)

# Define contrast: Tumor vs Normal (positive = hypermethylated in Tumor)
cont_matrix <- makeContrasts(
  TumorVsNormal = Tumor - Normal,
  levels = design
)
```

### Step 2: Fit limma Model on M-values

```r
# m_values: matrix of M-values (logit-transformed beta), CpGs as rows, samples as columns
# M = log2(beta / (1 - beta))
# If you have a GenomicRatioSet from minfi:
#   m_values <- getM(grset)
#   beta_values <- getBeta(grset)

fit <- lmFit(m_values, design)
fit2 <- contrasts.fit(fit, cont_matrix)
fit2 <- eBayes(fit2)
```

### Step 3: cpg.annotate() — Create CpGannotated Object

Annotates each CpG with genomic coordinates, test statistics, and significance from the limma fit.

**With `datatype = "array"` this needs the annotation package named by `arraytype`, which is not staged here** (see Setup) — the call errors before any smoothing. Confirm the package loads first; if it does not, report which one is missing and that array DMR calling is blocked.

```r
cpg_annotated <- cpg.annotate(
  datatype = "array",         # "array" for Illumina arrays, "sequencing" for BS-seq
  object = m_values,          # matrix — M-values (CpGs x samples)
  what = "M",                 # "M" for M-values, "Beta" for beta-values (M recommended)
  arraytype = "EPIC",         # "EPIC"|"450K" — must match your array platform
  analysis.type = "differential",  # "differential" for group comparison, "variability" for DVPs
  design = design,            # design matrix from model.matrix()
  contrasts = TRUE,           # logical — TRUE when using a contrast matrix
  cont.matrix = cont_matrix,  # contrast matrix from makeContrasts()
  coef = 1,                   # int — which column of cont.matrix to test (1-indexed)
  fdr = 0.05                  # numeric — FDR threshold for individual CpG significance
)

# Inspect: number of significant CpGs
cpg_annotated
```

### Step 4: dmrcate() — Find DMRs

Applies Gaussian kernel smoothing to limma statistics across the genome and identifies regions where smoothed values exceed the significance threshold.

```r
dmr_results <- dmrcate(
  cpg_annotated,
  lambda = 1000,        # int — Gaussian kernel bandwidth in base pairs (default 1000)
  C = 2,                # int — scaling factor for bandwidth (default 2); higher = faster, less sensitive
  min.cpgs = 3,         # int — minimum CpGs per DMR (default 2; recommend >= 3)
  pcutoff = "fdr"       # "fdr" to use FDR-corrected p-values, or numeric (e.g., 0.05) for raw
)
```

### Step 5: extractRanges() — Get Genomic Coordinates

Converts DMR results to a GRanges object with genomic coordinates, statistics, and gene annotations.

**This call fetches over the network and fails here.** `extractRanges()` resolves its gene annotation from the `DMRcatedata` package via ExperimentHub, which reaches Bioconductor's servers; there is no egress and no runtime install, so it errors on first use unless ExperimentHub is pointed at an already-populated local cache and opened with `localHub = TRUE` (same pattern as the methylclock reference). If no such cache is available, report it, and deliver the DMR table from `dmrcate()` — coordinates and statistics are complete without the gene overlay. Do not invent a cache path and do not drop the annotation step silently.

```r
dmr_ranges <- extractRanges(
  dmr_results,
  genome = "hg38"       # "hg38"|"hg19"|"mm10" — genome build for annotation
)

# dmr_ranges is a GRanges object with metadata columns:
#   seqnames           — chromosome
#   start              — DMR start position
#   end                — DMR end position
#   width              — DMR width in base pairs
#   no.cpgs            — number of CpGs in the DMR
#   min_smoothed_fdr   — minimum smoothed FDR across the region
#   Stouffer           — Stouffer combined p-value for CpGs in DMR
#   HMFDR              — harmonic mean FDR
#   Fisher             — Fisher combined p-value
#   maxdiff            — maximum mean methylation difference (beta scale) across CpGs
#   meandiff           — mean methylation difference (beta scale) across CpGs
#   overlapping.genes  — genes overlapping the DMR (comma-separated)

# View top DMRs
as.data.frame(dmr_ranges)
```

## Removing SNP and Cross-Reactive Probes

Filter problematic probes before analysis. Should be applied early (before limma fitting).

`rmSNPandCH()` operates on a **matrix**, not on a minfi object: it takes a matrix of M-values with Illumina probe IDs as rownames and returns the same matrix with the offending rows dropped. So extract M-values from the `GenomicRatioSet` first, then filter — not the other way round.

```r
# grset: GenomicRatioSet from minfi preprocessing

# Step 1 — extract the M-value matrix (probe IDs become rownames)
m_values <- getM(grset)

# Step 2 — drop SNP-affected and cross-hybridizing probes from the matrix
m_values <- rmSNPandCH(
  m_values,             # matrix — M-values, unique Illumina probe IDs as rownames
  dist = 2,             # int — distance in bp from CpG to exclude SNP-affected probes (default 2)
  mafcut = 0.05,        # numeric — minor allele frequency cutoff (default 0.05)
  and = TRUE,           # logical — TRUE filters probes meeting BOTH dist and mafcut; FALSE, either
  rmcrosshyb = TRUE,    # logical — remove cross-hybridizing probes (default TRUE)
  rmXY = FALSE          # logical — remove probes on X and Y chromosomes (default FALSE)
)
# Returns: a matrix with the same columns and fewer rows than the input

# m_values now feeds lmFit() and cpg.annotate() directly
```

To keep a filtered `GenomicRatioSet` as well (for example to derive matching beta-values), subset the object by the surviving probe IDs rather than passing it to `rmSNPandCH()`:

```r
grset_filtered <- grset[rownames(m_values), ]
beta_values <- getBeta(grset_filtered)
```

## With Covariates (Age, Sex, Cell Type)

Include biological and technical covariates in the design matrix. Covariates are modeled by limma; DMRcate inherits the adjusted statistics.

```r
# Include covariates in the design matrix
design <- model.matrix(~0 + group + age + sex + CD8T + CD4T + NK + Bcell + Mono,
                       data = pheno)
colnames(design)[1:length(levels(group))] <- levels(group)

# Contrast is unchanged — covariates are adjusted for, not contrasted
cont_matrix <- makeContrasts(
  TumorVsNormal = Tumor - Normal,
  levels = design
)

# Proceed with limma fit as before
fit <- lmFit(m_values, design)
fit2 <- contrasts.fit(fit, cont_matrix)
fit2 <- eBayes(fit2)

# cpg.annotate picks up the covariate-adjusted statistics
cpg_annotated <- cpg.annotate(
  datatype = "array",
  object = m_values,
  what = "M",
  arraytype = "EPIC",
  analysis.type = "differential",
  design = design,
  contrasts = TRUE,
  cont.matrix = cont_matrix,
  coef = 1,
  fdr = 0.05
)
```

## Complete Working Example

End-to-end pipeline from a normalized GenomicRatioSet to DMR results.

```r
library(DMRcate)
library(limma)
library(minfi)

# --- Load data ---
# grset: GenomicRatioSet from minfi (already normalized, e.g., via preprocessNoob or preprocessFunnorm)
# pheno: data.frame with sample metadata including "condition" column

# --- Extract M-values, then filter probes (rmSNPandCH takes the matrix) ---
m_values <- getM(grset)
m_values <- rmSNPandCH(m_values, dist = 2, mafcut = 0.05, rmcrosshyb = TRUE, rmXY = FALSE)

# --- Design matrix ---
group <- factor(pheno$condition, levels = c("Normal", "Tumor"))
design <- model.matrix(~0 + group)
colnames(design) <- levels(group)

cont_matrix <- makeContrasts(
  TumorVsNormal = Tumor - Normal,
  levels = design
)

# --- limma ---
fit <- lmFit(m_values, design)
fit2 <- contrasts.fit(fit, cont_matrix)
fit2 <- eBayes(fit2)

# --- DMRcate ---
cpg_annotated <- cpg.annotate(
  datatype = "array",
  object = m_values,
  what = "M",
  arraytype = "EPIC",
  analysis.type = "differential",
  design = design,
  contrasts = TRUE,
  cont.matrix = cont_matrix,
  coef = 1,
  fdr = 0.05
)

dmr_results <- dmrcate(
  cpg_annotated,
  lambda = 1000,
  C = 2,
  min.cpgs = 3,
  pcutoff = "fdr"
)

dmr_ranges <- extractRanges(dmr_results, genome = "hg38")

# --- Inspect results ---
cat("Number of DMRs:", length(dmr_ranges), "\n")
head(as.data.frame(dmr_ranges))
```

## Saving Results

```r
# Convert GRanges to data.frame for CSV export
dmr_df <- as.data.frame(dmr_ranges)

# Write DMR table
write.csv(dmr_df, "output/dmr_results.csv", row.names = FALSE)

# Write individual CpG statistics from limma (useful for DMP analysis alongside DMRs)
dmp_table <- topTable(fit2, coef = 1, number = Inf, sort.by = "none")
write.csv(dmp_table, "output/dmp_results.csv", row.names = TRUE)
```

## Gotchas

- **Use M-values for limma, not beta-values.** Beta-values are heteroscedastic (variance depends on mean), violating linear model assumptions. M-values (`log2(beta / (1 - beta))`) are approximately homoscedastic. Report results using delta-beta (from `meandiff`/`maxdiff`) for biological interpretation.
- **`lambda` parameter**: Gaussian kernel bandwidth in base pairs. Default 1000. Larger values merge nearby CpGs more aggressively into single DMRs. Smaller values find tighter, more localized regions. 1000 is standard for array data.
- **`min.cpgs` default is 2 — too lenient.** A DMR supported by only 2 CpGs is unreliable. Use `min.cpgs = 3` or higher to reduce false positives.
- **`arraytype` must match your data.** `"450K"` for HumanMethylation450, `"EPIC"` for MethylationEPIC. Wrong array type silently produces incorrect genomic annotations and probe filtering. EPICv2 is not yet natively supported in all DMRcate versions — check the package version. Note that in this environment **no** `arraytype` value resolves to an installed annotation package, so this is a blocker rather than a choice (see Setup).
- **Genome build consistency.** `extractRanges(genome = "hg38")` must match the genome your data was aligned/annotated against. Mixing hg19 probes with hg38 extraction produces wrong coordinates.
- **`coef` is 1-indexed and refers to contrast matrix columns.** `coef = 1` tests the first contrast in `cont.matrix`. If you have multiple contrasts, specify the correct column index.
- **`C` parameter trades sensitivity for speed.** `C = 2` (default) is a good balance. Higher values make the kernel narrower, speeding computation but potentially splitting real DMRs. For exploratory analysis, keep `C = 2`.
- **Direction interpretation.** Positive `meandiff`/`maxdiff` = hypermethylated in the **numerator** of the contrast (e.g., if contrast is `Tumor - Normal`, positive means hypermethylated in Tumor). Negative = hypomethylated in the numerator.
- **Large datasets and memory.** Kernel smoothing on 850K+ probes (EPIC) can be slow and memory-intensive. The `C` parameter controls this — higher values reduce compute at the cost of sensitivity. Ensure sufficient memory allocation.
- **`pcutoff = "fdr"` vs numeric.** `"fdr"` uses BH-corrected p-values from the limma model. A numeric value (e.g., `0.05`) applies to raw p-values. Always prefer `"fdr"` to control false discovery rate.
- **Probe filtering order matters.** Remove SNP-affected and cross-reactive probes BEFORE fitting the limma model and running `cpg.annotate()`. Filtering after fitting does not remove their influence on model estimates.
- **`rmSNPandCH()` takes a matrix, not a GenomicRatioSet.** Its input is a matrix of M-values with unique Illumina probe IDs as rownames, and it returns a matrix with the offending rows removed. Call `getM(grset)` **first**, then filter the resulting matrix — passing the `GenomicRatioSet` itself errors, and calling `getM()` on the return value of `rmSNPandCH()` is calling it on a plain matrix. To keep a matching filtered object, subset by the surviving probe IDs: `grset[rownames(m_values), ]`.
- **`rmSNPandCH()` also needs `DMRcatedata`.** The SNP and cross-hybridising probe lists come from `DMRcatedata` via ExperimentHub, so this call hits the same network blocker as `extractRanges()`. If no populated local cache is available, report it and apply published probe filter lists (Chen 2013, Pidsley 2016, Peters 2024) against the matrix rownames instead — do not skip probe filtering silently.
