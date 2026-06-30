# ALDEx2 API Reference

Compositional data analysis for differential abundance testing. Uses Dirichlet-multinomial sampling to model per-read technical variation, then applies CLR transformation. Particularly well-suited for small sample sizes and when compositional awareness is critical.

## Setup

```r
library(ALDEx2)
```

## Input Data Format

ALDEx2 expects a count matrix with features (taxa/genes) as rows and samples as columns. Counts must be non-negative integers.

```r
# counts: data.frame or matrix — taxa as rows, samples as columns (raw integer counts)
# conditions: character vector of group labels matching column order
conditions <- meta_df$group
```

## aldex.clr() — CLR Transformation with Monte Carlo Sampling

The foundation of ALDEx2. Generates Monte Carlo instances from Dirichlet distribution, then applies CLR transform.

```r
clr_data <- aldex.clr(
  counts,                # data.frame — features x samples, integer counts
  conditions,            # character vector — group labels per sample
  mc.samples = 128,      # int — number of Monte Carlo Dirichlet instances (default 128)
  denom = "all",         # "all"|"iqlr"|"zero"|"lvha"|character vector
  verbose = TRUE
)
```

### aldex.clr() denom Parameter

- `"all"` — Use all features for geometric mean (default, standard CLR).
- `"iqlr"` — Inter-quartile log-ratio: features with variance between 25th-75th percentile. Robust to asymmetric differential abundance.
- `"zero"` — Features with zero variance across groups. Assumes some features are invariant.
- `"lvha"` — Low variance, high abundance features.
- Custom vector of feature names/indices for manual reference frame selection.

## aldex.ttest() — Statistical Testing

Welch's t-test and Wilcoxon rank-sum test on CLR-transformed Monte Carlo instances.

```r
# Two-group comparison
ttest_res <- aldex.ttest(
  clr_data,              # ALDEx2 clr object from aldex.clr()
  paired.test = FALSE,   # logical — paired t-test if TRUE
  verbose = TRUE
)

# Columns:
#   we.ep    — expected p-value from Welch's t-test (mean across MC instances)
#   we.eBH   — expected BH-adjusted p-value from Welch's t-test
#   wi.ep    — expected p-value from Wilcoxon test
#   wi.eBH   — expected BH-adjusted p-value from Wilcoxon test
```

## aldex.effect() — Effect Size Estimation

```r
effect_res <- aldex.effect(
  clr_data,             # ALDEx2 clr object
  CI = TRUE,            # logical — compute 95% CI for effect size
  verbose = TRUE
)

# Columns:
#   rab.all          — median CLR value across all samples
#   rab.win.group0   — median CLR within group 0
#   rab.win.group1   — median CLR within group 1
#   diff.btw         — median difference between groups (effect)
#   diff.win         — median difference within groups (dispersion)
#   effect           — median effect size (diff.btw / diff.win)
#   overlap          — proportion of distribution overlap between groups
#   effect.low       — lower 95% CI bound (if CI = TRUE)
#   effect.high      — upper 95% CI bound (if CI = TRUE)
```

## aldex() — All-in-One Wrapper

Combines clr, ttest, and effect in a single call.

```r
# Two-group differential abundance (complete pipeline)
result <- aldex(
  counts,                # data.frame — features x samples
  conditions,            # character vector — group labels
  mc.samples = 128,      # int — Monte Carlo instances
  test = "t",            # "t" for t-test | "kw" for Kruskal-Wallis | "glm" for GLM
  effect = TRUE,         # logical — compute effect sizes
  denom = "all",         # CLR denominator type
  verbose = TRUE
)

# Contains all columns from ttest + effect combined
```

### Multi-Group: Kruskal-Wallis

```r
# For >2 groups, use Kruskal-Wallis test
result_kw <- aldex(
  counts,
  conditions,           # character vector with >2 group levels
  mc.samples = 128,
  test = "kw",
  effect = TRUE,
  denom = "all"
)

# Columns:
#   kw.ep    — expected p-value from Kruskal-Wallis test
#   kw.eBH   — expected BH-adjusted p-value
#   glm.ep   — expected p-value from GLM test
#   glm.eBH  — expected BH-adjusted p-value from GLM
```

### GLM for Covariates

```r
# For covariate-adjusted analysis, use the GLM test
model_matrix <- model.matrix(~ group + age, data = meta_df)

clr_data <- aldex.clr(counts, model_matrix, mc.samples = 128)
glm_res <- aldex.glm(clr_data, verbose = TRUE)
```

## aldex.plot() — Diagnostic Plots

```r
# MA plot (Bland-Altman style)
png("figures/aldex2_ma_plot.png", width = 800, height = 600, res = 150)
aldex.plot(result, type = "MA", test = "welch",
           cutoff.pval = 0.05, cutoff.effect = 1)
dev.off()

# Effect plot (MW — median vs. dispersion)
png("figures/aldex2_effect_plot.png", width = 800, height = 600, res = 150)
aldex.plot(result, type = "MW", test = "welch",
           cutoff.pval = 0.05, cutoff.effect = 1)
dev.off()

# PDF versions
pdf("figures/aldex2_ma_plot.pdf", width = 6, height = 4)
aldex.plot(result, type = "MA", test = "welch",
           cutoff.pval = 0.05, cutoff.effect = 1)
dev.off()
```

### aldex.plot() Parameters

```r
aldex.plot(
  result,                # ALDEx2 result object from aldex()
  type = "MA",           # "MA" (MA plot) | "MW" (effect plot) | "volcano"
  test = "welch",        # "welch" | "wilcox" — which p-value to use for coloring
  cutoff.pval = 0.1,     # numeric — p-value threshold for significance
  cutoff.effect = 1,     # numeric — effect size threshold for significance
  xlab = NULL,           # character — x-axis label
  ylab = NULL,           # character — y-axis label
  all.col = "grey",      # character — color for non-significant points
  called.col = "red"     # character — color for significant points
)
```

## Filtering Significant Features

```r
# Filter: BH-adjusted p < 0.05 AND |effect| > 1
sig <- result[result$we.eBH < 0.05 & abs(result$effect) > 1, ]
sig <- sig[order(sig$we.eBH), ]

# Alternative: use overlap < 0.1 (less than 10% overlap between groups)
sig_overlap <- result[result$overlap < 0.1, ]

# Save results
write.csv(result, "output/aldex2_results.csv")
write.csv(sig, "output/aldex2_significant.csv")
```

## Gotchas

- Input must be raw integer counts. Do not pass normalized, rarefied, or relative abundance data.
- `mc.samples` (default 128) controls the number of Dirichlet Monte Carlo instances. Higher values give more stable results but increase compute time. For publication, use 1000.
- The `effect` column is more robust than p-values for small sample sizes. An |effect| > 1 with overlap < 0.1 is a strong signal.
- `denom = "iqlr"` is recommended when >25% of features are expected to be differentially abundant (breaks the "most features unchanged" assumption of standard CLR).
- ALDEx2 does not support random effects or longitudinal designs directly. Use `aldex.glm()` with a model matrix for covariate adjustment, but for repeated measures consider MaAsLin2.
- Row names of the count matrix become feature identifiers in results. Ensure they are set correctly.
- The `aldex()` wrapper returns a data.frame with merged columns from all sub-functions. Individual functions (`aldex.clr`, `aldex.ttest`, `aldex.effect`) give more control.
- For very large feature tables (>50k features), increase `mc.samples` cautiously — memory scales as features x samples x mc.samples.
- `we.eBH` is the expected (averaged across MC instances) BH-adjusted p-value. It is NOT the same as applying BH correction to a single test.
