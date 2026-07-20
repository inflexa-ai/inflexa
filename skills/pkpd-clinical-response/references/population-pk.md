# Population PK Covariate Analysis Reference

Mixed-effects modeling for identifying patient covariates that
explain inter-individual variability in pharmacokinetics.

## Core Imports

```python
import statsmodels.formula.api as smf
import statsmodels.api as sm
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
```

## statsmodels MixedLM for Population PK

### Basic Covariate Model

```python
# Log-transformed clearance with demographic covariates
model = smf.mixedlm(
    "np.log(CL) ~ age + weight + sex + eGFR",
    data=pk_data,
    groups=pk_data["subject_id"],
)
result = model.fit()

# Summary with coefficients, p-values, confidence intervals
print(result.summary())

# Extract fixed effects
fixed_effects = result.fe_params         # Series of coefficients
p_values = result.pvalues                # Series of p-values
conf_int = result.conf_int()             # DataFrame of 95% CI
```

### Random Effects Specification

```python
# Random intercept only (default)
model = smf.mixedlm(
    "np.log(CL) ~ weight + eGFR",
    data=pk_data,
    groups=pk_data["subject_id"],
)

# Random intercept + random slope on weight
model = smf.mixedlm(
    "np.log(CL) ~ weight + eGFR",
    data=pk_data,
    groups=pk_data["subject_id"],
    re_formula="~weight",
)

# Multiple random effects
model = smf.mixedlm(
    "np.log(CL) ~ weight + eGFR + age",
    data=pk_data,
    groups=pk_data["subject_id"],
    re_formula="~weight + eGFR",
)
```

### Formula Syntax

| Formula Element | Meaning | Example |
|----------------|---------|---------|
| `y ~ x1 + x2` | Additive fixed effects | `np.log(CL) ~ weight + eGFR` |
| `C(var)` | Categorical variable | `C(sex)`, `C(race)` |
| `C(var, Treatment(ref))` | Categorical with reference | `C(sex, Treatment(reference="M"))` |
| `x1 * x2` | Main effects + interaction | `weight * sex` = weight + sex + weight:sex |
| `x1 : x2` | Interaction only | `weight : sex` |
| `I(x**2)` | Polynomial (protect from patsy) | `I(weight**2)` |
| `np.log(x)` | Log transformation | `np.log(eGFR)` |

### Result Attributes

| Attribute | Type | Description |
|-----------|------|-------------|
| `result.fe_params` | Series | Fixed-effect parameter estimates |
| `result.pvalues` | Series | P-values for fixed effects |
| `result.conf_int()` | DataFrame | 95% CI for fixed effects |
| `result.bse` | Series | Standard errors |
| `result.random_effects` | dict | Per-group random effect estimates |
| `result.aic` | float | Akaike information criterion |
| `result.bic` | float | Bayesian information criterion |
| `result.llf` | float | Log-likelihood |
| `result.cov_re` | ndarray | Random effects covariance matrix |

## Covariate Selection

### Forward Addition

```python
def forward_selection(pk_data, base_formula, candidate_covariates,
                       group_col="subject_id", alpha=0.05):
    """
    Forward covariate selection for population PK model.

    Starts with base model, adds one covariate at a time,
    keeps the one with lowest AIC if p < alpha.

    Parameters
    ----------
    pk_data : DataFrame
    base_formula : str
        Starting formula (e.g., "np.log(CL) ~ 1").
    candidate_covariates : list of str
        Covariate terms to test (e.g., ["weight", "age", "C(sex)"]).
    group_col : str
        Column for random effects grouping.
    alpha : float
        Significance threshold for inclusion.

    Returns
    -------
    list of str
        Selected covariates in order of addition.
    """
    selected = []
    remaining = list(candidate_covariates)
    current_formula = base_formula

    while remaining:
        results = {}
        for cov in remaining:
            test_formula = f"{current_formula} + {cov}"
            try:
                model = smf.mixedlm(
                    test_formula, data=pk_data,
                    groups=pk_data[group_col],
                )
                fit = model.fit(reml=False)
                results[cov] = {"aic": fit.aic, "pval": fit.pvalues.get(cov, 1.0)}
            except Exception:
                continue

        if not results:
            break

        best_cov = min(results, key=lambda c: results[c]["aic"])
        if results[best_cov]["pval"] < alpha:
            selected.append(best_cov)
            remaining.remove(best_cov)
            current_formula = f"{current_formula} + {best_cov}"
        else:
            break

    return selected
```

### Backward Elimination

