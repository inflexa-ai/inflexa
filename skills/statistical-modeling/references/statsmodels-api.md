# statsmodels API Reference

## Formula Interface (smf)

```python
import statsmodels.formula.api as smf
import statsmodels.api as sm
import pandas as pd

# OLS with formula (R-style, patsy syntax)
model = smf.ols('y ~ x1 + x2', data=df).fit()
print(model.summary())

# Categorical variables: C() wraps a column as categorical
model = smf.ols('y ~ x1 + C(group)', data=df).fit()

# Interactions
model = smf.ols('y ~ x1 * x2', data=df).fit()         # x1 + x2 + x1:x2
model = smf.ols('y ~ x1 : x2', data=df).fit()          # interaction only

# Polynomial terms (I() protects arithmetic from patsy interpretation)
model = smf.ols('y ~ x1 + I(x1**2)', data=df).fit()

# Suppress intercept
model = smf.ols('y ~ x1 + x2 - 1', data=df).fit()

# Reference level for categorical
model = smf.ols("y ~ C(group, Treatment(reference='control'))", data=df).fit()
```

## Matrix Interface (sm)

```python
import statsmodels.api as sm
import numpy as np

# OLS with explicit design matrix
X = sm.add_constant(X_raw)                              # adds intercept column
model = sm.OLS(y, X).fit()
print(model.summary())

# Weighted Least Squares
model = sm.WLS(y, X, weights=1.0/variance_per_obs).fit()
```

## Generalized Linear Models (GLM)

```python
import statsmodels.api as sm
import statsmodels.formula.api as smf

# Logistic regression (binomial family, logit link)
model = smf.glm('outcome ~ x1 + x2 + C(group)',
                 data=df,
                 family=sm.families.Binomial()).fit()

# Poisson regression (for count data)
model = smf.glm('counts ~ x1 + x2',
                 data=df,
                 family=sm.families.Poisson()).fit()

# Negative binomial (for overdispersed counts)
model = smf.glm('counts ~ x1 + x2',
                 data=df,
                 family=sm.families.NegativeBinomial()).fit()

# Gamma regression (for positive continuous data)
model = smf.glm('cost ~ x1 + x2',
                 data=df,
                 family=sm.families.Gamma()).fit()

# Available families: Binomial, Poisson, NegativeBinomial, Gamma, Gaussian,
#   InverseGaussian, Tweedie
```

## Mixed Effects Models (MixedLM)

```python
import statsmodels.formula.api as smf

# Random intercept model
model = smf.mixedlm('y ~ x1 + x2', data=df, groups=df['subject']).fit()
print(model.summary())
print(model.fe_params)              # fixed effects
print(model.random_effects)         # per-group random effects

# Random intercept + random slope
model = smf.mixedlm(
    'y ~ x1 + x2',
    data=df,
    groups=df['subject'],
    re_formula='~x1'               # random slope for x1
).fit()
```

## Model Results

```python
results = smf.ols('y ~ x1 + x2 + C(group)', data=df).fit()

# Summary
results.summary()                   # full regression table
results.summary2()                  # alternative format

# Key attributes
results.params                      # Series of coefficients
results.pvalues                     # p-values per coefficient
results.conf_int()                  # DataFrame of confidence intervals
results.rsquared                    # R-squared
results.rsquared_adj                # adjusted R-squared
results.aic                         # Akaike Information Criterion
results.bic                         # Bayesian Information Criterion
results.fvalue                      # F-statistic
results.f_pvalue                    # p-value for F-test
results.resid                       # residuals
results.fittedvalues                # fitted (predicted) values
```

## Predictions

```python
# Predict on new data
new_df = pd.DataFrame({'x1': [1.0, 2.0], 'x2': [3.0, 4.0], 'group': ['A', 'B']})
y_hat = results.predict(new_df)

# Predictions with confidence intervals
pred = results.get_prediction(new_df)
pred_summary = pred.summary_frame(alpha=0.05)
# Columns: mean, mean_se, mean_ci_lower, mean_ci_upper, obs_ci_lower, obs_ci_upper
```

## ANOVA

```python
import statsmodels.api as sm

# One-way ANOVA via linear model
model1 = smf.ols('response ~ C(treatment)', data=df).fit()
anova_table = sm.stats.anova_lm(model1, typ=2)    # typ: 1, 2, or 3

# Two-way ANOVA
model2 = smf.ols('response ~ C(treatment) * C(genotype)', data=df).fit()
anova_table = sm.stats.anova_lm(model2, typ=2)

# Model comparison ANOVA (nested models)
model_reduced = smf.ols('y ~ x1', data=df).fit()
model_full = smf.ols('y ~ x1 + x2 + x3', data=df).fit()
anova_table = sm.stats.anova_lm(model_reduced, model_full)
```

## Diagnostic Plots

```python
import statsmodels.api as sm
import matplotlib.pyplot as plt

results = smf.ols('y ~ x1 + x2', data=df).fit()

# QQ-plot of residuals
fig = sm.qqplot(results.resid, line='s')
plt.title('QQ Plot of Residuals')
plt.tight_layout()
plt.savefig('qq_plot.png', dpi=150)
plt.close()

# Leverage vs residuals-squared (identifies influential observations)
fig = sm.graphics.plot_leverage_resid2(results)
fig.tight_layout()
plt.savefig('leverage_resid2.png', dpi=150)
plt.close()

# Residuals vs fitted
fig, ax = plt.subplots(figsize=(8, 5))
ax.scatter(results.fittedvalues, results.resid, alpha=0.5)
ax.axhline(0, color='red', linestyle='--')
ax.set_xlabel('Fitted Values')
ax.set_ylabel('Residuals')
ax.set_title('Residuals vs Fitted')
plt.tight_layout()
plt.savefig('resid_vs_fitted.png', dpi=150)
plt.close()
```

## Complete Workflow Example

```python
import pandas as pd
import statsmodels.api as sm
import statsmodels.formula.api as smf
import matplotlib.pyplot as plt

# Fit model with categorical and continuous predictors
model = smf.ols('expression ~ C(treatment, Treatment(reference="control")) + age + C(sex)',
                data=df).fit()
print(model.summary())

# ANOVA table
anova = sm.stats.anova_lm(model, typ=2)
print(anova)

# Predictions with CI
pred = model.get_prediction(df)
pred_df = pred.summary_frame(alpha=0.05)

# Diagnostics
fig = sm.qqplot(model.resid, line='s')
plt.tight_layout()
plt.savefig('diagnostics_qq.png', dpi=150)
plt.close()

fig = sm.graphics.plot_leverage_resid2(model)
fig.tight_layout()
plt.savefig('diagnostics_leverage.png', dpi=150)
plt.close()
```

## Gotchas

- Formula interface (`smf.ols`) auto-adds intercept. Matrix interface (`sm.OLS`) does not -- use `sm.add_constant(X)`.
- `C()` is required to treat numeric columns as categorical; string columns are auto-detected.
- `typ=2` ANOVA (default in R) tests each term after adjusting for all others. `typ=1` is sequential (order-dependent). `typ=3` requires orthogonal contrasts.
- `predict()` with formula models requires a DataFrame with the same column names as the training data.
- `GLM.fit()` uses IRLS by default. For convergence issues, increase `maxiter` or try `fit(method='newton')`.
- `MixedLM` can be slow for large datasets. Consider `groups` with many levels carefully.
- `I()` is needed for arithmetic in formulas: `I(x**2)`, `I(x1 + x2)`. Without it, `+` means "add predictor".
