# minfi API Reference

Illumina methylation array analysis (450K, EPIC, EPICv2) in R/Bioconductor. Covers IDAT loading, preprocessing, normalization, QC, DMP detection, cell type deconvolution, and annotation access.

## Setup

> **The array annotation and manifest packages are not staged here, and the IDAT pipeline below cannot run without them.** `minfi` itself is installed, but every `IlluminaHumanMethylation*manifest` and `IlluminaHumanMethylation*anno.*` package is absent, and there is no network egress to install one. `read.metharray.exp()` needs the *manifest* package to decode probe addresses from the IDATs; `mapToGenome()` and `getAnnotation()` need the *anno* package for coordinates and gene context. Both fail with a package-not-found error at the first call, before any data is read.
>
> **Verify before you build**: check that the annotation package for your platform loads. If it does not, report plainly which package is missing and that IDAT processing is blocked — then proceed with whatever the data supports. If a normalized beta or M-value matrix is available from another source, the DMP, deconvolution, clock, and EWAS sections of this pack still apply; results are reported by CpG ID without genomic annotation. Never substitute a different platform's annotation to get past the error.
>
> The rest of this reference is correct as written and applies unchanged if these packages are staged.

```r
library(minfi)
library(IlluminaHumanMethylationEPICanno.ilm10b4.hg19)  # EPIC v1
# library(IlluminaHumanMethylation450kanno.ilmn12.hg19)  # 450K
# library(IlluminaHumanMethylationEPICv2anno.20a1.hg38)  # EPICv2
library(limma)
```

## Loading IDAT Files

### read.metharray.sheet()

Parse a sample sheet CSV to locate IDAT files. The sheet must have `Sentrix_ID` and `Sentrix_Position` columns (or `Array` and `Slide`). A `basename` column is constructed automatically.

```r
# base_dir: directory containing IDAT files and the sample sheet
targets <- read.metharray.sheet(
  base = "data/idats",         # character — directory containing IDATs + sample sheet
  pattern = "SampleSheet.csv"  # character — filename pattern for the sample sheet
)

# targets is a data.frame with one row per sample
# Required columns: Sentrix_ID, Sentrix_Position (or Array, Slide)
# Optional columns: Sample_Name, Sample_Group, etc.
# The basename column points to the IDAT file prefix (without _Grn.idat / _Red.idat)
```

### read.metharray.exp()

Read IDAT files into an RGChannelSet (raw red/green intensities).

```r
# From a sample sheet (preferred)
rgset <- read.metharray.exp(targets = targets)

# From a directory of IDATs (auto-discovers all samples)
rgset <- read.metharray.exp(base = "data/idats")

# Optionally force a specific array type
rgset <- read.metharray.exp(targets = targets, force = TRUE)
```

`rgset` is an `RGChannelSet` — the raw starting point for all downstream processing.

## Preprocessing and Normalization

All preprocessors take an `RGChannelSet` and return a `MethylSet` or `GenomicRatioSet`. Choose one normalization method per analysis.

### preprocessNoob() — Recommended Default

Normal-exponential out-of-band (Noob) background correction with dye-bias normalization. Good general-purpose method for most study designs.

```r
mset <- preprocessNoob(
  rgset,                   # RGChannelSet
  offset = 15,             # numeric — offset added to intensities (default 15)
  dyeCorr = TRUE,          # logical — perform dye-bias correction (default TRUE)
  dyeMethod = "single"     # "single"|"reference" — dye correction method
)
# Returns a MethylSet
```

### preprocessSWAN()

Subset-quantile Within Array Normalization. Adjusts for type I vs type II probe design differences.

```r
mset_swan <- preprocessSWAN(
  rgset,                   # RGChannelSet
  mSet = NULL              # optional MethylSet (if pre-processed)
)
# Returns a MethylSet
```

### preprocessQuantile()

Quantile normalization on methylated and unmethylated channels separately. Aggressive — best when samples are expected to have similar global methylation.

