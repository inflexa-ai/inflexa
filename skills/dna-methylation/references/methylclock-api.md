# methylclock API Reference

Epigenetic age estimation from DNA methylation data using multiple clocks. Supports chronological age (Horvath, Hannum, skin+blood, PedBE, Wu, BNN, BLUP, EN), biological age (Levine/PhenoAge, Telomere Length), and gestational age (Knight, Bohlin, Mayne, Lee, EPIC) clocks. Requires beta values at clock-specific CpG subsets.

## Setup

```r
library(methylclock)
library(methylclockData)   # clock coefficient data (auto-loaded via ExperimentHub)
library(minfi)             # for GenomicRatioSet input
library(ggplot2)           # for plotting functions
```

## Input Data Format

methylclock accepts four input formats. All must contain beta values (0-1 scale), NOT M-values.

```r
# Format 1: data.frame / tibble — Horvath's format
# Rows = CpGs, Columns = individuals
# CpG names in the FIRST column (named "CpGName" or "ProbeID")
#   CpGName      Sample1  Sample2  Sample3
#   cg00000029   0.452    0.387    0.501
#   cg00000108   0.912    0.889    0.935

# Format 2: matrix — CpG names as rownames, samples as columns
beta_matrix <- getBeta(grset)   # from minfi
# rownames(beta_matrix) are CpG IDs, colnames are sample IDs

# Format 3: ExpressionSet (Biobase)
# exprs(eset) = beta value matrix (CpGs x samples)

# Format 4: GenomicRatioSet (minfi)
# Passed directly — methylclock extracts beta values internally
```

## DNAmAge() — Chronological and Biological Age Estimation

Primary function for estimating DNAm age. Runs all specified clocks on the input data, handles missing CpG imputation, and optionally performs Horvath's normalization and cell count estimation.

```r
results <- DNAmAge(
  x,                                          # data.frame|matrix|ExpressionSet|GenomicRatioSet — beta values
  clocks = "all",                             # character — clock(s) to run (see Clock Names below)
  toBetas = FALSE,                            # logical — set TRUE if input is M-values (converts to beta)
  fastImp = FALSE,                            # logical — fast imputation (impute only clock CpGs, not full matrix)
  normalize = FALSE,                          # logical — apply Horvath's BMIQ normalization
  age,                                        # numeric vector — chronological age per sample (for acceleration)
  cell.count = TRUE,                          # logical — estimate cell type proportions
  cell.count.reference = "blood gse35069 complete",  # character — reference panel for cell counts
  min.perc = 0.8,                             # numeric — minimum CpG overlap fraction (0-1) to run a clock
  ...                                         # additional arguments passed to impute::impute.knn()
)
# Returns: tibble with one row per sample, columns for each clock's predicted age,
#   plus cell count columns if cell.count = TRUE
```

### Clock Names (clocks parameter)

| Value | Clock | CpGs | Domain | Use Case |
|-|-|-|-|-|
| `"Horvath"` | Horvath (2013) | 353 | Multi-tissue | General-purpose, any tissue |
| `"Hannum"` | Hannum (2013) | 71 | Blood | Blood-based studies, EWAS |
| `"Levine"` | PhenoAge (2018) | 513 | Mortality-associated | Biological age, health outcomes |
| `"BNN"` | Bayesian Neural Network | — | Multi-tissue | Alternative to Horvath |
| `"skinHorvath"` | Skin+Blood (2018) | 391 | Skin, blood, buccal | Skin, saliva, fibroblasts |
| `"PedBE"` | Pediatric Buccal (2019) | 84 | Buccal epithelium | Children ages 0-20 |
| `"Wu"` | Wu (2019) | 111 | Blood | Children and adolescents |
| `"TL"` | Telomere Length | 140 | Blood | Biological aging proxy |
| `"BLUP"` | Best Linear Unbiased Prediction | 319607 | Multi-tissue | Genome-wide, requires all CpGs |
| `"EN"` | Elastic Net | 514 | Multi-tissue | Alternative to Horvath |
| `"all"` | All of the above | — | — | Default — runs every clock |

