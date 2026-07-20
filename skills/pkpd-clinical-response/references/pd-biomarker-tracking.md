# Pharmacodynamic Biomarker Tracking Reference

Methods for longitudinal PD marker assessment, PK-PD hysteresis
analysis, and PD response classification.

## Core Imports

```python
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import statsmodels.formula.api as smf
```

## Longitudinal PD Marker Assessment

### Timepoint Naming Convention

| Notation | Meaning |
|----------|---------|
| C1D1 | Cycle 1, Day 1 |
| C1D8 | Cycle 1, Day 8 |
| C2D1 | Cycle 2, Day 1 |
| 1w post | 1 week post last dose |
| pre-dose | Before dosing (trough) |
| 2h post-dose | 2 hours after dosing (near Tmax) |

### Change from Baseline

```python
def compute_pd_change(df, marker_col, subject_col, timepoint_col,
                       baseline_label="C1D1"):
    """
    Compute absolute and percent change from baseline for a PD marker.

    Parameters
    ----------
    df : DataFrame
        Must contain marker values, subject IDs, timepoints.
    marker_col : str
        Column with PD marker values.
    subject_col : str
        Column with subject identifiers.
    timepoint_col : str
        Column with timepoint labels.
    baseline_label : str
        Timepoint label for baseline (default "C1D1").

    Returns
    -------
    DataFrame
        Original data plus baseline, abs_change, pct_change columns.
    """
    baseline = (
        df[df[timepoint_col] == baseline_label]
        .set_index(subject_col)[marker_col]
        .rename("baseline")
    )
    merged = df.merge(baseline, on=subject_col)
    merged["abs_change"] = merged[marker_col] - merged["baseline"]
    merged["pct_change"] = (
        (merged[marker_col] - merged["baseline"]) / merged["baseline"] * 100
    )
    return merged
```

### PD Timecourse Plots

```python
def plot_pd_timecourse(df, marker_col, timepoint_col, subject_col,
                        group_col=None, ylabel="Marker Value"):
    """
    Plot longitudinal PD marker: absolute values and % change.

    Parameters
    ----------
    df : DataFrame
        Must contain marker values, pct_change, subject_col.
    marker_col : str
        Column with PD marker values.
    timepoint_col : str
        Column with timepoint labels.
    subject_col : str
        Column with subject identifiers.
    group_col : str, optional
        Column for group stratification (e.g., dose level).
    ylabel : str
        Y-axis label for absolute panel.

    Returns
    -------
    Figure
        Two-panel figure (absolute + percent change).
    """
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))

    # Panel 1: Absolute values
    ax = axes[0]
    for subj, sdf in df.groupby(subject_col):
        ax.plot(sdf[timepoint_col], sdf[marker_col], alpha=0.3,
                color="gray")
    if group_col:
        for grp, gdf in df.groupby(group_col):
            means = gdf.groupby(timepoint_col)[marker_col].mean()
            ax.plot(means.index, means.values, linewidth=2, label=grp)
        ax.legend()
    ax.set_ylabel(ylabel)
    ax.set_xlabel("Timepoint")
    ax.set_title("Absolute Values")

    # Panel 2: Percent change from baseline
    ax = axes[1]
    for subj, sdf in df.groupby(subject_col):
        ax.plot(sdf[timepoint_col], sdf["pct_change"], alpha=0.3,
                color="gray")
    if group_col:
        for grp, gdf in df.groupby(group_col):
            means = gdf.groupby(timepoint_col)["pct_change"].mean()
            ax.plot(means.index, means.values, linewidth=2, label=grp)
        ax.legend()
    ax.axhline(0, color="black", linestyle="--", linewidth=0.5)
    ax.set_ylabel("% Change from Baseline")
    ax.set_xlabel("Timepoint")
    ax.set_title("Change from Baseline")

    plt.tight_layout()
    return fig
```

### Spaghetti + Mean Plot (Dose Stratified)

