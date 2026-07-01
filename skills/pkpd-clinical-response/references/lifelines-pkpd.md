# Lifelines for PK/PD Time-to-Event Endpoints

Using the lifelines library for survival analysis endpoints commonly
derived in pharmacokinetic/pharmacodynamic and clinical response
contexts: duration of response (DOR), progression-free survival
(PFS), time-to-response (TTR), and safety exposure-response
(time-to-AE by exposure quartile).

## Core Imports

```python
from lifelines import KaplanMeierFitter, CoxPHFitter
from lifelines.statistics import logrank_test, multivariate_logrank_test
from lifelines.plotting import add_at_risk_counts
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
```

## Duration of Response (DOR)

Time from first documented response (CR or PR) to disease
progression (PD) or death.

```python
def compute_dor(df, subject_col, response_col, time_col,
                 censor_col=None):
    """
    Compute duration of response for responders.

    Parameters
    ----------
    df : DataFrame
        Per-visit assessment data with response and time columns.
    subject_col : str
        Column with subject identifiers.
    response_col : str
        Column with response category (CR, PR, SD, PD).
    time_col : str
        Column with study time (weeks or months from treatment start).
    censor_col : str, optional
        Column with censoring indicator. If None, inferred from
        whether PD was observed.

    Returns
    -------
    DataFrame
        One row per responder: subject, time_to_response,
        time_to_progression, dor, event (1=progressed, 0=censored).
    """
    records = []
    for subj, sdf in df.groupby(subject_col):
        sdf = sdf.sort_values(time_col)
        responses = sdf[response_col].tolist()
        times = sdf[time_col].tolist()

        first_response_idx = None
        for i, r in enumerate(responses):
            if r in ("CR", "PR"):
                first_response_idx = i
                break

        if first_response_idx is None:
            continue

        time_to_response = times[first_response_idx]

        progression_idx = None
        for i in range(first_response_idx + 1, len(responses)):
            if responses[i] == "PD":
                progression_idx = i
                break

        if progression_idx is not None:
            dor = times[progression_idx] - time_to_response
            event = 1
        else:
            dor = times[-1] - time_to_response
            event = 0

        records.append({
            subject_col: subj,
            "time_to_response": time_to_response,
            "dor": dor,
            "event": event,
        })

    return pd.DataFrame(records)


def plot_dor(dor_df, time_unit="months"):
    """
    Kaplan-Meier plot for duration of response.

    Parameters
    ----------
    dor_df : DataFrame
        Output from compute_dor (dor, event columns).
    time_unit : str
        Label for x-axis.

    Returns
    -------
    Figure
    """
    fig, ax = plt.subplots(figsize=(8, 6))

    kmf = KaplanMeierFitter()
    kmf.fit(dor_df["dor"], dor_df["event"], label="DOR")
    kmf.plot_survival_function(ax=ax)

    add_at_risk_counts(kmf, ax=ax)

    median = kmf.median_survival_time_
    ax.axhline(0.5, color="gray", linestyle=":", alpha=0.5)
    ax.set_xlabel(f"Time ({time_unit})")
    ax.set_ylabel("Probability of Continued Response")
    ax.set_title(f"Duration of Response (median: {median:.1f} {time_unit})")
    ax.set_ylim(0, 1.05)
    plt.tight_layout()
    return fig
```

## Progression-Free Survival (PFS)

Time from treatment start to disease progression or death from any
cause.

