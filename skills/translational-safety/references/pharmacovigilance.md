# Pharmacovigilance Signal Detection Reference

Disproportionality analysis methods for detecting safety signals
from FDA FAERS (Adverse Event Reporting System) data.

## Core Imports

```python
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from scipy import stats
```

## Disproportionality Measures

### PRR (Proportional Reporting Ratio)

```python
def compute_prr(a, b, c, d):
    """
    Compute PRR and chi-squared from a 2x2 contingency table.

    Parameters
    ----------
    a : int — reports with drug AND event
    b : int — reports with drug WITHOUT event
    c : int — reports without drug WITH event
    d : int — reports without drug WITHOUT event

    Returns
    -------
    dict
        prr, prr_ci_lower, prr_ci_upper, chi_squared, signal.
    """
    if (a + b) == 0 or (c + d) == 0 or c == 0:
        return {"prr": np.nan, "signal": False}

    prr = (a / (a + b)) / (c / (c + d))

    log_prr = np.log(prr)
    se_log = np.sqrt(1 / a - 1 / (a + b) + 1 / c - 1 / (c + d))
    ci_lower = np.exp(log_prr - 1.96 * se_log)
    ci_upper = np.exp(log_prr + 1.96 * se_log)

    table = np.array([[a, b], [c, d]])
    chi2, _, _, _ = stats.chi2_contingency(table, correction=False)

    signal = prr > 2 and chi2 > 4 and a >= 3

    return {
        "prr": float(prr),
        "prr_ci_lower": float(ci_lower),
        "prr_ci_upper": float(ci_upper),
        "chi_squared": float(chi2),
        "signal": bool(signal),
    }
```

### ROR (Reporting Odds Ratio)

```python
def compute_ror(a, b, c, d):
    """
    Compute ROR from a 2x2 contingency table.

    Parameters
    ----------
    a, b, c, d : int — contingency table cells (same as PRR).

    Returns
    -------
    dict
        ror, ror_ci_lower, ror_ci_upper, signal.
    """
    if b == 0 or c == 0:
        return {"ror": np.nan, "signal": False}

    ror = (a * d) / (b * c)

    log_ror = np.log(ror)
    se_log = np.sqrt(1 / a + 1 / b + 1 / c + 1 / d)
    ci_lower = np.exp(log_ror - 1.96 * se_log)
    ci_upper = np.exp(log_ror + 1.96 * se_log)

    signal = ci_lower > 1

    return {
        "ror": float(ror),
        "ror_ci_lower": float(ci_lower),
        "ror_ci_upper": float(ci_upper),
        "signal": bool(signal),
    }
```

### IC (Information Component, Bayesian)

```python
def compute_ic(a, b, c, d):
    """
    Compute Information Component (IC) using the WHO-UMC method.

    IC = log2(observed / expected).
    IC025 = lower 95% credibility interval bound.

    Parameters
    ----------
    a, b, c, d : int — contingency table cells.

    Returns
    -------
    dict
        ic, ic025, signal.
    """
    n_total = a + b + c + d
    expected = ((a + b) * (a + c)) / n_total if n_total > 0 else 0

    if expected == 0:
        return {"ic": np.nan, "ic025": np.nan, "signal": False}

    ic = np.log2((a + 0.5) / (expected + 0.5))

    variance = 1 / (a + 0.5) - 1 / (n_total + 0.5)
    se = np.sqrt(abs(variance))
    ic025 = ic - 1.96 * se

    return {
        "ic": float(ic),
        "ic025": float(ic025),
        "signal": bool(ic025 > 0),
    }
```

## Signal Detection from FAERS Tool Output

```python
def detect_signals_from_faers(drug_events, total_drug_reports,
                               total_all_reports,
                               background_event_counts):
    """
    Detect disproportionality signals from FAERS search results.

    Parameters
    ----------
    drug_events : list of dict
        From the FAERS search results: [{reaction, count}, ...].
    total_drug_reports : int
        Total reports for this drug (the search's totalReports).
    total_all_reports : int
        Total reports in FAERS database (approximate: ~20M for
        recent years; use the FAERS dashboard for current counts).
    background_event_counts : dict
        {reaction_name: count_in_all_reports} for background rates.
        If unavailable, use total_all_reports as denominator for
        each event.

    Returns
    -------
    DataFrame
        Signals with PRR, ROR, IC, and signal flags.
    """
    results = []
    for event in drug_events:
        reaction = event["reaction"]
        a = event["count"]
        b = total_drug_reports - a

        bg_count = background_event_counts.get(reaction, 0)
        c = bg_count
        d = total_all_reports - bg_count - total_drug_reports

        d = max(d, 0)

        if a < 1:
            continue

        prr_result = compute_prr(a, b, c, d)
        ror_result = compute_ror(a, b, c, d)
        ic_result = compute_ic(a, b, c, d)

        results.append({
            "reaction": reaction,
            "count": a,
            "prr": prr_result["prr"],
            "prr_ci_lower": prr_result.get("prr_ci_lower"),
            "prr_ci_upper": prr_result.get("prr_ci_upper"),
            "chi_squared": prr_result.get("chi_squared"),
            "prr_signal": prr_result["signal"],
            "ror": ror_result["ror"],
            "ror_ci_lower": ror_result.get("ror_ci_lower"),
            "ror_signal": ror_result["signal"],
            "ic": ic_result["ic"],
            "ic025": ic_result["ic025"],
            "ic_signal": ic_result["signal"],
            "any_signal": (
                prr_result["signal"]
                or ror_result["signal"]
                or ic_result["signal"]
            ),
        })

    df = pd.DataFrame(results)
    if not df.empty:
        df = df.sort_values("prr", ascending=False)
    return df
```

