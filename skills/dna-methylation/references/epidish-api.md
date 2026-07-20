# EpiDISH API Reference

Reference-based cell type deconvolution from DNA methylation data. Supports blood (adult and cord), epithelial tissue, and breast tissue via multiple reference panels and three deconvolution methods (RPC, CBS, CP). Also provides CellDMC for identifying cell-type-specific differentially methylated positions in EWAS.

## Setup

> **EpiDISH itself runs here.** It is installed, its reference matrices ship inside the package (loaded with `data()`, no download), and `epidish()` works on any beta matrix — so it needs neither array annotation packages nor network access. Of the array tools in this pack, it is the one that is not blocked.
>
> **The constraint is upstream.** The `IlluminaHumanMethylation*manifest` / `*anno.*` packages are not staged and there is no egress, so you cannot produce beta values from raw IDATs here (see `minfi-api.md`). EpiDISH needs a beta matrix that already exists — from GEO, a collaborator, or a prior processing step. Confirm you have one before planning deconvolution; if the only input is IDATs, report that the IDAT-to-beta step is blocked by the missing manifest package rather than presenting deconvolution as available.
>
> One consequence worth noting: cell fractions come out fine, but the CpG IDs in `celldmc_out$coe` cannot be mapped to genes or genomic positions without the annotation package. Report cell-type-specific DMPs by CpG ID and say the annotation is unavailable.

```r
library(EpiDISH)
library(limma)
```

## Reference Matrices

EpiDISH ships several built-in reference matrices. Each is a matrix of beta values with CpGs as rows and cell types as columns. Load with `data()`.

### centDHSbloodDMC.m — Standard Blood (7 cell types)

The default blood reference. 333 tsDHS-DMCs (tissue-specific DNase Hypersensitive Site DMCs) across 7 blood cell subtypes. Constructed from 450K purified blood cell type data (Reinius et al. 2012) using DHS information from the NIH Epigenomics Roadmap. Works with both 450K and EPIC arrays.

```r
data(centDHSbloodDMC.m)
# matrix: 333 CpGs x 7 cell types
# Cell types: B-cells, CD4+ T-cells, CD8+ T-cells, NK-cells, Monocytes, Neutrophils, Eosinophils
```

**NOTE**: Eosinophil fractions are typically small. You can sum Neutrophils + Eosinophils to get a Granulocytes estimate comparable to minfi's `estimateCellCounts()` Gran output.

### centBloodSub.m — Blood for hepidish() (7 cell types, 188 CpGs)

A subset of `centDHSbloodDMC.m` containing 188 DMCs that show similar median DNAm across epithelial cells, fibroblasts, and immune cells. Designed for use as the secondary reference in `hepidish()` to estimate immune cell subtype fractions without confounding from epithelial/fibroblast cells.

```r
data(centBloodSub.m)
# matrix: 188 CpGs x 7 cell types
# Cell types: B-cells, CD4+ T-cells, CD8+ T-cells, NK-cells, Monocytes, Neutrophils, Eosinophils
```

### cent12CT.m — High-Resolution Blood, EPIC (12 cell types)

High-resolution blood reference with 12 immune cell subtypes. Constructed from Salas et al. (2022) data. For EPIC arrays only. Use `cent12CT450k.m` for 450K arrays.

```r
data(cent12CT.m)
# matrix: 600 CpGs x 12 cell types
# Cell types: CD4+ naive T-cells, Basophil cells, CD4+ memory T-cells,
#   Memory B-cells, Naive B-cells, Regulatory T-Cells,
#   CD8+ memory T-cells, CD8+ naive T-cells, Eosinophils,
#   NK-cells, Neutrophils, Monocytes
```

### cent12CT450k.m — High-Resolution Blood, 450K (12 cell types)

Same 12 cell subtypes as `cent12CT.m`, but constructed for 450K arrays.

```r
data(cent12CT450k.m)
# matrix: 600 CpGs x 12 cell types
# Same cell types as cent12CT.m
```

### centUniLIFE.m — Universal Blood, Any Age (19 cell types)