```python
def plot_pd_by_dose(df, marker_col, timepoint_col, subject_col,
                     dose_col, ylabel="Marker Value"):
    """
    PD marker spaghetti plot with dose-group mean overlay.
    Individual traces in gray, dose-group means as colored bold lines.
    """
    fig, ax = plt.subplots(figsize=(10, 6))

    for subj, sdf in df.groupby(subject_col):
        ax.plot(sdf[timepoint_col], sdf[marker_col], alpha=0.15,
                color="gray", linewidth=0.8)

    for dose, gdf in df.groupby(dose_col):
        means = gdf.groupby(timepoint_col)[marker_col].mean()
        sems = gdf.groupby(timepoint_col)[marker_col].sem()
        ax.errorbar(means.index, means.values, yerr=sems.values,
                    linewidth=2, capsize=3, label=f"{dose}")

    ax.set_xlabel("Timepoint")
    ax.set_ylabel(ylabel)
    ax.legend(title="Dose")
    ax.set_title("PD Marker by Dose Level")
    plt.tight_layout()
    return fig
```

## PD Response Classification

### Standard Thresholds

| Category | Typical Threshold | Use Case |
|----------|------------------|----------|
| PD responder | >= 50% decrease from baseline | Phospho-protein inhibition, enzyme activity |
| PD partial responder | 30-50% decrease | Cytokine reduction, biomarker modulation |
| PD non-responder | < 30% decrease | No meaningful target modulation |
| PD rebound | Return to >= 80% of baseline after initial decrease | Resistance development, washout |

### Classification Function

```python
def classify_pd_response(pct_change_at_timepoint,
                          responder_threshold=-50,
                          partial_threshold=-30,
                          rebound_threshold=-20,
                          baseline_pct_change=None):
    """
    Classify PD response based on percent change from baseline.

    Parameters
    ----------
    pct_change_at_timepoint : float
        Percent change from baseline at the assessment timepoint.
    responder_threshold : float
        Threshold for PD responder (default: -50%).
    partial_threshold : float
        Threshold for partial responder (default: -30%).
    rebound_threshold : float
        If prior best change was below partial but current is above
        this, classify as rebound.
    baseline_pct_change : float, optional
        Best prior percent change. If provided and current is above
        rebound_threshold while prior was below partial, returns
        "PD_rebound".

    Returns
    -------
    str
        "PD_responder", "PD_partial", "PD_non_responder", or
        "PD_rebound".
    """
    if (baseline_pct_change is not None
            and baseline_pct_change <= partial_threshold
            and pct_change_at_timepoint > rebound_threshold):
        return "PD_rebound"

    if pct_change_at_timepoint <= responder_threshold:
        return "PD_responder"
    elif pct_change_at_timepoint <= partial_threshold:
        return "PD_partial"
    else:
        return "PD_non_responder"


def assign_pd_response(df, subject_col, pct_change_col,
                        timepoint_col, assessment_timepoint,
                        responder_threshold=-50,
                        partial_threshold=-30):
    """
    Assign PD response category per subject at a given timepoint.

    Returns
    -------
    Series
        PD response category indexed by subject.
    """
    at_tp = df[df[timepoint_col] == assessment_timepoint]
    return at_tp.set_index(subject_col)[pct_change_col].apply(
        lambda x: classify_pd_response(
            x,
            responder_threshold=responder_threshold,
            partial_threshold=partial_threshold,
        )
    )
```

## PK-PD Hysteresis

Hysteresis plots reveal the temporal relationship between drug
concentration and pharmacodynamic effect.

### Types

| Type | Loop Direction | Mechanism | Common Examples |
|------|---------------|-----------|-----------------|
| Counter-clockwise | Effect lags concentration | Indirect response, signal transduction delay, active metabolite | Most oncology PD markers, immune modulation |
| Clockwise | Effect precedes concentration decline | Tolerance, receptor desensitization, distribution lag | Benzodiazepine sedation, opioid analgesia |
| No hysteresis | No loop (overlay) | Direct effect, rapid equilibrium | In vitro enzyme inhibition |