```r
grset <- preprocessQuantile(
  rgset,                   # RGChannelSet
  fixOutliers = TRUE,      # logical — fix outlier values
  removeBadSamples = FALSE,# logical — remove samples failing QC
  quantileNormalize = TRUE,# logical — apply quantile normalization
  stratified = TRUE,       # logical — stratify by region type
  sex = NULL               # character vector — "M"/"F" per sample, or NULL to predict
)
# Returns a GenomicRatioSet (already mapped to genome)
```

### preprocessFunnorm() — Large Cohorts

Functional normalization. Uses control probes to remove unwanted technical variation. Best for large cohorts (n > 100) or when significant batch effects are expected.

```r
grset <- preprocessFunnorm(
  rgset,                   # RGChannelSet
  nPCs = 2,                # integer — number of principal components to use
  sex = NULL,              # character vector or NULL to predict
  bgCorr = TRUE,           # logical — apply background correction first
  dyeCorr = TRUE,          # logical — apply dye-bias correction
  keepCN = TRUE            # logical — keep copy number estimates
)
# Returns a GenomicRatioSet (already mapped to genome)
```

### ratioConvert() and mapToGenome()

Convert a MethylSet to ratios and map to genomic coordinates. Required after preprocessNoob/preprocessSWAN, which return a MethylSet.

```r
# Convert MethylSet to RatioSet (beta and M values)
rset <- ratioConvert(mset, what = "both", keepCN = TRUE)

# Map to genome coordinates (adds chr, pos, strand to features)
grset <- mapToGenome(rset)

# Or combine: MethylSet -> GenomicRatioSet in one step
grset <- mapToGenome(ratioConvert(mset))
```

## Extracting Beta and M Values

Beta values range 0-1 (proportion methylated). M values are log2(beta / (1 - beta)). Use M values for statistics (homoscedastic), beta values for reporting and visualization.

```r
# Beta values — for reporting, visualization, biological interpretation
beta <- getBeta(grset)
# matrix: CpGs as rows, samples as columns, values in [0, 1]

# M values — for statistical testing (limma, t-tests, regression)
mvals <- getM(grset)
# matrix: CpGs as rows, samples as columns, logit-transformed

# From a MethylSet (before mapToGenome)
beta <- getBeta(mset)
mvals <- getM(mset)
```

## Quality Control

### Detection P-values

Per-probe, per-sample detection p-values. A probe with p > 0.01 failed detection in that sample.

```r
detp <- detectionP(rgset)
# matrix: CpGs as rows, samples as columns, p-values

# Flag failed probes (p > 0.01)
failed <- detp > 0.01

# Remove samples with >5% failed probes
keep_samples <- colMeans(failed) < 0.05
rgset <- rgset[, keep_samples]

# Remove probes that failed in >5% of samples
keep_probes <- rowMeans(failed[, keep_samples]) < 0.05
```

### qcReport()

Generate a PDF QC report with density plots, control probe summaries, and sample-level metrics.

```r
qcReport(
  rgset,                      # RGChannelSet
  sampNames = targets$Sample_Name,  # character vector — sample labels
  sampGroups = targets$Sample_Group, # character vector — group labels for coloring
  pdf = "output/qc_report.pdf"      # character — output PDF path
)
```

### getQC()

Extract sample-level QC metrics (median methylated and unmethylated intensities).

```r
mset_raw <- preprocessRaw(rgset)
qc <- getQC(mset_raw)
# DataFrame with mMed (median methylated) and uMed (median unmethylated) per sample

# Plot QC — samples in lower-left corner are poor quality
png("figures/qc_plot.png", width = 800, height = 600, res = 150)
plotQC(qc)
dev.off()

# Identify bad samples (low signal)
bad_samples <- rownames(qc)[qc$mMed < 10.5 | qc$uMed < 10.5]
```

## DMP Detection with dmpFinder()

Basic DMP detection built into minfi. For full analysis with covariates and empirical Bayes moderation, use limma on M values instead.