Universal reference for blood of any age, covering both cord blood and adult immune cell types. Constructed from Salas et al. (2022) and cord-blood DNAm datasets. Works with both EPIC and 450K arrays.

```r
data(centUniLIFE.m)
# matrix: 1906 CpGs x 19 cell types
# Cord-blood types: granulocytes, monocytes, nRBCs, B-cells, NK-cells,
#   CD8+ T-cells, CD4+ T-cells
# Adult types: CD4+ naive T-cells, Basophil cells, CD4+ memory T-cells,
#   Memory B-cells, Naive B-cells, Regulatory T-Cells,
#   CD8+ memory T-cells, CD8+ naive T-cells, Eosinophils,
#   NK-cells, Neutrophils, Monocytes
```

### centEpiFibIC.m — Generic Epithelial Tissue (3 cell types)

Estimates proportions of epithelial cells, fibroblasts, and total immune cells in epithelial tissues. Use as the primary reference in `hepidish()` for hierarchical deconvolution of non-blood tissues.

```r
data(centEpiFibIC.m)
# matrix: 716 CpGs x 3 cell types
# Cell types: Epi (epithelial), Fib (fibroblast), IC (immune cells)
```

### centEpiFibFatIC.m — Breast Tissue (4 cell types)

Designed for breast tissue. Estimates fractions of epithelial cells, fibroblasts, fat cells, and total immune cells.

```r
data(centEpiFibFatIC.m)
# matrix: 491 CpGs x 4 cell types
# Cell types: Epi (epithelial), Fib (fibroblast), Fat, IC (immune cells)
```

## epidish() — Cell Type Deconvolution

A reference-based function to infer fractions of a priori known cell subtypes in a sample. Inference uses one of three methods: Robust Partial Correlations (RPC), CIBERSORT (CBS), or Constrained Projection (CP).

```r
out <- epidish(
  beta.m,                                # matrix — beta values (CpGs x samples), NOT M-values
  ref.m,                                 # matrix — reference centroid (CpGs x cell types), beta values
  method = c("RPC", "CBS", "CP"),        # character — deconvolution method (default first match: "RPC")
  maxit = 50,                            # integer — max IWLS iterations (RPC mode only)
  nu.v = c(0.25, 0.5, 0.75),            # numeric vector — candidate nu values (CBS mode only)
  constraint = c("inequality", "equality") # character — normalization constraint (CP mode only)
)
```

### Parameters

| Parameter | Type | Default | Description |
|-|-|-|-|
| `beta.m` | matrix | required | Data matrix with CpGs as rows and samples as columns. Row names must match `ref.m`. Values must be beta-values (0-1). No missing values. All values must be positive or zero. |
| `ref.m` | matrix | required | Reference centroid matrix with CpGs as rows and cell types as columns. Row names are CpG IDs, column names are cell type labels. Beta-values. No missing values. |
| `method` | character | `"RPC"` | Deconvolution method: `"RPC"` (Robust Partial Correlations), `"CBS"` (CIBERSORT), or `"CP"` (Constrained Projection). |
| `maxit` | integer | `50` | Maximum number of IWLS (Iteratively Weighted Least Squares) iterations. Only used in RPC mode. |
| `nu.v` | numeric vector | `c(0.25, 0.5, 0.75)` | Candidate nu parameter values for SVM. Only used in CBS mode. The best estimation among all candidates is automatically returned. |
| `constraint` | character | `"inequality"` | Normalization constraint for CP mode. `"inequality"` means fractions sum to <= 1 (Houseman 2012 method). `"equality"` means fractions sum to exactly 1. Only used in CP mode. |

### Return Value

A list with method-specific entries:

**RPC mode** (`method = "RPC"`):
- `estF` — matrix of estimated fractions (samples x cell types), values in [0, 1]
- `ref` — the reference centroid matrix used
- `dataREF` — subset of input data matrix with only probes present in the reference

**CBS mode** (`method = "CBS"`):
- `estF` — matrix of estimated fractions (samples x cell types)
- `nu` — vector of best nu parameter selected for each sample
- `ref` — the reference centroid matrix used
- `dataREF` — subset of input data matrix with only probes in the reference