```r
# Run specific clocks
results <- DNAmAge(beta, clocks = "Horvath")
results <- DNAmAge(beta, clocks = c("Horvath", "Hannum", "Levine"))

# Run all clocks
results <- DNAmAge(beta, clocks = "all")
```

### Return Value

A tibble with columns:

- `id` — sample identifier
- One column per clock with predicted age (e.g., `Horvath`, `Hannum`, `Levine`, `skinHorvath`, `PedBE`, `Wu`, `BNN`, `TL`, `BLUP`, `EN`)
- If `age` parameter was provided: `ageAcc.Horvath`, `ageAcc.Hannum`, etc. (age acceleration = predicted - chronological)
- If `cell.count = TRUE`: `CD8T`, `CD4T`, `NK`, `Bcell`, `Mono`, `Gran` (cell type proportions)

## DNAmGA() — Gestational Age Estimation

Estimate gestational age (in weeks) from placenta/cord blood methylation data.

```r
ga_results <- DNAmGA(
  x,                                          # data.frame|matrix|ExpressionSet|GenomicRatioSet — beta values
  toBetas = FALSE,                            # logical — set TRUE if input is M-values
  fastImp = FALSE,                            # logical — fast imputation for clock CpGs only
  normalize = FALSE,                          # logical — Horvath's normalization
  age,                                        # numeric vector — known gestational age (for acceleration)
  cell.count = TRUE,                          # logical — estimate cell type proportions
  cell.count.reference = "andrews and bakulski cord blood",  # character — cord blood reference panel
  min.perc = 0.8,                             # numeric — minimum CpG overlap fraction
  ...                                         # additional arguments passed to impute::impute.knn()
)
# Returns: tibble with gestational age predictions per clock (in weeks)
```

### Gestational Age Clocks

| Clock | CpGs | Tissue |
|-|-|-|
| Knight (2016) | 148 | Cord blood |
| Bohlin (2016) | 96 | Cord blood |
| Mayne (2017) | 62 | Placenta |
| EPIC (2019) | 176 | Cord blood (EPIC array) |
| Lee RPC (2019) | 558 | Placenta + cord blood |
| Lee CPC (2019) | 546 | Placenta + cord blood |
| Lee Refined RPC (2019) | 396 | Placenta + cord blood |

## checkClocks() — CpG Compatibility Check

Check whether input data contains the required CpGs for each chronological/biological clock. Run this BEFORE `DNAmAge()` to identify missing probes and assess clock feasibility.

```r
cpg_check <- checkClocks(
  x,     # data.frame|matrix|ExpressionSet|GenomicRatioSet — beta values
  ...    # other parameters
)
# Returns: a list — one element per clock with the CpGs that are MISSING from the input
# A clock is flagged when more than 80% of required CpGs are present (controlled by min.perc in DNAmAge)
```

```r
# Example: check which clocks are feasible for your data
beta <- getBeta(grset)
cpg_check <- checkClocks(beta)

# See missing CpGs per clock
cpg_check$Horvath    # character vector of Horvath CpGs NOT in your data
cpg_check$Hannum     # character vector of Hannum CpGs NOT in your data
cpg_check$Levine     # character vector of PhenoAge CpGs NOT in your data

# Count missing per clock
sapply(cpg_check, length)
```

## checkClocksGA() — CpG Compatibility Check for Gestational Clocks

Same as `checkClocks()` but for gestational age clocks.

```r
cpg_check_ga <- checkClocksGA(
  x,     # data.frame|matrix|ExpressionSet|GenomicRatioSet — beta values
  ...    # other parameters
)
# Returns: a list — one element per GA clock with missing CpGs
```

## commonClockCpgs() — Get Overlapping CpGs