```python
def compute_pfs(df, subject_col, response_col, time_col):
    """
    Compute PFS from per-visit assessment data.

    Returns
    -------
    DataFrame
        One row per subject: subject, pfs_time, pfs_event.
    """
    records = []
    for subj, sdf in df.groupby(subject_col):
        sdf = sdf.sort_values(time_col)
        responses = sdf[response_col].tolist()
        times = sdf[time_col].tolist()

        pd_idx = None
        for i, r in enumerate(responses):
            if r == "PD":
                pd_idx = i
                break

        if pd_idx is not None:
            pfs_time = times[pd_idx]
            pfs_event = 1
        else:
            pfs_time = times[-1]
            pfs_event = 0

        records.append({
            subject_col: subj,
            "pfs_time": pfs_time,
            "pfs_event": pfs_event,
        })

    return pd.DataFrame(records)


def plot_pfs(pfs_df, group_col=None, time_unit="months"):
    """
    Kaplan-Meier plot for PFS, optionally stratified by group.

    Parameters
    ----------
    pfs_df : DataFrame
        Must contain pfs_time and pfs_event columns.
    group_col : str, optional
        Column for stratification (e.g., dose group, biomarker status).
    time_unit : str
        Label for x-axis.

    Returns
    -------
    dict
        figure, medians per group, logrank p-value (if stratified).
    """
    fig, ax = plt.subplots(figsize=(8, 6))
    kmf = KaplanMeierFitter()
    medians = {}

    if group_col:
        fitters = []
        for grp, gdf in pfs_df.groupby(group_col):
            kmf_g = KaplanMeierFitter()
            kmf_g.fit(gdf["pfs_time"], gdf["pfs_event"], label=str(grp))
            kmf_g.plot_survival_function(ax=ax)
            medians[grp] = kmf_g.median_survival_time_
            fitters.append(kmf_g)

        add_at_risk_counts(*fitters, ax=ax)

        lr = multivariate_logrank_test(
            pfs_df["pfs_time"], pfs_df[group_col], pfs_df["pfs_event"],
        )
        p_val = lr.p_value
        ax.set_title(f"PFS (log-rank p = {p_val:.4f})")
    else:
        kmf.fit(pfs_df["pfs_time"], pfs_df["pfs_event"], label="PFS")
        kmf.plot_survival_function(ax=ax)
        add_at_risk_counts(kmf, ax=ax)
        medians["all"] = kmf.median_survival_time_
        p_val = None
        ax.set_title(
            f"PFS (median: {medians['all']:.1f} {time_unit})"
        )

    ax.axhline(0.5, color="gray", linestyle=":", alpha=0.5)
    ax.set_xlabel(f"Time ({time_unit})")
    ax.set_ylabel("PFS Probability")
    ax.set_ylim(0, 1.05)
    plt.tight_layout()

    return {"figure": fig, "medians": medians, "logrank_p": p_val}
```

## Time-to-Response (TTR)

Time from treatment start to first documented CR or PR.

```python
def compute_ttr(df, subject_col, response_col, time_col):
    """
    Compute time to first response for each subject.

    Subjects who never respond are censored at last assessment.

    Returns
    -------
    DataFrame
        One row per subject: subject, ttr, event (1=responded).
    """
    records = []
    for subj, sdf in df.groupby(subject_col):
        sdf = sdf.sort_values(time_col)

        first_response = sdf[sdf[response_col].isin(["CR", "PR"])]
        if len(first_response) > 0:
            ttr = first_response[time_col].iloc[0]
            event = 1
        else:
            ttr = sdf[time_col].iloc[-1]
            event = 0

        records.append({
            subject_col: subj,
            "ttr": ttr,
            "ttr_event": event,
        })

    return pd.DataFrame(records)
```

## Safety Exposure-Response (Time-to-AE)

Time to first grade 3+ adverse event stratified by drug exposure
quartiles. Links PK exposure to safety outcomes.

```python
def safety_exposure_response(df, exposure_col, time_col, event_col,
                               n_quartiles=4):
    """
    KM analysis of time to first grade 3+ AE by exposure quartile.

    Parameters
    ----------
    df : DataFrame
        One row per subject with exposure, time-to-AE, and event.
    exposure_col : str
        Column with exposure metric (AUC_ss, Cmax_ss, etc.).
    time_col : str
        Column with time to first AE (or censoring time).
    event_col : str
        Column with event indicator (1 = AE occurred, 0 = censored).
    n_quartiles : int
        Number of exposure groups (default 4).

    Returns
    -------
    dict
        median_time_by_quartile, logrank_p, figure.
    """
    df = df.copy()
    df["exposure_quartile"] = pd.qcut(
        df[exposure_col], q=n_quartiles,
        labels=[f"Q{i+1}" for i in range(n_quartiles)],
    )

    fig, ax = plt.subplots(figsize=(8, 6))
    kmf = KaplanMeierFitter()

    medians = {}
    fitters = []
    for q, gdf in df.groupby("exposure_quartile"):
        kmf_q = KaplanMeierFitter()
        kmf_q.fit(gdf[time_col], gdf[event_col], label=str(q))
        kmf_q.plot_survival_function(ax=ax)
        medians[q] = kmf_q.median_survival_time_
        fitters.append(kmf_q)

    add_at_risk_counts(*fitters, ax=ax)

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
    ax.set_title(
        f"Safety E-R (Q1 vs Q{n_quartiles} log-rank p = {lr.p_value:.4f})"
    )
    ax.set_ylim(0, 1.05)
    plt.tight_layout()

    return {
        "median_time_by_quartile": medians,
        "logrank_p": lr.p_value,
        "figure": fig,
    }
```