## DDI Signal Detection

```python
def detect_ddi_signal(drug_a_events, drug_b_events, combo_events,
                       total_a, total_b, total_combo, total_all):
    """
    Detect drug-drug interaction signals by comparing combination
    adverse event rates against individual drug rates.

    A synergistic DDI signal exists when the combination PRR for an
    event significantly exceeds either individual drug's PRR.

    Parameters
    ----------
    drug_a_events, drug_b_events, combo_events : list of dict
        [{reaction, count}, ...] from the FAERS search for each.
    total_a, total_b, total_combo : int
        Total report counts for each query.
    total_all : int
        Total FAERS reports.

    Returns
    -------
    DataFrame
        Events with individual and combination PRRs, synergy flag.
    """
    a_rates = {e["reaction"]: e["count"] / total_a for e in drug_a_events}
    b_rates = {e["reaction"]: e["count"] / total_b for e in drug_b_events}
    combo_rates = {
        e["reaction"]: e["count"] / total_combo for e in combo_events
    }

    all_reactions = set(combo_rates.keys())
    results = []

    for reaction in all_reactions:
        combo_rate = combo_rates.get(reaction, 0)
        rate_a = a_rates.get(reaction, 0)
        rate_b = b_rates.get(reaction, 0)
        max_individual = max(rate_a, rate_b)

        synergy_ratio = (
            combo_rate / max_individual if max_individual > 0 else np.inf
        )

        results.append({
            "reaction": reaction,
            "combo_rate": combo_rate,
            "drug_a_rate": rate_a,
            "drug_b_rate": rate_b,
            "synergy_ratio": synergy_ratio,
            "synergy_signal": synergy_ratio > 2.0 and combo_rate > 0.01,
        })

    df = pd.DataFrame(results)
    if not df.empty:
        df = df.sort_values("synergy_ratio", ascending=False)
    return df
```

## Visualization

### Signal Detection Forest Plot

```python
def plot_signal_forest(signal_df, top_n=20, measure="prr"):
    """
    Forest plot of disproportionality signals.

    Parameters
    ----------
    signal_df : DataFrame
        From detect_signals_from_faers.
    top_n : int
        Number of top signals to display.
    measure : str
        "prr" or "ror".
    """
    df = signal_df.nlargest(top_n, measure).iloc[::-1]

    fig, ax = plt.subplots(figsize=(10, max(6, top_n * 0.35)))

    y_pos = range(len(df))
    values = df[measure].values
    ci_lower = df[f"{measure}_ci_lower"].values
    ci_upper = df.get(f"{measure}_ci_upper", values).values

    colors = ["red" if s else "gray" for s in df[f"{measure}_signal"]]

    ax.barh(y_pos, values, color=colors, alpha=0.7, height=0.6)
    ax.errorbar(
        values, y_pos,
        xerr=[values - ci_lower, ci_upper - values],
        fmt="none", color="black", capsize=3,
    )

    ax.set_yticks(y_pos)
    ax.set_yticklabels(
        [f"{r} (n={c})" for r, c in zip(df["reaction"], df["count"])],
        fontsize=8,
    )
    ax.axvline(2 if measure == "prr" else 1, color="blue",
               linestyle="--", alpha=0.5, label="Signal threshold")
    ax.set_xlabel(measure.upper())
    ax.set_title(f"Safety Signal Detection ({measure.upper()})")
    ax.legend()
    plt.tight_layout()
    return fig
```

## Gotchas

- **FAERS denominator**: A FAERS search returns event counts
  for a specific drug, not the full 2x2 table. You need total FAERS
  report counts and background event rates to compute PRR/ROR.
  Approximate total FAERS: ~20M reports (cumulative). For precise
  denominators, note this limitation.
- **Notoriety bias**: After a drug safety warning, reporting for that
  drug-event pair increases regardless of true incidence. Compare
  pre- and post-warning periods when possible.
- **Duplicate reports**: FAERS contains duplicate reports. FDA
  de-duplicates in some datasets but not all. Use case-level data
  when available.
- **Confounding by indication**: Drugs for serious diseases may show
  high PRR for events that are actually disease symptoms, not drug
  effects. Cross-reference with known disease manifestations.
- **Weber effect**: New drugs have higher reporting rates in their
  first 2 years on market, independent of true adverse event rates.
- **Multiple testing**: When screening many drug-event pairs, apply
  Bonferroni or FDR correction. Report both raw and adjusted
  significance.