```r
# Simple two-group comparison
pheno <- targets$Sample_Group  # character or factor — group labels

# On beta values (type = "categorical" for groups)
dmps_beta <- dmpFinder(
  getBeta(grset),          # matrix — beta or M values
  pheno = pheno,           # vector — group labels or continuous variable
  type = "categorical"     # "categorical" | "continuous"
)
# Returns data.frame sorted by p-value with intercept, f, pval, qval columns

# Filter significant DMPs
sig_dmps <- dmps_beta[dmps_beta$qval < 0.05, ]
```

**NOTE**: `dmpFinder` is basic — it runs row-wise F-tests or linear regression without empirical Bayes shrinkage or covariate adjustment. For production DMP analysis, use limma on M values:

```r
# --- Preferred: limma on M values ---
design <- model.matrix(~ 0 + Sample_Group + Age + Sex, data = targets)
colnames(design) <- gsub("Sample_Group", "", colnames(design))

fit <- lmFit(mvals, design)
contrast_matrix <- makeContrasts(Treatment - Control, levels = design)
fit2 <- contrasts.fit(fit, contrast_matrix)
fit2 <- eBayes(fit2)

dmps <- topTable(fit2, number = Inf, sort.by = "P")
# Add delta-beta for biological interpretation
dmps$delta_beta <- rowMeans(beta[rownames(dmps), targets$Sample_Group == "Treatment"]) -
                   rowMeans(beta[rownames(dmps), targets$Sample_Group == "Control"])
sig_dmps <- dmps[dmps$adj.P.Val < 0.05 & abs(dmps$delta_beta) > 0.05, ]
```

## Cell Type Deconvolution

Estimates cell type proportions from blood methylation data using the Houseman reference. MUST be run on the RGChannelSet (before normalization).

```r
cell_counts <- estimateCellCounts(
  rgset,                           # RGChannelSet — NOT MethylSet or GenomicRatioSet
  compositeCellType = "Blood",     # "Blood"|"CordBlood"|"DLPFC" — reference tissue
  processMethod = "auto",          # "auto"|"minfi"|"noob"|"quantile"|"swan"|"funnorm"
  probeSelect = "auto",            # "auto"|"any"|"both" — probe selection strategy
  cellTypes = c("CD8T", "CD4T", "NK", "Bcell", "Mono", "Gran"),
  returnAll = FALSE                # logical — return all intermediate objects
)
# matrix: samples as rows, cell types as columns, proportions summing to ~1

# Include as covariates in downstream models
targets <- cbind(targets, cell_counts)
# Then add cell_counts columns to the design matrix for DMP analysis
```

**CRITICAL**: `estimateCellCounts()` requires an `RGChannelSet` as input. It will fail on `MethylSet`, `RatioSet`, or `GenomicRatioSet`. Run it before any normalization step, then use the proportions as covariates.

## Annotation Access

Retrieve probe-level annotation (chromosome, position, gene, CpG island context).

**This whole section depends on an annotation package that is not staged** (see Setup). `getAnnotation()` reads from the `IlluminaHumanMethylation*anno.*` package bound to the object, so it errors out here. Without it, DMP results carry CpG IDs but no `chr`, `pos`, gene symbol, or island context — report them that way and state the omission rather than leaving the columns silently absent.

```r
# Get full annotation table
ann <- getAnnotation(grset)
# DataFrame with columns: chr, pos, strand, Name, Relation_to_Island,
#   UCSC_RefGene_Name, UCSC_RefGene_Group, etc.

# Or specify the annotation package explicitly
ann <- getAnnotation(IlluminaHumanMethylationEPICanno.ilm10b4.hg19)

# Useful annotation columns
head(ann[, c("chr", "pos", "strand",
             "Relation_to_Island",
             "UCSC_RefGene_Name",
             "UCSC_RefGene_Group")])

# Annotate DMP results
sig_dmps$chr <- ann[rownames(sig_dmps), "chr"]
sig_dmps$pos <- ann[rownames(sig_dmps), "pos"]
sig_dmps$gene <- ann[rownames(sig_dmps), "UCSC_RefGene_Name"]
sig_dmps$island <- ann[rownames(sig_dmps), "Relation_to_Island"]
```

### Array-Specific Annotation Packages