## Cox Proportional Hazards

For multivariate survival analysis — test whether exposure
predicts time-to-event after adjusting for covariates.

```python
def cox_exposure_safety(df, time_col, event_col, exposure_col,
                         covariates=None):
    """
    Cox PH model: hazard of AE ~ exposure + covariates.

    Parameters
    ----------
    df : DataFrame
    time_col : str
        Time to event column.
    event_col : str
        Event indicator column.
    exposure_col : str
        Primary exposure variable.
    covariates : list of str, optional
        Additional covariates (age, weight, etc.).

    Returns
    -------
    CoxPHFitter
        Fitted Cox model. Use .summary for hazard ratios.
    """
    cols = [time_col, event_col, exposure_col]
    if covariates:
        cols.extend(covariates)

    cph = CoxPHFitter()
    cph.fit(df[cols], duration_col=time_col, event_col=event_col)
    return cph


def plot_cox_forest(cph, title="Hazard Ratios"):
    """
    Forest plot of Cox PH hazard ratios with 95% CI.
    """
    fig, ax = plt.subplots(figsize=(8, 4))
    cph.plot(ax=ax)
    ax.axvline(0, color="gray", linestyle="--")
    ax.set_title(title)
    plt.tight_layout()
    return fig
```

### Cox Model Attributes

| Attribute | Type | Description |
|-----------|------|-------------|
| `cph.summary` | DataFrame | Coefficients, exp(coef) (HR), p-values, CI |
| `cph.hazard_ratios_` | Series | Hazard ratios per covariate |
| `cph.concordance_index_` | float | C-index (discrimination; 0.5 = random) |
| `cph.AIC_` | float | Model AIC |
| `cph.log_likelihood_` | float | Log-likelihood |
| `cph.check_assumptions()` | — | Tests proportional hazards assumption |

## At-Risk Table

Always include at-risk counts below KM plots for regulatory
submissions and publications.

```python
def km_with_risk_table(time, event, group=None, group_col=None,
                        time_unit="months"):
    """
    Publication-ready KM plot with at-risk table.
    """
    fig, ax = plt.subplots(figsize=(8, 6))
    fitters = []

    if group is not None and group_col is not None:
        for g in sorted(group.unique()):
            mask = group == g
            kmf = KaplanMeierFitter()
            kmf.fit(time[mask], event[mask], label=str(g))
            kmf.plot_survival_function(ax=ax)
            fitters.append(kmf)
    else:
        kmf = KaplanMeierFitter()
        kmf.fit(time, event, label="Overall")
        kmf.plot_survival_function(ax=ax)
        fitters.append(kmf)

    add_at_risk_counts(*fitters, ax=ax)

    ax.set_xlabel(f"Time ({time_unit})")
    ax.set_ylabel("Survival Probability")
    ax.set_ylim(0, 1.05)
    plt.tight_layout()
    return fig
```

## Gotchas

- **Censoring is not absence of event**: A censored patient may
  still progress later. Never exclude censored patients or treat
  censoring time as event time. Lifelines handles censoring
  correctly via `event_observed` parameter.
- **Left truncation**: If patients entered the study at different
  times (staggered entry), use `entry` parameter in
  `KaplanMeierFitter.fit()`. This is rare in standard clinical
  trials but common in retrospective analyses.
- **Immortal time bias**: Time-to-response analysis can suffer from
  immortal time bias if response is guaranteed to occur after some
  minimum time. Report median TTR descriptively (median + range),
  not as a survival endpoint.
- **Proportional hazards assumption**: Always run
  `cph.check_assumptions()` for Cox models. If violated,
  consider time-varying covariates or stratified Cox. Lifelines
  prints a warning but does not refuse to fit.
- **Exposure quartile choice**: 4 quartiles is standard. With
  < 100 patients, use tertiles (3 groups) to maintain adequate
  events per group. Report the quartile cutpoints.
- **Competing risks**: Standard KM overestimates event probability
  when competing risks exist (e.g., death from other causes
  competes with progression). For PFS this is usually acceptable;
  for cause-specific endpoints, consider cumulative incidence.
- **Time units**: Be consistent — lifelines does not enforce units.
  If input is days, output medians are in days. Convert to months
  (÷ 30.44) for clinical reporting.
