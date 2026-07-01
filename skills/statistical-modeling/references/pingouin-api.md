# pingouin API Reference

Clean, pandas-friendly statistical testing. All functions return pandas DataFrames with test statistics, p-values, effect sizes, and confidence intervals.

## T-Tests

```python
import pingouin as pg

# Independent samples t-test
result = pg.ttest(x=group_a, y=group_b, paired=False, alternative='two-sided')
# Returns: T, dof, alternative, p-val, CI95%, cohen-d, BF10, power

# Paired samples t-test
result = pg.ttest(x=pre_scores, y=post_scores, paired=True, alternative='two-sided')

# One-sample t-test (against a known mean)
result = pg.ttest(x=sample_data, y=0, paired=False)       # test against 0

# One-sided alternatives
result = pg.ttest(x=drug, y=placebo, paired=False, alternative='greater')
result = pg.ttest(x=drug, y=placebo, paired=False, alternative='less')

# Access results
p_value = result['p-val'].values[0]
cohens_d = result['cohen-d'].values[0]
bayes_factor = result['BF10'].values[0]
```

## One-Way ANOVA

```python
import pingouin as pg

# One-way ANOVA (between-subjects)
aov = pg.anova(
    data=df,
    dv='score',                     # dependent variable column
    between='group',                # between-subjects factor column
    detailed=True                   # include SS, MS, etc.
)
# Returns: Source, ddof1, ddof2, F, p-unc, np2 (partial eta-squared)

# Effect size options: 'np2' (partial eta-sq), 'n2' (eta-sq), 'ng2' (generalized eta-sq)
aov = pg.anova(data=df, dv='score', between='group', effsize='np2')
```

## Repeated Measures ANOVA

```python
# One-way repeated measures
aov = pg.rm_anova(
    data=df,                        # long format required
    dv='score',
    within='time',                  # within-subjects factor
    subject='subject_id',
    correction='auto',              # Greenhouse-Geisser if sphericity violated
    effsize='ng2'                   # 'np2', 'n2', or 'ng2'
)
# Returns: Source, ddof1, ddof2, F, p-unc, p-GG-corr, ng2, eps, sphericity, W-spher, p-spher

# Two-way repeated measures (long format required)
aov = pg.rm_anova(
    data=df, dv='score',
    within=['time', 'condition'],   # list of two within-subjects factors
    subject='subject_id'
)
```

## Mixed ANOVA

```python
# Between + within factors (split-plot design)
aov = pg.mixed_anova(
    data=df,
    dv='score',
    between='group',                # between-subjects factor
    within='time',                  # within-subjects factor
    subject='subject_id',
    effsize='ng2'
)
# Returns rows for: between factor, within factor, interaction
```

## Post-Hoc Pairwise Tests

```python
# Pairwise comparisons (t-tests with correction)
posthoc = pg.pairwise_tests(
    data=df,
    dv='score',
    between='group',                # or within='time' for repeated measures
    subject='subject_id',           # required for within-subjects
    parametric=True,
    padjust='bonf',                 # 'bonf', 'holm', 'fdr_bh', 'fdr_by', 'none'
    effsize='cohen'
)
# Returns: Contrast, A, B, T, dof, p-unc, p-corr, p-adjust, cohen, BF10, hedges

# Tukey HSD (specific post-hoc for between-subjects)
tukey = pg.pairwise_tukey(data=df, dv='score', between='group')

# Games-Howell (does not assume equal variances)
gh = pg.pairwise_gameshowell(data=df, dv='score', between='group')
```

## Correlations

```python
# Bivariate correlation
result = pg.corr(x=df['var1'], y=df['var2'], method='pearson')
# Returns: n, r, CI95%, p-val, BF10, power
# method options: 'pearson', 'spearman', 'kendall', 'bicor', 'percbend', 'shepherd'

# Partial correlation (controlling for covariates)
result = pg.partial_corr(
    data=df,
    x='var1',
    y='var2',
    covar=['age', 'sex'],           # covariates to control for
    method='pearson'
)
# Returns: n, r, CI95%, p-val

# Pairwise correlations across multiple columns
pairwise = pg.pairwise_corr(
    data=df,
    columns=['var1', 'var2', 'var3', 'var4'],
    method='spearman'
)
```

## Effect Sizes

```python
import pingouin as pg

# Compute Cohen's d between two groups
d = pg.compute_effsize(a=group1, b=group2, eftype='cohen')

# Effect size types: 'cohen', 'hedges', 'glass', 'r', 'eta-squared', 'odds-ratio', 'AUC'
hedges_g = pg.compute_effsize(a=group1, b=group2, eftype='hedges')

# From t-statistic
d = pg.compute_effsize_from_t(t=2.5, nx=30, ny=30, eftype='cohen')

# Convert between effect size types
r = pg.convert_effsize(ef=0.5, input_type='cohen', output_type='r')
```

## Complete Workflow Example

```python
import pingouin as pg
import pandas as pd

# --- Between-subjects design ---
# One-way ANOVA
aov = pg.anova(data=df, dv='expression', between='treatment', effsize='np2')
print(aov.round(4))

# If significant, run post-hoc tests
if aov['p-unc'].values[0] < 0.05:
    posthoc = pg.pairwise_tests(
        data=df, dv='expression', between='treatment',
        padjust='bonf', effsize='cohen'
    )
    print(posthoc.round(4))

# --- Mixed design ---
aov_mixed = pg.mixed_anova(
    data=df_long, dv='score', between='group', within='timepoint',
    subject='patient_id', effsize='ng2'
)
print(aov_mixed.round(4))

# Post-hoc for interaction
posthoc_mixed = pg.pairwise_tests(
    data=df_long, dv='score', between='group', within='timepoint',
    subject='patient_id', padjust='fdr_bh'
)
print(posthoc_mixed.round(4))

# --- Correlation matrix ---
corr_results = pg.pairwise_corr(
    data=df[['gene_a', 'gene_b', 'gene_c', 'age']],
    method='spearman'
)
print(corr_results[['X', 'Y', 'r', 'p-unc']].round(4))
```

## Gotchas

- All ANOVA functions require **long-format** DataFrames (one observation per row). Reshape wide data with `pd.melt()` first.
- `rm_anova` and `mixed_anova` require a `subject` column to identify repeated measures.
- `pg.ttest` accepts arrays or Series, not column names. Use `df['col'].values` if needed.
- `padjust` in `pairwise_tests` corrects across all pairwise comparisons in the output. Options: `'bonf'`, `'holm'`, `'fdr_bh'`, `'fdr_by'`, `'none'`.
- `BF10` (Bayes Factor) is automatically computed for t-tests and correlations. Values > 3 suggest moderate evidence, > 10 strong evidence for H1.
- `mixed_anova` uses Type III sums of squares by default. Set `effsize='ng2'` for generalized eta-squared (recommended for mixed designs).
- Missing data: pingouin uses listwise deletion. Clean NaN values explicitly before calling ANOVA functions to avoid unexpected sample size reduction.
- Two-way `rm_anova` requires long format with both within-factors as separate columns.