**CP mode** (`method = "CP"`):
- `estF` — matrix of estimated fractions (samples x cell types)
- `ref` — the reference centroid matrix used
- `dataREF` — subset of input data matrix with only probes in the reference

### Method Selection

| Method | Full Name | Algorithm | Best For |
|-|-|-|-|
| `RPC` | Robust Partial Correlations | IWLS robust regression (MASS::rlm) | Default choice. Robust to outlier CpGs. Best general-purpose method. |
| `CBS` | CIBERSORT | nu-SVM (e1071::svm) | When reference has many correlated cell types. Handles collinearity well. |
| `CP` | Constrained Projection | Quadratic programming (quadprog) | Houseman-compatible results. Use with `constraint = "inequality"` for direct comparison with minfi::estimateCellCounts(). |

**Recommendation**: Use `RPC` as the default. It is robust and fast. Use `CP` with `constraint = "inequality"` if you need results directly comparable to the Houseman/minfi approach.

## hepidish() — Hierarchical Deconvolution

Iterative hierarchical procedure for two-stage deconvolution. Uses a primary reference for broad cell categories (e.g., epithelial, fibroblast, immune) and a secondary reference for subtypes within one category (e.g., immune cell subtypes). Essential for non-blood tissues where immune cell fractions are confounded by epithelial/fibroblast content.

```r
frac.m <- hepidish(
  beta.m,                                # matrix — beta values (CpGs x samples)
  ref1.m,                                # matrix — primary reference (broad cell categories)
  ref2.m,                                # matrix — secondary reference (subtypes of one category)
  h.CT.idx,                              # integer — column index in ref1.m of the category to subtype
  method = c("RPC", "CBS", "CP"),        # character — deconvolution method
  maxit = 50,                            # integer — max IWLS iterations (RPC only)
  nu.v = c(0.25, 0.5, 0.75),            # numeric vector — candidate nu values (CBS only)
  constraint = c("inequality", "equality") # character — constraint (CP only)
)
```

### Parameters

| Parameter | Type | Default | Description |
|-|-|-|-|
| `beta.m` | matrix | required | Data matrix with CpGs as rows, samples as columns. Beta-values. |
| `ref1.m` | matrix | required | Primary reference centroids for broad cell categories. E.g., `centEpiFibIC.m` (Epi, Fib, IC). |
| `ref2.m` | matrix | required | Secondary reference centroids for subtypes of one category in `ref1.m`. E.g., `centBloodSub.m` (B-cells, CD4+T, CD8+T, NK, Mono, Neutro, Eosino). |
| `h.CT.idx` | integer | required | Column index in `ref1.m` identifying which broad category to decompose into subtypes via `ref2.m`. E.g., if `ref1.m` has columns (Epi, Fib, IC), set `h.CT.idx = 3` to decompose IC into immune subtypes. |
| `method` | character | `"RPC"` | Same as `epidish()`. |
| `maxit` | integer | `50` | Same as `epidish()`. |
| `nu.v` | numeric vector | `c(0.25, 0.5, 0.75)` | Same as `epidish()`. |
| `constraint` | character | `"inequality"` | Same as `epidish()`. |

### Return Value

A matrix of estimated fractions (samples x cell types). Contains all broad categories from `ref1.m` except the decomposed one, plus all subtypes from `ref2.m` (scaled by the broad category fraction).

## CellDMC() — Cell-Type-Specific DMPs in EWAS

Identifies not only differentially methylated positions but also the specific cell type(s) driving each methylation change. Use after running `epidish()` to get cell fractions.

```r
celldmc.o <- CellDMC(
  beta.m,                    # matrix — beta values (CpGs x samples)
  pheno.v,                   # vector — phenotype (binary or continuous). No NAs allowed.
  frac.m,                    # matrix — cell fractions (samples x cell types) from epidish()$estF
  adjPMethod = "fdr",        # character — p-value adjustment method (any method from p.adjust)
  adjPThresh = 0.05,         # numeric — adjusted p-value threshold for calling DMCTs
  cov.mod = NULL,            # model.matrix or NULL — covariates to adjust for (do NOT include cell fractions)
  sort = FALSE,              # logical — sort results by p-value
  mc.cores = 1               # integer — number of cores for parallel execution
)
```

