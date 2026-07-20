# Non-Compartmental Analysis (NCA) Reference

NCA derives PK parameters directly from concentration-time data
without assuming a compartmental model. It is the standard approach
for Phase 1/2 PK characterization.

## Core Imports

```python
import numpy as np
import pandas as pd
from scipy import integrate
import matplotlib.pyplot as plt
```

## NCA Parameter Computation

### AUC (Area Under the Curve)

```python
def auc_linear_trapezoidal(time, concentration):
    """
    AUC by linear trapezoidal rule.

    Parameters
    ----------
    time : array-like
        Sampling times (h).
    concentration : array-like
        Corresponding concentrations (ng/mL or μg/mL).

    Returns
    -------
    float
        AUC(0-last) in concentration·time units (e.g., ng·h/mL).
    """
    return integrate.trapezoid(concentration, time)


def auc_log_linear_trapezoidal(time, concentration):
    """
    AUC by log-linear trapezoidal rule.
    Use for IV bolus data where concentration declines exponentially.
    Uses linear rule for ascending phase, log-linear for descending.
    """
    auc = 0.0
    for i in range(1, len(time)):
        dt = time[i] - time[i - 1]
        c1, c2 = concentration[i - 1], concentration[i]
        if c1 <= 0 or c2 <= 0 or c2 >= c1:
            auc += dt * (c1 + c2) / 2  # linear
        else:
            auc += dt * (c1 - c2) / np.log(c1 / c2)  # log-linear
    return auc


def auc_extrapolated(auc_0_last, c_last, lambda_z):
    """
    Extrapolate AUC from last measured concentration to infinity.

    Parameters
    ----------
    auc_0_last : float
        AUC from time 0 to last measurement.
    c_last : float
        Last measured concentration.
    lambda_z : float
        Terminal elimination rate constant (1/h).

    Returns
    -------
    float
        AUC(0-inf) = AUC(0-last) + Clast/λz
    """
    if lambda_z <= 0:
        return np.nan
    return auc_0_last + c_last / lambda_z
```

### Terminal Half-Life

```python
def terminal_half_life(time, concentration, min_points=3):
    """
    Estimate terminal elimination half-life from the log-linear
    declining phase.

    Parameters
    ----------
    time : array-like
        Sampling times.
    concentration : array-like
        Concentrations (must be > 0 for log transformation).
    min_points : int
        Minimum number of declining-phase points required.

    Returns
    -------
    dict
        t_half, lambda_z, r_squared. Returns NaN if insufficient data.
    """
    time = np.asarray(time)
    conc = np.asarray(concentration)

    # Find declining phase (after Cmax)
    cmax_idx = np.argmax(conc)
    decline_mask = np.arange(len(conc)) > cmax_idx
    decline_mask &= conc > 0

    t_dec = time[decline_mask]
    c_dec = conc[decline_mask]

    if len(t_dec) < min_points:
        return {"t_half": np.nan, "lambda_z": np.nan, "r_squared": np.nan}

    log_c = np.log(c_dec)
    slope, intercept = np.polyfit(t_dec, log_c, 1)

    # R-squared for terminal phase fit
    predicted = slope * t_dec + intercept
    ss_res = np.sum((log_c - predicted) ** 2)
    ss_tot = np.sum((log_c - np.mean(log_c)) ** 2)
    r_sq = 1 - ss_res / ss_tot if ss_tot > 0 else np.nan

    lambda_z = -slope
    t_half = np.log(2) / lambda_z if lambda_z > 0 else np.nan

    return {"t_half": t_half, "lambda_z": lambda_z, "r_squared": r_sq}
```

### Derived PK Parameters

```python
def derive_pk_params(time, concentration, dose, dose_unit="mg"):
    """
    Full NCA parameter set.

    Parameters
    ----------
    time : array-like
        Sampling times (h).
    concentration : array-like
        Concentrations (ng/mL).
    dose : float
        Administered dose.
    dose_unit : str
        Dose unit for CL/F and Vd/F labeling.

    Returns
    -------
    dict
        Complete NCA parameter set.
    """
    time = np.asarray(time, dtype=float)
    conc = np.asarray(concentration, dtype=float)

    cmax = np.max(conc)
    tmax = time[np.argmax(conc)]
    auc_0_last = integrate.trapezoid(conc, time)
    c_last = conc[-1]

    term = terminal_half_life(time, conc)
    lambda_z = term["lambda_z"]

    auc_0_inf = auc_extrapolated(auc_0_last, c_last, lambda_z)

    # CL/F = Dose / AUC(0-inf). dose is mg, AUC is ng*h/mL, so the ratio is
    # (1e6 ng)/(ng*h/mL) = 1e6 mL/h -- scale by 1e6, not 1e3, for mL/h.
    cl_f = dose / auc_0_inf * 1e6 if np.isfinite(auc_0_inf) else np.nan
    # Vd/F = CL/F / λz  [volume]
    vd_f = cl_f / lambda_z if lambda_z > 0 else np.nan

    return {
        "Cmax_ng_mL": cmax,
        "Tmax_h": tmax,
        "AUC_0_last_ng_h_mL": auc_0_last,
        "AUC_0_inf_ng_h_mL": auc_0_inf,
        "AUC_extrap_pct": (
            (auc_0_inf - auc_0_last) / auc_0_inf * 100
            if np.isfinite(auc_0_inf) else np.nan
        ),
        "t_half_h": term["t_half"],
        "lambda_z_1_h": lambda_z,
        "terminal_r_squared": term["r_squared"],
        "CL_F_mL_h": cl_f,
        "Vd_F_mL": vd_f,
        "C_last_ng_mL": c_last,
    }
```

