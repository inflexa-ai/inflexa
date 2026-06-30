# MaAsLin2 API Reference

MaAsLin2 (Microbiome Multivariable Associations with Linear Models). Best choice for longitudinal designs, covariate-rich models, and repeated measures. Supports multiple normalization and transformation options with fixed and random effects.

## Setup

```r
library(Maaslin2)
```

## Input Data Format

MaAsLin2 takes two data frames: features (taxa/pathways) and metadata. Both must have matching sample identifiers as row names.

```r
# features_df: samples as rows, features (taxa) as columns — abundances (counts or proportions)
# metadata_df: samples as rows, covariates as columns
# Row names must be sample IDs and must match between both
```

## Maaslin2() — Core Function

```r
# Basic cross-sectional analysis
result <- Maaslin2(
  input_data = features_df,
  input_metadata = metadata_df,
  output = "maaslin2_output",
  fixed_effects = c("group", "age", "sex"),
  normalization = "TSS",
  transform = "LOG",
  min_abundance = 0.0,
  min_prevalence = 0.1,
  analysis_type = "LM",
  correction = "BH",
  cores = 1
)
```

### Maaslin2() Full Parameter Reference

```r
result <- Maaslin2(
  input_data = features_df,      # data.frame — samples x features; or file path to TSV
  input_metadata = metadata_df,  # data.frame — samples x covariates; or file path to TSV
  output = "output_dir",         # character — output directory (created if missing)
  fixed_effects = c("group"),    # character vector — fixed effect variable names
  random_effects = NULL,         # character vector | NULL — random effect variable names
  reference = NULL,              # character | NULL — reference level, e.g. "group,control"
  normalization = "TSS",         # "TSS"|"CLR"|"CSS"|"NONE"|"TMM"
  transform = "LOG",             # "LOG"|"LOGIT"|"AST"|"NONE"
  analysis_type = "LM",          # "LM"|"CPLM"|"NEGBIN"|"ZINB"
  correction = "BH",             # "BH"|"bonferroni"|"holm"|"BY"
  max_significance = 0.25,       # numeric — q-value threshold for output
  min_abundance = 0.0,           # numeric — minimum feature abundance filter
  min_prevalence = 0.1,          # numeric — minimum feature prevalence filter (0-1)
  min_variance = 0.0,            # numeric — minimum feature variance filter
  standardize = TRUE,            # logical — standardize continuous metadata
  plot_heatmap = TRUE,           # logical — generate heatmap of significant associations
  plot_scatter = TRUE,           # logical — generate scatter plots for significant pairs
  heatmap_first_n = 50,          # int — top N associations to show in heatmap
  cores = 1                      # int — number of parallel threads
)
```

## Normalization Options

| Method | `normalization =` | When to Use |
|--------|-------------------|-------------|
| Total Sum Scaling | `"TSS"` | Default. Converts to relative abundance. |
| Centered Log-Ratio | `"CLR"` | Compositionally aware. Good general choice. |
| Cumulative Sum Scaling | `"CSS"` | From metagenomeSeq. Robust to uneven sampling depth. |
| Trimmed Mean of M-values | `"TMM"` | From edgeR. Originally for RNA-seq. |
| None | `"NONE"` | Data already normalized, or using count-based models (NEGBIN/ZINB). |

## Transformation Options

| Method | `transform =` | When to Use |
|--------|---------------|-------------|
| Log | `"LOG"` | Default. `log2(x + 1)` after normalization. |
| Logit | `"LOGIT"` | For proportional data bounded in [0,1]. |
| Arcsine square root | `"AST"` | Variance-stabilizing for proportions. |
| None | `"NONE"` | With count-based models (NEGBIN/ZINB), or already-transformed data. |

## Analysis Type Options

| Method | `analysis_type =` | When to Use |
|--------|-------------------|-------------|
| Linear model | `"LM"` | Default. Fast, works for most cases. |
| Compound Poisson linear model | `"CPLM"` | For zero-inflated continuous data. |
| Negative binomial | `"NEGBIN"` | For count data with overdispersion. Use `normalization = "NONE"`. |
| Zero-inflated negative binomial | `"ZINB"` | For count data with excess zeros. Use `normalization = "NONE"`. |

## Longitudinal Design with Random Effects

```r
result <- Maaslin2(
  input_data = features_df,
  input_metadata = metadata_df,
  output = "maaslin2_longitudinal",
  fixed_effects = c("timepoint", "treatment"),
  random_effects = c("subject_id"),
  reference = "treatment,placebo",
  normalization = "TSS",
  transform = "LOG",
  min_prevalence = 0.1,
  cores = 4
)
```

## Setting Reference Levels

```r
# Format: "variable,reference_level"
result <- Maaslin2(
  input_data = features_df,
  input_metadata = metadata_df,
  output = "output",
  fixed_effects = c("group", "sex"),
  reference = c("group,control", "sex,female"),
  normalization = "TSS",
  transform = "LOG"
)
```

## Result Extraction

```r
# Main results table
res <- result$results

# Columns:
#   feature     — feature (taxon) name
#   metadata    — metadata variable tested
#   value       — level of the metadata variable (for categorical)
#   coef        — coefficient estimate (effect size)
#   stderr      — standard error
#   N           — number of samples used
#   N.not.zero  — number of non-zero samples
#   pval        — raw p-value
#   qval        — adjusted p-value (q-value)

# Filter significant associations
sig <- res[res$qval < 0.25, ]
sig <- sig[order(sig$qval), ]

# Filter for a specific variable
group_results <- res[res$metadata == "group", ]

# Save results
write.csv(res, "output/maaslin2_all_results.csv", row.names = FALSE)
write.csv(sig, "output/maaslin2_significant.csv", row.names = FALSE)
```

## Output Files

MaAsLin2 writes several files to the output directory:

```
output_dir/
  all_results.tsv           — full results table
  significant_results.tsv   — filtered to q < max_significance
  residuals.rds             — model residuals
  figures/                  — scatter plots for significant associations
  heatmap.pdf               — heatmap of top associations (if plot_heatmap = TRUE)
```

## Gotchas

- Features and metadata must have matching row names (sample IDs). Mismatched IDs are silently dropped.
- `min_prevalence = 0.1` removes features present in <10% of samples BEFORE analysis. This is applied after abundance filtering.
- `reference` format is `"variable,level"` as a single string (or character vector for multiple variables). Not a list.
- When using `analysis_type = "NEGBIN"` or `"ZINB"`, set `normalization = "NONE"` and `transform = "NONE"` — these models operate on raw counts.
- `random_effects` requires >1 observation per random effect level. Single-timepoint data with `random_effects` will fail.
- MaAsLin2 writes output files to disk (the `output` directory). This directory is always created. Set `plot_heatmap = FALSE` and `plot_scatter = FALSE` to reduce I/O.
- The `coef` column represents the effect size on the transformed scale (e.g., log2 scale if `transform = "LOG"`).
- For sparse microbiome data (many zeros), `"CLR"` normalization with `"NONE"` transform and `analysis_type = "LM"` is a good alternative configuration.
- `standardize = TRUE` (default) z-scores continuous metadata variables. This affects coefficient interpretation but not significance.
- Memory: MaAsLin2 fits a separate model per feature. With 10k+ features and multiple covariates, use `cores > 1`.
