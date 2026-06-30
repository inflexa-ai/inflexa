# ANCOM-BC2 API Reference

Default method for cross-sectional differential abundance testing in microbiome data. Accounts for sampling fraction bias, handles structural zeros, and provides global and pairwise tests.

## Setup

```r
library(ANCOMBC)
library(phyloseq)
```

## Input

ANCOM-BC2 requires a phyloseq object with raw counts (not relative abundance).

```r
# Build phyloseq object (see phyloseq-api.md)
ps <- phyloseq(otu, tax, samp)
```

## ancombc2() — Core Function

```r
# Basic two-group comparison
result <- ancombc2(
  data = ps,
  fix_formula = "group",
  p_adj_method = "holm",
  prv_cut = 0.10,
  lib_cut = 1000,
  s0_perc = 0.05,
  group = "group",
  struc_zero = TRUE,
  neg_lb = TRUE,
  alpha = 0.05,
  global = FALSE,
  pairwise = FALSE,
  verbose = TRUE
)
```

### ancombc2() Full Parameter Reference

```r
result <- ancombc2(
  data = ps,              # phyloseq or TreeSummarizedExperiment object
  fix_formula = "group",  # character — fixed effects formula (no ~)
  rand_formula = NULL,    # character | NULL — random effects, e.g. "(1|subject)"
  p_adj_method = "holm",  # "holm"|"BH"|"bonferroni"|"hochberg"|"none"
  prv_cut = 0.10,         # numeric — prevalence filter (0-1), taxa below excluded
  lib_cut = 1000,         # numeric — library size filter, samples below excluded
  s0_perc = 0.05,         # numeric — percentile for pseudo-count addition (0-1)
  group = "group",        # character — grouping variable for structural zero detection
  struc_zero = TRUE,      # logical — detect and handle structural zeros
  neg_lb = TRUE,          # logical — classify as structural zero if lower bound CI < 0
  alpha = 0.05,           # numeric — significance level
  global = FALSE,         # logical — perform global test across all groups
  pairwise = FALSE,       # logical — perform pairwise comparisons
  dunnet = FALSE,         # logical — Dunnett-type comparisons to reference
  trend = FALSE,          # logical — test for trend across ordered groups
  verbose = TRUE          # logical — print progress
)
```

## Multi-Factor Design

```r
# Adjust for covariates
result <- ancombc2(
  data = ps,
  fix_formula = "group + age + sex",
  p_adj_method = "holm",
  prv_cut = 0.10,
  lib_cut = 1000,
  s0_perc = 0.05,
  group = "group",
  struc_zero = TRUE,
  neg_lb = TRUE,
  alpha = 0.05,
  global = FALSE
)
```

## Longitudinal Design with Random Effects

```r
result <- ancombc2(
  data = ps,
  fix_formula = "timepoint + treatment",
  rand_formula = "(1|subject_id)",
  p_adj_method = "holm",
  prv_cut = 0.10,
  lib_cut = 1000,
  s0_perc = 0.05,
  group = "treatment",
  struc_zero = TRUE,
  neg_lb = TRUE,
  alpha = 0.05
)
```

## Result Extraction

### Per-Taxon Results (res)

```r
res <- result$res

# Column naming pattern for a factor "group" with levels "A" vs reference:
#   taxon               — taxon identifier
#   lfc_groupA          — log fold change estimate
#   se_groupA           — standard error
#   W_groupA            — test statistic
#   p_groupA            — raw p-value
#   q_groupA            — adjusted p-value
#   diff_groupA         — TRUE/FALSE for significant differential abundance
#   passed_ss_groupA    — TRUE/FALSE for sensitivity analysis

# Filter significant taxa
sig <- res[res$diff_groupA == TRUE, ]
sig <- sig[order(sig$q_groupA), ]

# Save results as CSV
write.csv(res, "output/ancombc2_results.csv", row.names = FALSE)
write.csv(sig, "output/ancombc2_significant.csv", row.names = FALSE)
```

### Structural Zeros

```r
# Structural zero indicator matrix
struc_zeros <- result$zero_ind
# TRUE = structural zero detected for that taxon in that group
```

### Global Test Results

```r
# Only available when global = TRUE
result <- ancombc2(
  data = ps,
  fix_formula = "group",
  group = "group",
  global = TRUE,
  p_adj_method = "holm",
  prv_cut = 0.10,
  struc_zero = TRUE,
  neg_lb = TRUE
)
global_res <- result$res_global
# Columns: taxon, W, p_val, q_val, diff_abn
```

### Pairwise Comparisons

```r
# For multi-group (>2 levels) comparisons
result <- ancombc2(
  data = ps,
  fix_formula = "group",
  group = "group",
  pairwise = TRUE,
  p_adj_method = "holm",
  prv_cut = 0.10,
  struc_zero = TRUE,
  neg_lb = TRUE
)
pairwise_res <- result$res_pair
# Columns follow pattern: lfc_groupA_vs_groupB, q_groupA_vs_groupB, etc.
```

## Gotchas

- `fix_formula` does NOT include the `~` prefix. Write `"group"`, not `"~ group"`.
- Input must be raw counts in a phyloseq object. Do not pass relative abundance or normalized data.
- `prv_cut = 0.10` excludes taxa present in fewer than 10% of samples. This is aggressive for low-diversity datasets; consider lowering to 0.05.
- `lib_cut` filters samples by total library size. Set to 0 if you pre-filtered samples.
- `group` parameter is required for structural zero detection (`struc_zero = TRUE`). It must match a variable in `fix_formula`.
- Column names in results are dynamically generated from factor levels: `lfc_<variable><level>`, `q_<variable><level>`, etc. Inspect `colnames(result$res)` to find exact names.
- `pairwise = TRUE` and `global = TRUE` require `group` to be a factor with >2 levels.
- ANCOM-BC2 can be slow on large datasets (>10k taxa). Pre-filter low-prevalence taxa.
- The `rand_formula` uses lme4-style syntax: `"(1|subject)"` for random intercept.
