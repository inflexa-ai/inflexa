# Dose-Response and Exposure-Response Reference

Methods for fitting dose-response curves and linking drug exposure
to efficacy and safety outcomes.

## Core Imports

```python
import numpy as np
import pandas as pd
from scipy.optimize import curve_fit
from sklearn.linear_model import LogisticRegression
from lifelines import KaplanMeierFitter
from lifelines.statistics import logrank_test
import matplotlib.pyplot as plt
```

## Dose-Response Curve Fitting

### 4-Parameter Logistic (Hill Equation)

The standard model for sigmoidal dose-response relationships:

```python
def four_param_logistic(x, bottom, top, ec50, hill):
    """
    4-parameter logistic (4PL) / Hill equation.

    Parameters
    ----------
    x : array-like
        Dose or concentration values.
    bottom : float
        Response at zero dose (baseline).
    top : float
        Maximum response (Emax + baseline).
    ec50 : float
        Dose/concentration producing 50% of maximal effect.
    hill : float
        Hill coefficient (slope factor). hill=1 is standard.
        hill>1 is steep (switch-like), hill<1 is shallow.

    Returns
    -------
    array
        Predicted response values.
    """
    return bottom + (top - bottom) / (1 + (ec50 / x) ** hill)


def fit_dose_response(doses, responses, model="4pl"):
    """
    Fit dose-response curve with confidence intervals.

    Returns
    -------
    dict
        Parameters (bottom, top, ec50, hill), R², parameter CIs.
    """
    doses = np.asarray(doses, dtype=float)
    responses = np.asarray(responses, dtype=float)

    p0 = [np.min(responses), np.max(responses), np.median(doses), 1.0]
    bounds = (
        [0, 0, 0, 0.1],
        [np.inf, np.inf, np.max(doses) * 10, 10],
    )

    popt, pcov = curve_fit(
        four_param_logistic, doses, responses,
        p0=p0, bounds=bounds, maxfev=10000,
    )

    # R-squared
    predicted = four_param_logistic(doses, *popt)
    ss_res = np.sum((responses - predicted) ** 2)
    ss_tot = np.sum((responses - np.mean(responses)) ** 2)
    r_squared = 1 - ss_res / ss_tot if ss_tot > 0 else np.nan

    # Parameter confidence intervals from covariance matrix
    perr = np.sqrt(np.diag(pcov))
    ci_95 = 1.96 * perr

    return {
        "bottom": popt[0],
        "top": popt[1],
        "ec50": popt[2],
        "hill": popt[3],
        "emax": popt[1] - popt[0],
        "r_squared": r_squared,
        "param_se": {"bottom": perr[0], "top": perr[1],
                     "ec50": perr[2], "hill": perr[3]},
        "ec50_ci95": (popt[2] - ci_95[2], popt[2] + ci_95[2]),
    }
```

### 3-Parameter Logistic (Fixed Bottom)

When baseline response is known to be zero:

```python
def three_param_logistic(x, top, ec50, hill):
    """3PL: bottom fixed at 0."""
    return top / (1 + (ec50 / x) ** hill)
```

### Plotting Dose-Response

```python
def plot_dose_response(doses, responses, fit_params, xlabel="Dose",
                        ylabel="Response", log_x=True):
    """
    Plot observed data + fitted curve + 95% CI band.
    """
    fig, ax = plt.subplots(figsize=(8, 6))

    ax.scatter(doses, responses, color="steelblue", s=40,
               label="Observed", zorder=3)

    x_fit = np.geomspace(min(doses) * 0.5, max(doses) * 2, 200)
    y_fit = four_param_logistic(
        x_fit, fit_params["bottom"], fit_params["top"],
        fit_params["ec50"], fit_params["hill"],
    )
    ax.plot(x_fit, y_fit, color="red", linewidth=2, label="Fitted 4PL")

    # EC50 reference line
    ax.axvline(fit_params["ec50"], color="gray", linestyle="--",
               alpha=0.5, label=f"EC50 = {fit_params['ec50']:.2g}")

    if log_x:
        ax.set_xscale("log")
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    ax.legend()
    ax.set_title(
        f"R² = {fit_params['r_squared']:.3f}, "
        f"Hill = {fit_params['hill']:.2f}"
    )
    plt.tight_layout()
    return fig
```

## Exposure-Response Analysis

### Efficacy Exposure-Response (Binary Outcome)