### Hysteresis Plot

```python
def plot_pkpd_hysteresis(conc, effect, time, subject_id=None):
    """
    Plot PK-PD hysteresis loop colored by time.

    Parameters
    ----------
    conc : array-like
        Drug concentration at each timepoint.
    effect : array-like
        PD effect at each timepoint.
    time : array-like
        Sampling times (used for color gradient).
    subject_id : str, optional
        Subject label for title.

    Returns
    -------
    Figure
    """
    fig, ax = plt.subplots(figsize=(7, 6))

    sc = ax.scatter(conc, effect, c=time, cmap="viridis", s=40,
                    zorder=3)
    ax.plot(conc, effect, alpha=0.4, color="gray")

    mid = len(conc) // 2
    if mid > 0:
        ax.annotate(
            "", xy=(conc[mid], effect[mid]),
            xytext=(conc[mid - 1], effect[mid - 1]),
            arrowprops=dict(arrowstyle="->", color="red", lw=1.5),
        )

    plt.colorbar(sc, label="Time (h)")
    ax.set_xlabel("Drug Concentration")
    ax.set_ylabel("PD Effect")
    title = "PK-PD Hysteresis"
    if subject_id:
        title += f" — {subject_id}"
    ax.set_title(title)
    plt.tight_layout()
    return fig
```

### Diagnosing Hysteresis Direction

```python
def diagnose_hysteresis(conc, effect):
    """
    Determine hysteresis direction from concentration-effect data.

    Computes the signed area enclosed by the ascending and
    descending concentration limbs. Positive = counter-clockwise
    (effect lags), negative = clockwise.

    Parameters
    ----------
    conc : array-like
        Concentrations (ascending then descending).
    effect : array-like
        PD effect values.

    Returns
    -------
    dict
        direction ("counter-clockwise", "clockwise", or "none"),
        signed_area.
    """
    from scipy import integrate

    conc = np.asarray(conc, dtype=float)
    effect = np.asarray(effect, dtype=float)

    # Shoelace/Green's theorem: the closed integral of y*dx is NEGATIVE for a
    # counter-clockwise loop and POSITIVE for a clockwise one. Negate so that
    # positive signed_area means counter-clockwise.
    signed_area = -integrate.trapezoid(effect, conc)

    if abs(signed_area) < 0.01 * np.ptp(conc) * np.ptp(effect):
        direction = "none"
    elif signed_area > 0:
        direction = "counter-clockwise"
    else:
        direction = "clockwise"

    return {"direction": direction, "signed_area": signed_area}
```

## PD-Exposure Correlation

### Mixed-Effects Model

Use mixed-effects models to correlate PD marker changes with drug
exposure, accounting for repeated measures within subjects.

```python
def pd_exposure_model(df, pd_col, exposure_col, subject_col,
                       covariates=None, log_exposure=True):
    """
    Fit PD change ~ exposure with random intercept per subject.

    Parameters
    ----------
    df : DataFrame
    pd_col : str
        Column with PD marker percent change.
    exposure_col : str
        Column with exposure metric (AUC, Cmax, Cavg).
    subject_col : str
        Column with subject identifiers.
    covariates : list of str, optional
        Additional fixed-effect covariates.
    log_exposure : bool
        Log-transform exposure (default True — PK parameters are
        log-normally distributed).

    Returns
    -------
    MixedLMResults
    """
    exp_term = f"np.log({exposure_col})" if log_exposure else exposure_col
    formula = f"{pd_col} ~ {exp_term}"
    if covariates:
        formula += " + " + " + ".join(covariates)

    model = smf.mixedlm(
        formula, data=df, groups=df[subject_col],
    )
    return model.fit()
```

### Interpreting the Relationship