Retrieve the CpGs that ARE present in both the input data and a specific clock's required set. Useful for assessing coverage after running `checkClocks()`.

```r
common <- commonClockCpgs(
  object,   # list — result from checkClocks() or checkClocksGA()
  clock     # character — clock name: "Horvath", "Hannum", "Levine", "skinHorvath",
            #   "PedBE", "Wu", "TL", "Knight", "Bohlin", "Mayne", "Lee"
)
# Returns: character vector of CpG IDs present in both data and clock
```

```r
cpg_check <- checkClocks(beta)
horvath_present <- commonClockCpgs(cpg_check, "Horvath")
cat(length(horvath_present), "of 353 Horvath CpGs present\n")
```

## Plotting Functions

### plotCorClocks() — Clock Correlation Matrix

Plot pairwise correlations among all estimated clock ages. Useful to check clock agreement.

```r
plotCorClocks(
  x,     # tibble — result from DNAmAge()
  ...    # arguments passed to PerformanceAnalytics::chart.Correlation()
)
```

### plotDNAmAge() — Predicted vs Chronological Age

Scatter plot of predicted DNAm age against known chronological age with regression line.

```r
plotDNAmAge(
  x,                              # numeric vector — predicted DNAm age (e.g., results$Horvath)
  y,                              # numeric vector — chronological age
  tit = "Horvath's method",       # character — plot title
  clock = "chronological",        # "chronological" | "GA" — type of clock
  ...                             # additional ggplot parameters
)
```

## Cell Count Estimation

methylclock includes cell type deconvolution from beta values (ported from the meffil package). This runs automatically when `cell.count = TRUE` in `DNAmAge()`/`DNAmGA()`.

### meffilEstimateCellCountsFromBetas()

Estimate cell type proportions directly from a beta matrix (without needing an RGChannelSet).

```r
cell_counts <- meffilEstimateCellCountsFromBetas(
  beta,                  # matrix — CpG sites as rows, samples as columns (beta values)
  cellTypeReference,     # character — reference panel name (see meffilListCellTypeReferences())
  verbose = FALSE        # logical — print progress messages
)
# Returns: matrix — samples as rows, cell types as columns (proportions)
```

### meffilListCellTypeReferences()

List available cell type reference panels.

```r
refs <- meffilListCellTypeReferences()
# Available references include:
#   "blood gse35069"           — adult blood (Reinius 2012)
#   "blood gse35069 complete"  — adult blood, all 6 cell types (default for DNAmAge)
#   "andrews and bakulski cord blood"  — cord blood (default for DNAmGA)
#   "cord blood gse68456"
#   "gervin and lyle cord blood"
#   "combined cord blood"
#   "guintivano dlpfc"         — brain (dorsolateral prefrontal cortex)
#   "saliva gse48472"          — saliva
```

## Clock Data Loading

These functions load clock coefficients from the `methylclockData` package via ExperimentHub. Called automatically by `DNAmAge()`/`DNAmGA()` on first use — manual loading is rarely needed.

```r
load_DNAm_Clocks_data()     # loads chronological/biological clock coefficients
load_DNAmGA_Clocks_data()   # loads gestational age clock coefficients
```

## Common Patterns

### Pattern 1: Full Epigenetic Age Analysis from minfi Output

```r
library(methylclock)
library(minfi)

# --- Start from a normalized GenomicRatioSet (from minfi pipeline) ---
grset <- readRDS("output/grset_normalized.rds")
beta <- getBeta(grset)

# --- Step 1: Check CpG compatibility before running clocks ---
cpg_check <- checkClocks(beta)
missing_counts <- sapply(cpg_check, length)
cat("Missing CpGs per clock:\n")
print(missing_counts)

# --- Step 2: Run clocks with known ages for acceleration analysis ---
ages <- targets$Age  # chronological ages from sample sheet

results <- DNAmAge(
  beta,
  clocks = c("Horvath", "Hannum", "Levine", "skinHorvath"),
  age = ages,
  cell.count = TRUE,
  cell.count.reference = "blood gse35069 complete"
)

# --- Step 3: Save results ---
write.csv(results, "output/epigenetic_ages.csv", row.names = FALSE)

# --- Step 4: Visualize ---
png("figures/horvath_vs_chronological.png", width = 800, height = 600, res = 150)
plotDNAmAge(results$Horvath, ages, tit = "Horvath Clock")
dev.off()

png("figures/clock_correlations.png", width = 1000, height = 1000, res = 150)
plotCorClocks(results)
dev.off()
```