### Parameters

| Parameter | Type | Default | Description |
|-|-|-|-|
| `beta.m` | matrix | required | Beta value matrix (CpGs x samples). |
| `pheno.v` | vector | required | Phenotype vector (binary or continuous). No NAs. Same order as columns of `beta.m`. |
| `frac.m` | matrix | required | Cell type fractions (samples x cell types) from `epidish()$estF`. Row order must match columns of `beta.m`. Column names are required. Row sums should be ~1. |
| `adjPMethod` | character | `"fdr"` | P-value correction method. Any method accepted by `p.adjust()` (e.g., `"fdr"`, `"bonferroni"`, `"BH"`). |
| `adjPThresh` | numeric | `0.05` | Adjusted p-value threshold for calling DMCTs. |
| `cov.mod` | model.matrix | `NULL` | Covariate design matrix from `model.matrix()`. E.g., `model.matrix(~ age + sex, data = pheno.df)`. Do NOT include cell fractions here — they are handled internally. |
| `sort` | logical | `FALSE` | If `TRUE`, results in `coe` list are sorted by p-value. Row order in `dmct` does not change. |
| `mc.cores` | integer | `1` | Number of cores for parallel execution. |

### Return Value

A list with two elements:

- **`dmct`** — matrix (CpGs x (1 + n_cell_types)). First column: 1 if the CpG is a DMC, 0 otherwise. Subsequent columns: one per cell type. Values are 1 (hypermethylated DMCT), -1 (hypomethylated DMCT), or 0 (not a DMCT in that cell type).
- **`coe`** — named list of data.frames, one per cell type. Each data.frame has all CpGs with columns: `Estimate` (DNAm change), `SE` (standard error), `t` (t-statistic), `p` (raw p-value), `adjP` (adjusted p-value).

## Common Patterns

### Blood Deconvolution with Standard Reference

```r
library(EpiDISH)

# beta must be a matrix of beta-values (CpGs as rows, samples as columns)
# Typically from minfi: beta <- getBeta(grset)
data(centDHSbloodDMC.m)

out <- epidish(beta.m = beta, ref.m = centDHSbloodDMC.m, method = "RPC")
cell_fractions <- out$estF
# matrix: samples x 7 cell types (B-cells, CD4+T, CD8+T, NK, Mono, Neutro, Eosino)

# Verify fractions are reasonable
print(summary(rowSums(cell_fractions)))  # should be close to 1
print(round(colMeans(cell_fractions), 3))
```

### High-Resolution Blood (12 subtypes, EPIC)

```r
data(cent12CT.m)

out <- epidish(beta.m = beta, ref.m = cent12CT.m, method = "RPC")
cell_fractions <- out$estF
# 12 subtypes including naive/memory T and B cells, Tregs, basophils
```

### Using Cell Fractions as Covariates in limma DMP Analysis

```r
library(limma)
library(EpiDISH)

# 1. Estimate cell proportions
data(centDHSbloodDMC.m)
out <- epidish(beta.m = beta, ref.m = centDHSbloodDMC.m, method = "RPC")
cell_fractions <- out$estF

# 2. Build design matrix WITH cell proportions as covariates
# Drop one cell type to avoid collinearity (fractions sum to ~1)
design <- model.matrix(~ 0 + group + age + sex +
    cell_fractions[, "CD8T"] + cell_fractions[, "CD4T"] +
    cell_fractions[, "NK"] + cell_fractions[, "Bcell"] +
    cell_fractions[, "Mono"] + cell_fractions[, "Neutro"],
  data = pheno)

# 3. Run limma on M-values (NOT beta-values)
mvals <- log2(beta / (1 - beta))
fit <- lmFit(mvals, design)
contrast_matrix <- makeContrasts(groupTreatment - groupControl, levels = design)
fit2 <- contrasts.fit(fit, contrast_matrix)
fit2 <- eBayes(fit2)
dmps <- topTable(fit2, number = Inf, sort.by = "P")
```

