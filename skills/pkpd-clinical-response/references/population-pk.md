# Two-Stage PK Covariate Analysis Reference

Regressing **already-derived** per-subject PK parameters on patient covariates.
Stage one is NCA (see `nca-analysis.md`), which gives each subject a CL/F, Vd/F
and t1/2; stage two, here, explains the spread in those numbers.

**This is not population PK, and the distinction is not cosmetic.** There is no
structural model here, so nothing in this file estimates absorption,
distribution or elimination, extrapolates to another regimen, or partitions
variability into IIV and residual error. For that, see
`population-pk-nlme.md` (nlmixr2), which fits structure, IIV and error
simultaneously from concentration-time data.

Two-stage is valid, and simpler, when **sampling is rich enough that each
subject's parameters are well estimated on their own**. It degrades as sampling
gets sparser, because stage two treats imprecise stage-one estimates as if they
were observed values — biasing covariate effects toward the null. With sparse
sampling, use NLME instead; there is no threshold at which two-stage becomes
merely approximate rather than wrong.

**Use a mixed model here only when subjects contribute more than one parameter
estimate** — repeated occasions, cycles, or crossover periods — where the random
effect captures inter-occasion variability. With a single CL per subject, a
per-subject random intercept has one observation per group, absorbs the residual
exactly, and is unidentifiable. That case is ordinary least squares
(`smf.ols`), not `smf.mixedlm`, and the examples below should be read with
`groups=` dropped.

## Core Imports

```python
import statsmodels.formula.api as smf
import statsmodels.api as sm
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
```

## statsmodels for Two-Stage Covariate Analysis

### Basic Covariate Model

`CL` here is one derived clearance per subject-occasion, from NCA — not a
concentration.

```python
# One estimate per subject: no random effect to fit.
result = smf.ols("np.log(CL) ~ age + weight + sex + eGFR", data=pk_data).fit()

# Repeated occasions per subject: the random intercept is inter-occasion
# variability, and only then is mixedlm the right model.
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