```python
def exposure_response_binary(exposure, response, exposure_name="AUC_ss"):
    """
    Logistic regression: P(response=1) ~ exposure.

    Parameters
    ----------
    exposure : array-like
        Drug exposure metric (AUC, Cmax, Cmin, Cavg).
    response : array-like
        Binary outcome (0/1).
    exposure_name : str
        Name for labeling.

    Returns
    -------
    dict
        EC50, slope, AUC-ROC, model coefficients.
    """
    X = np.asarray(exposure).reshape(-1, 1)
    y = np.asarray(response)

    model = LogisticRegression(solver="lbfgs", max_iter=1000)
    model.fit(X, y)

    b0 = model.intercept_[0]
    b1 = model.coef_[0][0]

    # EC50: exposure at 50% response probability
    ec50 = -b0 / b1 if b1 != 0 else np.nan

    # Predicted probabilities for ROC
    probs = model.predict_proba(X)[:, 1]
    from sklearn.metrics import roc_auc_score
    auc_roc = roc_auc_score(y, probs) if len(np.unique(y)) == 2 else np.nan

    return {
        "ec50": ec50,
        "intercept": b0,
        "slope": b1,
        "auc_roc": auc_roc,
        "exposure_name": exposure_name,
    }


def plot_exposure_response(exposure, response, fit_result,
                            exposure_name="AUC_ss"):
    """
    Plot binary exposure-response with logistic curve and data.
    """
    fig, ax = plt.subplots(figsize=(8, 6))

    ax.scatter(exposure, response, alpha=0.5, color="steelblue", s=30)

    x_range = np.linspace(min(exposure) * 0.8, max(exposure) * 1.2, 200)
    b0, b1 = fit_result["intercept"], fit_result["slope"]
    y_pred = 1 / (1 + np.exp(-(b0 + b1 * x_range)))
    ax.plot(x_range, y_pred, color="red", linewidth=2)

    ax.axvline(fit_result["ec50"], color="gray", linestyle="--",
               label=f"EC50 = {fit_result['ec50']:.1f}")
    ax.axhline(0.5, color="gray", linestyle=":", alpha=0.3)

    ax.set_xlabel(f"{exposure_name}")
    ax.set_ylabel("P(Response)")
    ax.set_ylim(-0.05, 1.05)
    ax.legend()
    ax.set_title(f"Exposure-Response (AUC-ROC = {fit_result['auc_roc']:.3f})")
    plt.tight_layout()
    return fig
```

### Safety Exposure-Response (Time-to-Event)

```python
def safety_exposure_response(df, exposure_col, time_col, event_col,
                               n_quartiles=4):
    """
    Time to first grade 3+ AE by exposure quartile.

    Parameters
    ----------
    df : DataFrame
        Must contain exposure, time-to-AE, and AE event columns.
    exposure_col : str
        Column with exposure metric.
    time_col : str
        Column with time to first AE (or censoring).
    event_col : str
        Column with event indicator (1 = AE, 0 = censored).

    Returns
    -------
    dict
        KM fits per quartile, logrank p-value, figure.
    """
    df = df.copy()
    df["exposure_quartile"] = pd.qcut(
        df[exposure_col], q=n_quartiles, labels=[f"Q{i+1}" for i in range(n_quartiles)]
    )

    fig, ax = plt.subplots(figsize=(8, 6))
    kmf = KaplanMeierFitter()

    medians = {}
    for q, gdf in df.groupby("exposure_quartile"):
        kmf.fit(gdf[time_col], gdf[event_col], label=f"{q}")
        kmf.plot_survival_function(ax=ax)
        medians[q] = kmf.median_survival_time_

    # Log-rank: lowest vs highest quartile
    q1 = df[df["exposure_quartile"] == "Q1"]
    qn = df[df["exposure_quartile"] == f"Q{n_quartiles}"]
    lr = logrank_test(
        q1[time_col], qn[time_col],
        event_observed_A=q1[event_col],
        event_observed_B=qn[event_col],
    )

    ax.set_xlabel("Time")
    ax.set_ylabel("Probability Free of Grade 3+ AE")
    ax.set_title(f"Safety E-R (Q1 vs Q{n_quartiles} log-rank p = {lr.p_value:.4f})")
    plt.tight_layout()

    return {
        "median_time_by_quartile": medians,
        "logrank_p": lr.p_value,
        "figure": fig,
    }
```

### Therapeutic Window

```python
def identify_therapeutic_window(exposure, efficacy_response,
                                  safety_response):
    """
    Identify exposure range where efficacy is maintained and safety
    is acceptable.

    Parameters
    ----------
    exposure : array-like
        Exposure values.
    efficacy_response : array-like
        Binary efficacy (0/1).
    safety_response : array-like
        Binary safety event (0 = safe, 1 = AE).

    Returns
    -------
    dict
        Efficacy EC50, safety EC50, therapeutic index.
    """
    eff = exposure_response_binary(exposure, efficacy_response,
                                    "Efficacy")
    saf = exposure_response_binary(exposure, safety_response,
                                    "Safety")

    ti = saf["ec50"] / eff["ec50"] if eff["ec50"] > 0 else np.nan

    return {
        "efficacy_ec50": eff["ec50"],
        "safety_ec50": saf["ec50"],
        "therapeutic_index": ti,
        "window": (eff["ec50"], saf["ec50"]) if ti > 1 else None,
    }
```

| Therapeutic Index | Interpretation |
|-------------------|----------------|
| > 10 | Wide — comfortable dosing margin |
| 3-10 | Moderate — therapeutic drug monitoring may help |
| 1-3 | Narrow — dose optimization critical |
| < 1 | Inverted — no safe efficacious exposure exists |

## Gotchas

- **Exposure-response ≠ dose-response**: Exposure accounts for PK
  variability between patients. Same dose can yield 10-fold AUC
  variation. Always prefer exposure metrics over dose when PK data
  is available.
- **EC50 from logistic regression**: Valid only when the logistic
  assumption holds (sigmoidal probability). Check calibration.
- **curve_fit convergence**: `maxfev=10000` prevents premature
  termination. If it still fails, try different `p0` starting values.
- **curve_fit pcov**: If pcov is `inf`, the fit is not reliable — the
  model is over-parameterized or the data is insufficient.
- **Log-scale dose-response**: Always plot dose/exposure on log scale
  for dose-response curves. Linear scale compresses the interesting
  region around EC50.