## Concentration-Time Plots

```python
def plot_concentration_time(time, concentration, subject_id=None,
                             dose_info=None):
    """
    Standard PK concentration-time profile: linear and semi-log.

    Parameters
    ----------
    time : array-like
        Sampling times.
    concentration : array-like
        Concentrations.
    subject_id : str, optional
        Subject identifier for title.
    dose_info : str, optional
        Dosing information for subtitle (e.g., "100 mg PO single dose").
    """
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))

    # Linear scale
    ax = axes[0]
    ax.plot(time, concentration, "o-", markersize=5, color="steelblue")
    ax.set_xlabel("Time (h)")
    ax.set_ylabel("Concentration (ng/mL)")
    ax.set_title("Linear Scale")
    ax.set_xlim(left=0)
    ax.set_ylim(bottom=0)

    # Semi-log scale
    ax = axes[1]
    mask = np.asarray(concentration) > 0
    ax.semilogy(
        np.asarray(time)[mask],
        np.asarray(concentration)[mask],
        "o-", markersize=5, color="steelblue",
    )
    ax.set_xlabel("Time (h)")
    ax.set_ylabel("Concentration (ng/mL)")
    ax.set_title("Semi-Log Scale")
    ax.set_xlim(left=0)

    suptitle = "Concentration-Time Profile"
    if subject_id:
        suptitle += f" — {subject_id}"
    if dose_info:
        suptitle += f"\n{dose_info}"
    fig.suptitle(suptitle, fontsize=11)
    plt.tight_layout()
    return fig


def plot_pk_overlay(pk_data, time_col, conc_col, subject_col,
                     group_col=None):
    """
    Overlay concentration-time profiles for multiple subjects.
    Individual traces in gray, group means as bold lines.
    """
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))

    for ax_idx, (ax, yscale) in enumerate(
        zip(axes, ["linear", "log"])
    ):
        for subj, sdf in pk_data.groupby(subject_col):
            ax.plot(sdf[time_col], sdf[conc_col], alpha=0.2,
                    color="gray", linewidth=0.8)

        if group_col:
            for grp, gdf in pk_data.groupby(group_col):
                means = gdf.groupby(time_col)[conc_col].mean()
                ax.plot(means.index, means.values, linewidth=2, label=grp)
            ax.legend()
        else:
            means = pk_data.groupby(time_col)[conc_col].mean()
            ax.plot(means.index, means.values, linewidth=2,
                    color="steelblue", label="Mean")

        ax.set_xlabel("Time (h)")
        ax.set_ylabel("Concentration (ng/mL)")
        ax.set_yscale(yscale)
        ax.set_title("Linear" if ax_idx == 0 else "Semi-Log")

    plt.tight_layout()
    return fig
```

## NCA Quality Checks

| Check | Threshold | Action |
|-------|-----------|--------|
| Terminal R² | >= 0.80 | If < 0.80, t½ is unreliable — report as "not estimable" |
| AUC extrapolation | <= 20% of AUC(0-inf) | If > 20%, AUC(0-inf) is unreliable — report AUC(0-last) only |
| Terminal points | >= 3 points | Fewer points make λz unreliable |
| Declining phase | Monotonic decrease | Non-monotonic decline suggests absorption or redistribution — re-evaluate |

## Gotchas

- **BLQ handling**: Below-limit-of-quantification samples are typically
  set to 0 before Tmax and missing after Tmax (FDA guidance). Document
  the BLQ handling method used.
- **Dose normalization**: When comparing across dose levels, normalize
  parameters: Cmax/D, AUC/D. Only valid if PK is dose-linear.
- **Steady-state NCA**: For multiple-dose PK, AUC is computed over one
  dosing interval (AUC_tau), not 0-inf. CL/F_ss = Dose / AUC_tau.
- **Units**: Always report units. Cmax (ng/mL), AUC (ng·h/mL),
  CL/F (mL/h or L/h), Vd/F (mL or L), t½ (h).
- **Semi-log visual**: Always provide semi-log plot — the terminal
  phase should appear as a straight line. If it curves, the terminal
  phase window is wrong.