### Pattern 2: Choosing Clocks by Tissue Type

```r
# Blood samples — use all three major blood clocks
results_blood <- DNAmAge(beta, clocks = c("Horvath", "Hannum", "Levine"), age = ages)

# Skin / fibroblast / buccal samples — use skin+blood clock
results_skin <- DNAmAge(beta, clocks = c("Horvath", "skinHorvath"), age = ages)

# Pediatric buccal samples (ages 0-20)
results_peds <- DNAmAge(beta, clocks = c("PedBE", "Wu"), age = ages)

# Any tissue (general-purpose)
results_general <- DNAmAge(beta, clocks = c("Horvath", "skinHorvath"), age = ages)

# Mortality / health outcome focus
results_bio <- DNAmAge(beta, clocks = c("Levine", "TL"), age = ages)
```

### Pattern 3: CpG Compatibility Check Before Clock Selection

```r
# Check which clocks are feasible for the array platform
cpg_check <- checkClocks(beta)
total_cpgs <- c(Horvath = 353, Hannum = 71, Levine = 513, skinHorvath = 391,
                PedBE = 84, Wu = 111, TL = 140, BLUP = 319607, EN = 514)

feasible <- sapply(names(total_cpgs), function(clock) {
  n_missing <- length(cpg_check[[clock]])
  n_total <- total_cpgs[clock]
  coverage <- (n_total - n_missing) / n_total
  cat(sprintf("%s: %d/%d CpGs present (%.1f%%)\n", clock, n_total - n_missing, n_total, coverage * 100))
  coverage >= 0.80  # methylclock default threshold
})

# Only run clocks with sufficient coverage
clocks_to_run <- names(feasible[feasible])
results <- DNAmAge(beta, clocks = clocks_to_run, age = ages)
```

### Pattern 4: Age Acceleration Analysis

```r
# Age acceleration = predicted DNAm age - chronological age
# Positive = biologically older than expected, Negative = younger

results <- DNAmAge(beta, clocks = c("Horvath", "Hannum", "Levine"), age = ages)

# Intrinsic epigenetic age acceleration (IEAA) — Horvath, adjusted for cell counts
model_ieaa <- lm(results$Horvath ~ ages + results$CD8T + results$CD4T +
                  results$NK + results$Bcell + results$Mono + results$Gran)
ieaa <- residuals(model_ieaa)

# Extrinsic epigenetic age acceleration (EEAA) — Hannum, NOT adjusted for cell counts
# EEAA captures both intrinsic aging and cell composition changes
eeaa <- results$Hannum - ages

# PhenoAge acceleration — residual from regressing PhenoAge on chronological age
model_pheno <- lm(results$Levine ~ ages)
pheno_accel <- residuals(model_pheno)

# Compare acceleration across groups
accel_df <- data.frame(
  Sample = results$id,
  IEAA = ieaa,
  EEAA = eeaa,
  PhenoAgeAccel = pheno_accel,
  Group = targets$Sample_Group
)
write.csv(accel_df, "output/age_acceleration.csv", row.names = FALSE)
```

### Pattern 5: Gestational Age from Cord Blood

```r
# Cord blood methylation — estimate gestational age
ga_results <- DNAmGA(
  beta,
  age = targets$GestationalAge,  # known GA in weeks
  cell.count = TRUE,
  cell.count.reference = "andrews and bakulski cord blood"
)

write.csv(ga_results, "output/gestational_ages.csv", row.names = FALSE)
```