### Hierarchical Deconvolution for Epithelial Tissue

```r
# For non-blood tissues: first estimate broad categories, then decompose IC into subtypes
data(centEpiFibIC.m)
data(centBloodSub.m)

frac <- hepidish(
  beta.m = beta,
  ref1.m = centEpiFibIC.m,     # primary: Epi, Fib, IC
  ref2.m = centBloodSub.m,     # secondary: 7 immune subtypes
  h.CT.idx = 3,                # decompose column 3 (IC) into subtypes
  method = "RPC"
)
# Returns matrix with columns: Epi, Fib, B-cells, CD4+T, CD8+T, NK, Mono, Neutro, Eosino
# Immune subtypes are scaled by the total IC fraction
```

### Hierarchical Deconvolution for Breast Tissue

```r
data(centEpiFibFatIC.m)
data(centBloodSub.m)

frac <- hepidish(
  beta.m = beta,
  ref1.m = centEpiFibFatIC.m,  # primary: Epi, Fib, Fat, IC
  ref2.m = centBloodSub.m,     # secondary: 7 immune subtypes
  h.CT.idx = 4,                # decompose column 4 (IC) into subtypes
  method = "RPC"
)
# Returns: Epi, Fib, Fat, B-cells, CD4+T, CD8+T, NK, Mono, Neutro, Eosino
```

### Cell-Type-Specific EWAS with CellDMC

```r
library(EpiDISH)

# 1. Get cell fractions
data(centDHSbloodDMC.m)
out <- epidish(beta.m = beta, ref.m = centDHSbloodDMC.m, method = "RPC")
frac <- out$estF

# 2. Run CellDMC
pheno_vector <- as.numeric(pheno$group == "case")  # binary phenotype
cov_matrix <- model.matrix(~ age + sex, data = pheno)  # do NOT include cell fractions

celldmc_out <- CellDMC(
  beta.m = beta,
  pheno.v = pheno_vector,
  frac.m = frac,
  cov.mod = cov_matrix,
  adjPMethod = "fdr",
  adjPThresh = 0.05,
  mc.cores = 4
)

# 3. Identify cell-type-specific DMPs
dmct_matrix <- celldmc_out$dmct
# Columns: DMC, B-cells, CD4+T, CD8+T, NK, Mono, Neutro, Eosino
# DMC column: 1 = significant in any cell type
# Cell type columns: 1 = hyper, -1 = hypo, 0 = not significant

# Count DMCTs per cell type
colSums(dmct_matrix != 0)

# Get detailed stats for monocyte-specific changes
mono_stats <- celldmc_out$coe[["Mono"]]
sig_mono <- mono_stats[mono_stats$adjP < 0.05, ]
```

### Universal Blood Reference for Mixed-Age Cohorts

```r
# For studies spanning neonates to adults (e.g., longitudinal birth cohorts)
data(centUniLIFE.m)

out <- epidish(beta.m = beta, ref.m = centUniLIFE.m, method = "RPC")
cell_fractions <- out$estF
# 19 cell types covering both cord-blood and adult immune cells
```

### Visualizing Cell Proportions

```r
library(ggplot2)
library(tidyr)

# Convert fractions to long format for plotting
frac_df <- as.data.frame(out$estF)
frac_df$sample <- rownames(frac_df)
frac_long <- pivot_longer(frac_df, cols = -sample, names_to = "cell_type", values_to = "fraction")

# Stacked bar plot
png("figures/cell_proportions.png", width = 1200, height = 600, res = 150)
ggplot(frac_long, aes(x = sample, y = fraction, fill = cell_type)) +
  geom_bar(stat = "identity") +
  theme_minimal() +
  theme(axis.text.x = element_text(angle = 90, hjust = 1, size = 6)) +
  labs(x = "Sample", y = "Fraction", fill = "Cell Type",
       title = "Estimated Cell Type Proportions (EpiDISH RPC)")
dev.off()

# Box plot by group
frac_df$group <- pheno$group
frac_long2 <- pivot_longer(frac_df, cols = -c(sample, group),
                            names_to = "cell_type", values_to = "fraction")
png("figures/cell_proportions_by_group.png", width = 1000, height = 600, res = 150)
ggplot(frac_long2, aes(x = cell_type, y = fraction, fill = group)) +
  geom_boxplot(outlier.size = 0.5) +
  theme_minimal() +
  theme(axis.text.x = element_text(angle = 45, hjust = 1)) +
  labs(x = "Cell Type", y = "Fraction", fill = "Group",
       title = "Cell Type Proportions by Group")
dev.off()
```

