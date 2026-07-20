# ChAMP API Reference

Integrated analysis pipeline for Illumina methylation arrays (450K, EPIC). Wraps minfi, limma, DMRcate, and other tools behind simplified interfaces. Best for rapid exploratory methylation analysis; use minfi directly for finer control.

## Setup

> **The ChAMP array pipeline cannot run here.** `ChAMP` is installed, but it delegates IDAT loading to `minfi` and probe filtering/annotation to the `IlluminaHumanMethylation*manifest` and `IlluminaHumanMethylation*anno.*` packages — none of which are staged, with no network egress to install them. Every function taking an `arraytype` argument (`champ.load`, `champ.filter`, `champ.norm`, `champ.DMP`, `champ.DMR`, `champ.Block`, `champ.GSEA`) resolves that platform's annotation internally, so `champ.load()` fails at the first call and nothing downstream is reachable.
>
> **Verify before you build**: confirm the platform's annotation package loads. If it does not, report the blocker plainly — name the package and say IDAT-based ChAMP analysis is unavailable — and do not attempt a workaround through a different `arraytype`. If a normalized beta matrix already exists from another source, skip ChAMP and work from that matrix directly with `limma` (DMPs), `EpiDISH` (deconvolution), and `methylclock` (clocks), which do not need array annotation.
>
> Everything below is technically correct and applies unchanged if these packages are staged.

```r
library(ChAMP)
library(limma)
```

## champ.load() — Data Loading

Load IDAT files and sample sheet from a directory. Performs initial probe filtering during load.

```r
myLoad <- champ.load(
  directory = "idat_dir/",    # character — path to directory containing IDATs + sample sheet
  filterDetP = TRUE,          # logical — filter probes with detection p-value > detPcut
  detPcut = 0.01,             # numeric — detection p-value threshold (default 0.01)
  filterBeads = TRUE,         # logical — filter probes with bead count < 3 in >= 5% of samples
  filterNoCG = TRUE,          # logical — remove non-CpG probes (ch.* probes)
  filterSNPs = TRUE,          # logical — remove probes with SNPs at CpG site or SBE
  filterMultiHit = TRUE,      # logical — remove cross-reactive probes mapping to multiple loci
  filterXY = TRUE,            # logical — remove probes on X and Y chromosomes
  arraytype = "EPIC",         # "450K" | "EPIC" — MUST match actual platform
  method = "minfi",           # "minfi" | "ChAMP" — loading method (minfi recommended)
  methValue = "B",            # "B" (beta) | "M" (M-value)
  autoimpute = TRUE,          # logical — impute missing values with KNN
  ProbeCutoff = 0,            # numeric — max fraction of failed samples per probe (0 = any failure removes)
  SampleCutoff = 0.1          # numeric — max fraction of failed probes per sample
)
```

### champ.load() Result Structure

```r
# myLoad is a list with these components:
myLoad$beta       # numeric matrix — beta-values, probes (rows) x samples (cols)
myLoad$pd         # data.frame — sample sheet (phenotype data), rows = samples
myLoad$intensity  # numeric matrix — total signal intensity, probes x samples
myLoad$detP       # numeric matrix — detection p-values, probes x samples

nrow(myLoad$beta)  # number of probes remaining after filtering
ncol(myLoad$beta)  # number of samples
```

### Directory Layout

champ.load() expects this directory structure:

```
idat_dir/
  ├── SampleSheet.csv          # Must have Sample_Name, Sentrix_ID, Sentrix_Position, Sample_Group columns
  ├── 200925570001_R01C01_Grn.idat
  ├── 200925570001_R01C01_Red.idat
  └── ...
```

## champ.filter() — Additional Probe Filtering

Apply additional filtering to already-loaded data. Useful when you want to customize filters post-load.

```r
myFilter <- champ.filter(
  beta = myLoad$beta,
  pd = myLoad$pd,
  detP = myLoad$detP,
  beadcount = NULL,           # matrix | NULL — bead count matrix
  intensity = myLoad$intensity,
  autoimpute = TRUE,
  filterDetP = TRUE,
  detPcut = 0.01,
  filterBeads = TRUE,
  filterNoCG = TRUE,
  filterSNPs = TRUE,
  filterMultiHit = TRUE,
  filterXY = TRUE,
  arraytype = "EPIC"
)

# Returns a filtered list with the same structure as champ.load()
beta_filtered <- myFilter$beta
```

## champ.norm() — Normalization

Normalize beta-values. BMIQ is the default and corrects for type I/II probe bias.