| Pattern | Description | Implication |
|---------|-------------|-------------|
| Monotonic negative | More exposure → more marker decrease | On-target, dose-dependent modulation |
| Saturating | Marker decrease plateaus at high exposure | Target fully engaged above threshold |
| Bell-shaped | Marker decrease reverses at very high exposure | Off-target effects or feedback activation |
| Flat | No relationship | Wrong marker, wrong timepoint, or non-PK-driven biology |

### PD-Exposure Scatter with Regression

```python
def plot_pd_exposure(df, pd_col, exposure_col, fit_result=None,
                      exposure_name="AUC_ss"):
    """
    Scatter plot of PD change vs exposure with regression line.
    """
    fig, ax = plt.subplots(figsize=(8, 6))

    ax.scatter(df[exposure_col], df[pd_col], alpha=0.5,
               color="steelblue", s=30)

    if fit_result is not None:
        x_range = np.linspace(
            df[exposure_col].min() * 0.8,
            df[exposure_col].max() * 1.2,
            100,
        )
        pred_df = pd.DataFrame({exposure_col: x_range})
        y_pred = fit_result.predict(pred_df)
        ax.plot(x_range, y_pred, color="red", linewidth=2)

    ax.set_xlabel(exposure_name)
    ax.set_ylabel("PD Marker % Change from Baseline")
    ax.axhline(0, color="gray", linestyle="--", alpha=0.3)
    ax.set_title(f"PD-Exposure Relationship ({exposure_name})")
    plt.tight_layout()
    return fig
```

## Waterfall Plot

```python
def plot_pd_waterfall(subjects, pct_changes, responder_threshold=-50,
                       partial_threshold=-30, ylabel="Best % Change"):
    """
    Waterfall plot of best PD marker change per subject.

    Parameters
    ----------
    subjects : array-like
        Subject identifiers.
    pct_changes : array-like
        Best percent change from baseline per subject.
    responder_threshold : float
        Threshold line for PD responder.
    partial_threshold : float
        Threshold line for partial responder.

    Returns
    -------
    Figure
    """
    order = np.argsort(pct_changes)
    sorted_changes = np.asarray(pct_changes)[order]

    fig, ax = plt.subplots(figsize=(12, 6))
    colors = []
    for x in sorted_changes:
        if x <= responder_threshold:
            colors.append("green")
        elif x <= partial_threshold:
            colors.append("orange")
        else:
            colors.append("gray")

    ax.bar(range(len(sorted_changes)), sorted_changes, color=colors)
    ax.axhline(responder_threshold, color="green", linestyle="--",
               label=f"Responder ({responder_threshold}%)")
    ax.axhline(partial_threshold, color="orange", linestyle="--",
               label=f"Partial ({partial_threshold}%)")
    ax.set_ylabel(ylabel)
    ax.set_xlabel("Patient")
    ax.legend()
    ax.set_title("PD Biomarker Waterfall")
    plt.tight_layout()
    return fig
```

## Gotchas

- **Baseline timing matters**: Pre-dose C1D1 is the standard baseline.
  Post-dose C1D1 already reflects drug effect and will underestimate
  change. Document exactly when the baseline sample was drawn.
- **Multiple markers**: When tracking multiple PD markers, apply
  multiplicity correction (Bonferroni or FDR) when testing for
  significance. Report the correction method.
- **Assay variability**: PD markers often have higher inter-assay CV
  than PK assays. A 20% change may be within assay noise for some
  markers. Report assay CV alongside marker changes.
- **PD vs clinical response**: PD biomarker response is NOT the same
  as clinical response (RECIST). A patient can be a PD responder
  (target modulated) but a clinical non-responder (tumor not
  shrinking). Always distinguish these clearly.
- **Hysteresis requires paired PK-PD**: Both concentration and PD
  effect must be measured at the same timepoints. Interpolated PK
  from a population model is acceptable; interpolated PD is not.
- **Log-transform exposure**: PK parameters (AUC, Cmax) are
  log-normally distributed. Always use log-transformed exposure in
  mixed-effects models unless you have a specific reason not to.