## Saving Results

```r
# Cell type proportions
write.csv(out$estF, "output/cell_type_proportions_epidish.csv")

# CellDMC results
write.csv(celldmc_out$dmct, "output/celldmc_dmct_matrix.csv")
for (ct in names(celldmc_out$coe)) {
  write.csv(celldmc_out$coe[[ct]],
            paste0("output/celldmc_", gsub("[^a-zA-Z0-9]", "_", ct), ".csv"))
}
```

## Gotchas

- **Input must be beta-values, NOT M-values**: `epidish()` and `hepidish()` require beta-values (0-1 scale). M-values (logit-transformed) will produce incorrect fractions. If your pipeline uses M-values for statistics, convert back: `beta <- 2^M / (1 + 2^M)` or keep a separate beta matrix.
- **No missing values allowed**: Both `beta.m` and `ref.m` must have no NAs and all values must be >= 0. Impute or remove CpGs with missing values before calling `epidish()`.
- **CpG overlap is automatic**: `epidish()` internally subsets the input to only CpGs present in the reference matrix. You do not need to filter your beta matrix to match the reference. However, verify that enough reference CpGs are present in your data — if most reference CpGs were removed during QC/filtering, results will be unreliable.
- **Row sums may not equal exactly 1**: RPC and CBS methods do not enforce a sum-to-1 constraint. Fractions may sum to slightly more or less than 1. This is expected. CP with `constraint = "equality"` enforces exact sum to 1; CP with `constraint = "inequality"` enforces sum <= 1.
- **Drop one cell type for limma covariates**: Because cell fractions approximately sum to 1, including all cell types as covariates in a limma model creates near-perfect collinearity. Drop one cell type (typically the most abundant — Neutrophils or Granulocytes) from the design matrix.
- **centDHSbloodDMC.m vs minfi Houseman**: `centDHSbloodDMC.m` uses DHS-informed CpG selection and reports Eosinophils separately from Neutrophils. minfi's `estimateCellCounts()` uses the original Houseman reference and reports Granulocytes (= Neutrophils + Eosinophils). Results will differ slightly. To approximate minfi's Granulocytes, sum EpiDISH's Neutrophils + Eosinophils.
- **Choose the right reference for your array**: `cent12CT.m` is for EPIC arrays. `cent12CT450k.m` is for 450K arrays. Using the wrong one will silently reduce CpG overlap and degrade accuracy.
- **centBloodSub.m is for hepidish() only**: This 188-CpG subset is specifically designed to avoid confounding from epithelial/fibroblast cells. Use `centDHSbloodDMC.m` or `cent12CT.m` for direct blood deconvolution with `epidish()`.
- **hepidish() h.CT.idx is a column index, not a name**: Pass the integer column position in `ref1.m`, not the cell type name string. For `centEpiFibIC.m` (Epi=1, Fib=2, IC=3), use `h.CT.idx = 3` to decompose immune cells.
- **CellDMC cov.mod must NOT include cell fractions**: Cell fractions are handled internally by `CellDMC()`. Including them in `cov.mod` will cause double adjustment and incorrect results. Only include other covariates (age, sex, batch) in `cov.mod`.
- **CellDMC requires estimated fractions, not known proportions**: Use the output of `epidish()$estF` as `frac.m`. Do not fabricate or assume cell fractions.
- **estimateCellCounts() requires RGChannelSet; epidish() works on any beta matrix**: Unlike minfi's `estimateCellCounts()` which requires raw IDAT data (RGChannelSet), `epidish()` accepts any normalized beta matrix. This makes it usable with GEO data, bisulfite sequencing, or any source of beta values at known CpG positions.