```r
myNorm <- champ.norm(
  beta = myLoad$beta,
  rgSet = NULL,               # RGChannelSet | NULL — required for Funnorm/SWAN, not for BMIQ/PBC
  mset = NULL,                # MethylSet | NULL — alternative input
  resultsDir = "./CHAMP_Normalization/",
  method = "BMIQ",            # "BMIQ" | "SWAN" | "PBC" | "Funnorm"
  plotBMIQ = FALSE,           # logical — generate BMIQ diagnostic plots
  arraytype = "EPIC",
  cores = 1                   # int — parallel cores for BMIQ
)

# myNorm is a normalized beta-value matrix (probes x samples)
dim(myNorm)
```

### Normalization Methods

| Method | `method =` | Requires RGChannelSet | Notes |
|--------|-----------|----------------------|-------|
| BMIQ | `"BMIQ"` | No | Default. Beta-Mixture Quantile normalization. Corrects type I/II probe bias. Recommended for most analyses. |
| SWAN | `"SWAN"` | Yes | Subset-quantile Within Array Normalization. Requires `rgSet` from minfi. |
| PBC | `"PBC"` | No | Peak-Based Correction. Simpler alternative to BMIQ. |
| Funnorm | `"Funnorm"` | Yes | Functional normalization. Best for large cohorts with known batch effects. Requires `rgSet`. |

## champ.SVD() — Batch Effect Detection

Singular Value Decomposition to identify associations between principal components of methylation data and sample metadata variables. Use to detect batch effects before DMP/DMR analysis.

```r
champ.SVD(
  beta = myNorm,
  pd = myLoad$pd,
  resultsDir = "./CHAMP_SVDimages/",
  RGEffect = FALSE            # logical — include red/green intensity effects
)
# Generates a heatmap of p-values (component vs metadata variable associations)
# Significant associations (p < 0.05) indicate batch effects or confounders
```

## champ.DMP() — Differentially Methylated Positions

Detect DMPs using limma internally. Returns per-comparison results.

```r
myDMP <- champ.DMP(
  beta = myNorm,
  pheno = myLoad$pd$Sample_Group,  # factor or character vector — group labels per sample
  compare.group = NULL,            # character vector of length 2 | NULL — e.g. c("Tumor", "Normal")
  adjPVal = 0.05,                  # numeric — adjusted p-value threshold
  adjust.method = "BH",           # character — p-value adjustment method
  arraytype = "EPIC"
)
```

### champ.DMP() Result Structure

```r
# myDMP is a named list — one data.frame per pairwise comparison
# For two groups "Tumor" vs "Normal":
names(myDMP)  # e.g. "Tumor_to_Normal"

dmp_results <- myDMP[["Tumor_to_Normal"]]

# Columns in each data.frame:
# logFC       — log2 fold change of beta-values
# AveExpr     — average expression (mean beta)
# t           — moderated t-statistic (from limma eBayes)
# P.Value     — raw p-value
# adj.P.Val   — BH-adjusted p-value
# B           — log-odds of differential methylation
# CHR         — chromosome
# MAPINFO     — genomic position
# gene        — nearest gene symbol (from annotation)
# feature     — genomic feature context (TSS1500, TSS200, 5'UTR, 1stExon, Body, 3'UTR, IGR)
# cgi         — CpG island context (Island, Shore, Shelf, OpenSea)

# Filter significant DMPs
sig_dmps <- dmp_results[dmp_results$adj.P.Val < 0.05, ]

# Calculate delta-beta for biological relevance filtering
# logFC from champ.DMP is on beta scale, so it IS delta-beta
sig_bio <- sig_dmps[abs(sig_dmps$logFC) > 0.05, ]
```

### Multi-Group Comparisons

```r
# With 3+ groups, champ.DMP returns all pairwise comparisons
# pheno with levels: "Normal", "Tumor", "Metastasis"
myDMP <- champ.DMP(beta = myNorm, pheno = myLoad$pd$Sample_Group)

# Access each comparison
names(myDMP)  # e.g. "Tumor_to_Normal", "Metastasis_to_Normal", "Metastasis_to_Tumor"

# Restrict to a specific pair
myDMP <- champ.DMP(
  beta = myNorm,
  pheno = myLoad$pd$Sample_Group,
  compare.group = c("Tumor", "Normal")
)
```

## champ.DMR() — Differentially Methylated Regions

Detect DMRs using one of three methods. DMRcate is recommended.