| Array | Annotation Package |
|-|-|
| 450K | `IlluminaHumanMethylation450kanno.ilmn12.hg19` |
| EPIC v1 | `IlluminaHumanMethylationEPICanno.ilm10b4.hg19` |
| EPICv2 | `IlluminaHumanMethylationEPICv2anno.20a1.hg38` |

The correct package is usually auto-detected from the RGChannelSet. Verify with `annotation(grset)` — but note that auto-detection only names the package it wants; it does not install it. **None of the three are staged here**, and each also has a companion `*manifest` package (`IlluminaHumanMethylationEPICmanifest`, `IlluminaHumanMethylation450kmanifest`, …) required by `read.metharray.exp()` that is equally absent. Confirm availability first; if missing, report the blocker.

## Saving Results for Downstream Steps

```r
# Beta value matrix (for reporting, visualization, clocks)
write.csv(beta, "output/beta_values.csv")

# M value matrix (for statistical analysis in other steps)
write.csv(mvals, "output/m_values.csv")

# Detection p-values (for QC records)
write.csv(detp, "output/detection_pvalues.csv")

# Significant DMPs with annotation
write.csv(sig_dmps, "output/significant_dmps.csv")

# Cell type proportions (for use as covariates)
write.csv(cell_counts, "output/cell_type_proportions.csv")

# Sample metadata with QC flags
write.csv(targets, "output/sample_metadata.csv", row.names = FALSE)

# Save the processed GenomicRatioSet as RDS for fast reload
saveRDS(grset, "output/grset_normalized.rds")
```

## Gotchas

- **Memory**: 450K arrays have ~485K probes, EPIC ~850K, EPICv2 ~930K. An RGChannelSet for 100 EPIC samples uses ~3-4 GB. Use `preprocessFunnorm()` or process in batches for large cohorts.
- **Noob vs Funnorm**: Use `preprocessNoob()` as the default for most studies. Switch to `preprocessFunnorm()` for large cohorts (n > 100) with known batch effects — it uses control probe PCs to remove technical variation more aggressively.
- **Beta vs M values**: Beta values (0-1) are intuitive for reporting and visualization. M values (logit-transformed) are homoscedastic and must be used for all statistical testing (limma, t-tests, regression). Running statistics on beta values violates linear model assumptions and inflates false positives near 0 and 1.
- **estimateCellCounts requires RGChannelSet**: This function internally normalizes using the Houseman reference. Passing a MethylSet or GenomicRatioSet will error. Always run on the raw RGChannelSet before your normalization pipeline.
- **dmpFinder is basic**: It performs row-wise F-tests or regression without empirical Bayes moderation, covariate adjustment, or variance shrinkage. Use limma on M values for any real analysis — it handles covariates, batch effects, and small sample sizes properly.
- **Probe filtering is mandatory**: Cross-reactive probes (~30K on EPIC) map to multiple genomic locations and produce false associations. SNP-at-CpG probes reflect genotype, not methylation state. Sex chromosome probes confound mixed-sex analyses. Remove all three categories before analysis. Published filter lists: Chen 2013 (450K), Pidsley 2016 (EPIC), Peters 2024 (EPICv2).
- **preprocessQuantile and preprocessFunnorm return GenomicRatioSet**: These functions already map to the genome — do not call `mapToGenome()` again. `preprocessNoob` and `preprocessSWAN` return a MethylSet and require `ratioConvert()` + `mapToGenome()`.
- **Array annotation mismatch**: Using the wrong annotation package silently maps probes to incorrect genomic positions. Verify with `annotation(grset)` and ensure the annotation package matches the array platform.
- **The annotation and manifest packages are absent in this environment**: no `IlluminaHumanMethylation*anno.*` or `*manifest` package is installed and there is no egress to fetch one, so IDAT loading and genomic mapping cannot run at all. This is a hard stop, not a degradation — check for the package up front, report it as a blocker naming the package and the step, and continue with analyses that do not need it (see Setup).
- **Sex prediction**: `getSex()` predicts sample sex from X/Y chromosome intensities. Use it as a QC check — mismatches indicate sample swaps. Pass predicted sex to `preprocessFunnorm()` and `preprocessQuantile()` for correct normalization.