### Pattern 6: Using M-values as Input

```r
# If you only have M-values, set toBetas = TRUE to convert internally
mvals <- getM(grset)
results <- DNAmAge(mvals, toBetas = TRUE, clocks = "Horvath", age = ages)
```

## Gotchas

- **Input must be beta values (0-1), NOT M-values**: By default `toBetas = FALSE`, meaning methylclock expects beta values. If you pass M-values without setting `toBetas = TRUE`, the predictions will be silently wrong — no error is raised.
- **CpG orientation matters**: For data.frame input, CpGs must be in ROWS and samples in COLUMNS (Horvath's format), with CpG names in the first column. For matrix input, CpGs are rownames. Transposed data produces garbage results without error.
- **Missing CpGs are imputed, not skipped**: When clock CpGs are missing from the input, methylclock uses KNN imputation (`impute::impute.knn()`). This is statistically valid for small fractions of missing CpGs but produces unreliable estimates when many CpGs are absent. The `min.perc` parameter (default 0.8) sets the minimum overlap — clocks with less than 80% of their CpGs present are not computed.
- **EPICv2 drops clock CpGs**: EPICv2 (Illumina EPIC v2) removed probes present on 450K and EPIC v1. Horvath (353 CpGs, designed for 450K) typically loses 5-15 CpGs on EPICv2. Hannum (71 CpGs) may lose 2-5. Levine/PhenoAge (513 CpGs) loses 10-25. Always run `checkClocks()` before selecting clocks for EPICv2 data.
- **BLUP clock requires genome-wide coverage**: The BLUP clock uses 319,607 CpGs — essentially the full 450K array. It cannot run on targeted panels, RRBS, or heavily filtered datasets. It is also slow and memory-intensive.
- **Horvath normalization is NOT the same as minfi normalization**: Setting `normalize = TRUE` applies Horvath's BMIQ normalization (from the original 2013 paper), which is specific to the clock calibration. This is separate from and in addition to any minfi normalization (Noob, Funnorm, etc.) you applied upstream. If you already normalized with minfi, leave `normalize = FALSE` (the default).
- **cell.count adds columns to the result**: When `cell.count = TRUE` (default), cell type proportion columns are appended to the result tibble. If you do not have blood data, set `cell.count = FALSE` to avoid spurious cell count estimates from inappropriate reference panels.
- **cell.count.reference must match tissue**: The default `"blood gse35069 complete"` is for adult blood. For cord blood, use `"andrews and bakulski cord blood"`. For brain, use `"guintivano dlpfc"`. Using the wrong reference produces meaningless cell proportions.
- **Age acceleration requires the age parameter**: To get `ageAcc.*` columns in the output, you must pass the `age` parameter with known chronological ages. Without it, only raw predicted ages are returned. For proper IEAA/EEAA, compute acceleration manually (see Pattern 4) rather than relying on the simple subtraction in the output.
- **First run downloads data from ExperimentHub**: Clock coefficients are fetched from Bioconductor's ExperimentHub on first use and cached locally. This requires internet access. In sandboxed environments, ensure `methylclockData` is pre-installed and the ExperimentHub cache is populated, or call `load_DNAm_Clocks_data()` / `load_DNAmGA_Clocks_data()` explicitly before `DNAmAge()`.
- **fastImp only imputes clock CpGs**: With `fastImp = TRUE`, only CpGs needed by the selected clocks are imputed (faster). With `fastImp = FALSE` (default), the entire matrix is imputed first (more accurate KNN neighbors, but much slower for large datasets). Use `fastImp = TRUE` for datasets with >100 samples.
- **GenomicRatioSet input extracts beta automatically**: When passing a minfi GenomicRatioSet, methylclock calls `getBeta()` internally. Do not pre-extract and transpose — pass the GenomicRatioSet directly.