```r
myDMR <- champ.DMR(
  beta = myNorm,
  pheno = myLoad$pd$Sample_Group,
  compare.group = NULL,        # character vector of length 2 | NULL
  arraytype = "EPIC",
  method = "DMRcate",          # "Bumphunter" | "DMRcate" | "ProbeLasso"
  minProbes = 3,               # int — minimum CpGs per DMR (applies to DMRcate, ProbeLasso)
  adjPvalDmr = 0.05,          # numeric — adjusted p-value threshold for DMR calling
  cores = 1,
  # DMRcate-specific parameters:
  rmSNPCH = TRUE,             # logical — remove SNP-containing and cross-hybridizing probes
  fdr = 0.05,                 # numeric — FDR threshold for cpg.annotate
  dist = 1000,                # int — bandwidth in base pairs for kernel smoothing
  mafcut = 0.05,              # numeric — MAF cutoff for SNP filtering
  # Bumphunter-specific parameters:
  maxGap = 300,               # int — max gap between CpGs in a bump
  cutoff = NULL,              # numeric | NULL — effect size cutoff
  pickCutoff = TRUE,          # logical — auto-select cutoff
  smooth = TRUE,              # logical — smooth the signal
  B = 250                     # int — number of permutations
)
```

### DMR Methods

| Method | `method =` | Notes |
|--------|-----------|-------|
| DMRcate | `"DMRcate"` | Recommended. Kernel smoothing approach. Wraps the DMRcate package internally. For more control, use DMRcate directly (see `dmrcate-api.md`). |
| Bumphunter | `"Bumphunter"` | Permutation-based. Slower but well-established. From the bumphunter package. |
| ProbeLasso | `"ProbeLasso"` | Probe density adaptive. Uses variable window sizes based on local probe density. |

### champ.DMR() Result Structure (DMRcate Method)

```r
# myDMR is a data.frame (DMRcate method) with columns:
# seqnames           — chromosome
# start              — DMR start position
# end                — DMR end position
# width              — DMR width in base pairs
# no.cpgs            — number of CpGs in the DMR
# min_smoothed_fdr   — minimum smoothed FDR across CpGs in the region
# Stouffer           — Stouffer combined p-value
# HMFDR              — harmonic mean FDR
# Fisher             — Fisher combined p-value
# maxdiff            — maximum beta-value difference across CpGs
# meandiff           — mean beta-value difference across CpGs
# overlapping.genes  — genes overlapping the DMR

# Filter DMRs
sig_dmrs <- myDMR[myDMR$HMFDR < 0.05 & myDMR$no.cpgs >= 5, ]

# Sort by effect size
sig_dmrs <- sig_dmrs[order(-abs(sig_dmrs$meandiff)), ]
```

## champ.Block() — Block Finder

Detect large-scale methylation blocks (>100kb). Identifies broad hypomethylated or hypermethylated domains.

```r
myBlock <- champ.Block(
  beta = myNorm,
  pheno = myLoad$pd$Sample_Group,
  arraytype = "EPIC",
  maxGap = 250000,             # int — maximum gap between CpGs within a block
  B = 500,                     # int — number of permutations
  cores = 1
)

# myBlock is a list:
# myBlock$Block    — data.frame of detected blocks
# myBlock$clusterInfo — clustering information used for block detection
block_results <- myBlock$Block
```

## champ.GSEA() — Gene Set Enrichment Analysis

Perform gene set enrichment on DMP results. Uses the gometh/gsameth approach from missMethyl to account for probe-number bias.

**KEGG enrichment fails here.** `gometh` retrieves KEGG pathway membership from the KEGG REST API, and there is no network egress — so the KEGG half of this call errors out. GO enrichment works, because `missMethyl` gets GO terms from locally installed `org.*` annotation packages. Restrict to GO (`collection = "GO"`), or run the probe-bias-aware enrichment against a gene-set collection you resolved from the reference inventory (Reactome, WikiPathways, and MSigDB hallmark GMTs are catalogued) via `gsameth()`. If neither is available, report it rather than presenting an empty or partial enrichment as a result.

```r
myGSEA <- champ.GSEA(
  beta = myNorm,
  DMP = myDMP[[1]],            # data.frame — DMP results from champ.DMP()
  DMR = myDMR,                 # data.frame — DMR results from champ.DMR()
  pheno = myLoad$pd$Sample_Group,
  method = "gometh",           # "gometh" | "ebayes"
  arraytype = "EPIC",
  adjPval = 0.05
)

# myGSEA contains enriched GO terms and KEGG pathways
# Adjust interpretation based on method used
```