```python
def backward_elimination(pk_data, full_formula, group_col="subject_id",
                          alpha=0.01):
    """
    Backward elimination: start with full model, remove least
    significant covariate until all p < alpha.

    Note: stricter alpha (0.01) for backward to prevent removing
    important covariates.
    """
    current_terms = full_formula.split("~")[1].strip().split("+")
    current_terms = [t.strip() for t in current_terms]
    dep_var = full_formula.split("~")[0].strip()

    while len(current_terms) > 0:
        formula = f"{dep_var} ~ {' + '.join(current_terms)}"
        model = smf.mixedlm(
            formula, data=pk_data, groups=pk_data[group_col],
        )
        fit = model.fit(reml=False)

        # Find least significant term
        pvals = fit.pvalues.drop("Intercept", errors="ignore")
        pvals = pvals.drop("Group Var", errors="ignore")

        if pvals.empty or pvals.max() < alpha:
            break

        worst = pvals.idxmax()
        current_terms = [t for t in current_terms if t.strip() != worst]

    return current_terms
```

## Standard PK Covariates

| Covariate | Expected Effect on CL | Biological Rationale |
|-----------|----------------------|---------------------|
| Weight/BSA | Positive (allometric) | Larger body = larger organ volumes |
| Age | Negative (elderly) | Reduced hepatic/renal function |
| Sex | Variable | Differences in body composition, enzymes |
| eGFR/CrCl | Positive (for renally cleared drugs) | Renal elimination capacity |
| Child-Pugh | Negative (hepatic impairment) | Reduced hepatic metabolism |
| CYP genotype | Variable | PM, IM, EM, UM metabolizer status |
| Albumin | Positive (for protein-bound drugs) | Binding capacity affects distribution |
| Total bilirubin | Negative (hepatic marker) | Hepatic dysfunction marker |

### Allometric Scaling

For body-size covariates, standard allometric exponents are:

```python
# Weight-normalized clearance (allometric)
# CL = CL_ref * (WT / WT_ref) ^ 0.75
# V  = V_ref  * (WT / WT_ref) ^ 1.0
pk_data["CL_allometric"] = pk_data["CL"] / (pk_data["weight"] / 70) ** 0.75
pk_data["V_allometric"] = pk_data["V"] / (pk_data["weight"] / 70) ** 1.0
```

## Diagnostic Plots

```python
def population_pk_diagnostics(pk_data, fit_result, dep_var="np.log(CL)"):
    """
    Standard population PK diagnostic plots.
    """
    fig, axes = plt.subplots(2, 2, figsize=(12, 10))

    residuals = fit_result.resid
    fitted = fit_result.fittedvalues

    # 1. Residuals vs Fitted
    ax = axes[0, 0]
    ax.scatter(fitted, residuals, alpha=0.5, s=20)
    ax.axhline(0, color="red", linestyle="--")
    ax.set_xlabel("Fitted Values")
    ax.set_ylabel("Residuals")
    ax.set_title("Residuals vs Fitted")

    # 2. QQ plot of residuals
    ax = axes[0, 1]
    sm.qqplot(residuals, line="45", ax=ax)
    ax.set_title("QQ Plot of Residuals")

    # 3. Observed vs Predicted
    ax = axes[1, 0]
    observed = fit_result.model.endog
    ax.scatter(fitted, observed, alpha=0.5, s=20)
    lims = [min(fitted.min(), observed.min()),
            max(fitted.max(), observed.max())]
    ax.plot(lims, lims, "r--")
    ax.set_xlabel("Predicted")
    ax.set_ylabel("Observed")
    ax.set_title("Observed vs Predicted")

    # 4. Random effects distribution
    ax = axes[1, 1]
    # random_effects maps group -> pandas Series. `.values` is a numpy
    # ATTRIBUTE, not a method: `v.values()[0]` raises
    # "TypeError: 'numpy.ndarray' object is not callable".
    re = pd.Series({k: v.iloc[0] for k, v in
                     fit_result.random_effects.items()})
    ax.hist(re, bins=20, edgecolor="black", alpha=0.7)
    ax.set_xlabel("Random Intercept")
    ax.set_ylabel("Count")
    ax.set_title("Random Effects Distribution")

    plt.tight_layout()
    return fig
```

## Gotchas

- **REML vs ML**: Use `reml=True` (default) for final parameter
  estimates. Use `reml=False` (ML) when comparing models with
  different fixed effects (AIC/BIC comparison requires ML).
- **Log transformation**: Always log-transform PK parameters (CL, V)
  before modeling. PK parameters are log-normally distributed.
- **Multicollinearity**: Weight and BSA are highly correlated. Choose
  one, not both. Check VIF if uncertain.
- **Convergence**: MixedLM may fail to converge with complex random
  effects. Start simple (random intercept only), then add complexity.
- **Small sample sizes**: With < 30 subjects, mixed-effects models
  may not reliably estimate random effect variances. Consider
  fixed-effects alternatives.
- **CYP genotype coding**: Use ordered categorical (PM < IM < EM < UM)
  or separate dummy variables, not numeric activity scores, unless
  the scoring system is validated.