## Saving Results for Downstream Steps

```r
# Export normalized beta matrix
write.csv(myNorm, "output/normalized_betas.csv")

# Export DMP results
for (comp_name in names(myDMP)) {
  out_path <- paste0("output/dmps_", comp_name, ".csv")
  write.csv(myDMP[[comp_name]], out_path)
}

# Export significant DMPs with delta-beta filter
sig <- myDMP[["Tumor_to_Normal"]]
sig <- sig[sig$adj.P.Val < 0.05 & abs(sig$logFC) > 0.05, ]
write.csv(sig, "output/dmps_significant.csv")

# Export DMR results
write.csv(myDMR, "output/dmr_results.csv", row.names = FALSE)

# Export sample metadata
write.csv(myLoad$pd, "output/sample_metadata.csv", row.names = FALSE)

# Save R objects for reuse
saveRDS(myNorm, "output/normalized_betas.rds")
saveRDS(myDMP, "output/dmp_results.rds")
saveRDS(myDMR, "output/dmr_results.rds")

# Export figures
# Volcano plot of DMPs
dmp <- myDMP[["Tumor_to_Normal"]]
png("figures/dmp_volcano.png", width = 8, height = 6, units = "in", res = 300)
plot(dmp$logFC, -log10(dmp$adj.P.Val),
     xlab = "Delta Beta", ylab = "-log10(adj. P)",
     pch = 20, col = ifelse(dmp$adj.P.Val < 0.05 & abs(dmp$logFC) > 0.05, "red", "grey60"),
     main = "DMP Volcano Plot")
abline(h = -log10(0.05), lty = 2, col = "blue")
abline(v = c(-0.05, 0.05), lty = 2, col = "blue")
dev.off()
```

## Gotchas

- **Directory layout**: `champ.load()` expects IDAT files and a `SampleSheet.csv` in the same directory. The sample sheet must have `Sample_Name`, `Sentrix_ID`, `Sentrix_Position`, and `Sample_Group` columns. Missing or misnamed columns cause cryptic failures.
- **BMIQ does not require RGChannelSet**: BMIQ works directly on beta-value matrices. Only SWAN and Funnorm require an `rgSet` from minfi. If you only have beta-values (e.g., from GEO), BMIQ is the only option.
- **champ.DMP() uses limma internally**: It builds a design matrix from `pheno` and runs `lmFit` + `eBayes`. The `compare.group` parameter specifies which two levels to contrast. Without it, all pairwise comparisons are returned.
- **DMRcate via champ.DMR() is a wrapper**: `champ.DMR(method = "DMRcate")` wraps the DMRcate package with simplified parameters. For full control over `cpg.annotate()`, `dmrcate()`, and `extractRanges()`, use DMRcate directly (see `dmrcate-api.md`).
- **arraytype must match platform**: Setting `arraytype = "450K"` for EPIC data (or vice versa) silently uses incorrect annotation manifests. Probe filtering, gene mapping, and CpG island assignments will all be wrong.
- **The annotation manifests `arraytype` selects are not installed here**: whichever value you pass, ChAMP looks for an `IlluminaHumanMethylation*` manifest/anno package that is absent, and there is no egress to fetch it. `champ.load()` therefore errors before reading any IDAT. Check availability first and report it as a blocker; switching `arraytype` does not work around it (see Setup).
- **Memory with EPIC arrays**: EPIC has ~850K probes. For large studies (>100 samples), normalization and DMP detection may exhaust memory. Process in batches or use a high-memory instance. BMIQ normalization is per-sample and parallelizable (`cores` parameter).
- **filterXY default**: `filterXY = TRUE` removes sex chromosome probes by default. Set to `FALSE` for sex-differential methylation studies, then handle sex chromosomes explicitly in the analysis.
- **M-values for statistics**: ChAMP's `champ.DMP()` internally handles the beta-to-M conversion for limma. If running limma manually on ChAMP-normalized betas, convert first: `M <- log2(beta / (1 - beta))`.
- **SVD before DMP**: Always run `champ.SVD()` before `champ.DMP()` to check for batch effects. If technical variables (slide, array position) associate strongly with top components, consider ComBat correction (`champ.runCombat()`) before proceeding.
- **Probe filtering order matters**: `champ.load()` filters during loading. If you load with all filters off and use `champ.filter()` later, the filtering happens on the full probe set. Some filter lists (cross-reactive, multi-hit) are array-type specific — ensure `arraytype` is consistent.
