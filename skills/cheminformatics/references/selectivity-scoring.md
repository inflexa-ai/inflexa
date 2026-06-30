# Selectivity Scoring Reference

Quantitative metrics for compound selectivity across target panels.
Used for kinase selectivity profiling, GPCR safety panels, and
general off-target liability assessment.

## Metrics Summary

| Metric | Input | Range | Selective When |
|--------|-------|-------|----------------|
| Gini coefficient | Activity values (e.g., %inhibition) | [0, 1] | > 0.8 |
| S-score | Kd values (nM) + threshold | [0, 1] | < 0.05 |
| Selectivity entropy | pIC50 values | [0, ln(N)] | < 2 |
| Selectivity window | Primary IC50 + off-target IC50s | [1, ∞) | > 100 |

## Gini Coefficient

Measures inequality of activity distribution across targets. A
compound that inhibits only its primary target has Gini ≈ 1; a
non-selective compound that inhibits all targets equally has Gini ≈ 0.

```python
import numpy as np

def gini_coefficient(activities):
    """
    Gini coefficient for selectivity.

    Parameters
    ----------
    activities : array-like
        Activity values across all panel targets. Must be non-negative.
        Use %inhibition at a fixed concentration (e.g., 1 μM) or
        normalized pIC50 values. Do NOT use raw IC50 — the scale is
        inverted (lower IC50 = more active).

    Returns
    -------
    float
        0 = non-selective, 1 = perfectly selective.
    """
    sorted_act = np.sort(np.asarray(activities, dtype=float))
    n = len(sorted_act)
    if n == 0 or np.sum(sorted_act) == 0:
        return 0.0
    index = np.arange(1, n + 1)
    return (
        (2 * np.sum(index * sorted_act) - (n + 1) * np.sum(sorted_act))
        / (n * np.sum(sorted_act))
    )
```

### Edge Cases

- **All zeros except one**: Gini = (n-1)/n ≈ 1 for large panels. Correct.
- **All equal nonzero**: Gini = 0. Correct (fully non-selective).
- **Single target**: Gini = 0 by definition. Not meaningful — need >= 2.
- **Negative values**: Undefined. Clip or transform to non-negative first.

### Input Preparation

| Data Type | Transformation | Why |
|-----------|---------------|-----|
| IC50 (nM) | Convert to pIC50: `-log10(IC50 * 1e-9)` | IC50 is inverse scale |
| Kd (nM) | Convert to pKd: `-log10(Kd * 1e-9)` | Same issue |
| %inhibition at Xμm | Use directly | Already on correct scale |
| Fold-change | Subtract 1, clip to >= 0 | Center at zero |

**Critical**: Never compute Gini on raw IC50/Kd values. A compound
with IC50 = 1 nM (primary) and IC50 = 10,000 nM (off-targets) would
show LOW Gini because the numeric range is dominated by the off-target
values. Convert to pIC50 first.

## S-Score (Selectivity Score)

Fraction of panel targets bound at a given concentration threshold.
Introduced by Karaman et al., 2008 for kinase selectivity.

```python
def s_score(kd_values_nM, threshold_nM=3000):
    """
    S-score: fraction of kinases bound below Kd threshold.

    Parameters
    ----------
    kd_values_nM : array-like
        Kd values in nM for all panel targets. Include targets with
        no measurable binding as np.inf or a large value (e.g., 1e6).
    threshold_nM : float
        Concentration threshold. Standard values:
        - S(3μM) = 3000: general kinase selectivity
        - S(1μM) = 1000: stringent selectivity
        - S(10μM) = 10000: broad binding assessment

    Returns
    -------
    float
        Fraction in [0, 1]. Lower = more selective.
    """
    kd = np.asarray(kd_values_nM, dtype=float)
    return np.sum(kd < threshold_nM) / len(kd)
```

### Interpretation (Kinase Panels)

| S(3μM) | Classification | Example |
|--------|---------------|---------|
| < 0.01 | Exquisitely selective | Lapatinib (S = 0.008) |
| 0.01-0.05 | Selective | Imatinib (S = 0.04) |
| 0.05-0.10 | Moderately selective | Dasatinib (S = 0.07) |
| > 0.10 | Broad / multi-kinase | Staurosporine (S = 0.72) |

### Edge Cases

- **Targets with no measurable Kd**: Treat as Kd = ∞ (or 1e6 nM).
  They contribute to the denominator but not the numerator.
- **Panel size matters**: S = 0.05 on a 50-kinase panel (2-3 kinases
  bound) is different from S = 0.05 on a 400-kinase panel (20 kinases
  bound). Always report panel size alongside S-score.

## Selectivity Entropy

Information-theoretic measure of selectivity from Uitdehaag & Zaman,
2011. Accounts for the degree of activity at each target, not just
binary hit/no-hit.

```python
def selectivity_entropy(pIC50_values, reference_pIC50=5.0):
    """
    Selectivity entropy.

    Parameters
    ----------
    pIC50_values : array-like
        pIC50 values for all panel targets. Inactive targets should
        have pIC50 at or below the reference threshold.
    reference_pIC50 : float
        Baseline activity threshold. Default 5.0 (= 10 μM).
        Activities below this threshold are treated as background.

    Returns
    -------
    float
        0 = perfectly selective (all activity on one target).
        ln(N) = fully non-selective (equal activity on N targets).
        Typical "selective" compounds have entropy < 2.
    """
    activities = 10 ** (np.asarray(pIC50_values, dtype=float) - reference_pIC50)
    activities = np.maximum(activities, 0)
    total = np.sum(activities)
    if total == 0:
        return 0.0
    probs = activities / total
    probs = probs[probs > 0]
    return -np.sum(probs * np.log(probs))
```

### Interpretation

| Entropy | Classification |
|---------|---------------|
| 0 | Perfectly selective (one target only) |
| < 1 | Highly selective |
| 1-2 | Selective |
| 2-3 | Moderately selective |
| > 3 | Promiscuous |
| ln(N) | Fully non-selective (N = panel size) |

### Edge Cases

- **All pIC50 below reference**: All activities become 0, entropy = 0.
  This means "no measurable selectivity" — not "perfectly selective."
  Flag this case separately.
- **One target above reference**: Entropy = 0 (truly selective).
- **reference_pIC50 choice**: The default of 5.0 (10 μM) is standard
  for kinase panels. For high-potency targets, use 6.0 (1 μM).

## Selectivity Window

The simplest selectivity measure: fold-difference between primary
target IC50 and the most potent off-target IC50.

```python
def selectivity_window(primary_ic50_nM, offtarget_ic50s_nM):
    """
    Parameters
    ----------
    primary_ic50_nM : float
        IC50 for the intended target.
    offtarget_ic50s_nM : array-like
        IC50 values for all off-targets. Inactive targets can be
        omitted or set to a large value (e.g., 1e6).

    Returns
    -------
    float
        Fold-difference. Higher = more selective.
    """
    offtargets = np.asarray(offtarget_ic50s_nM, dtype=float)
    if len(offtargets) == 0:
        return float("inf")
    closest = np.min(offtargets)
    if primary_ic50_nM <= 0:
        return float("inf")
    return closest / primary_ic50_nM
```

| Window | Interpretation | Action |
|--------|---------------|--------|
| > 100× | Excellent | Likely safe at therapeutic doses |
| 30-100× | Acceptable | Monitor for off-target effects at high exposure |
| 10-30× | Marginal | Off-target effects likely at supra-therapeutic doses |
| < 10× | Poor | Off-target effects expected at therapeutic exposure |

### When to Use Each Metric

| Situation | Best Metric | Why |
|-----------|------------|-----|
| Kinase selectivity panel (Kd data) | S-score + entropy | S-score is the standard; entropy accounts for potency |
| Safety panel (%inhibition) | Gini + flag >50% hits | %inhibition data doesn't have Kd |
| Comparing two compounds | Selectivity window | Simple, intuitive fold-difference |
| Tracking selectivity optimization in SAR | Gini or entropy over series | Tracks trend as scaffold is modified |
| Regulatory submission | S-score + selectivity window | Most widely recognized in regulatory context |

## Reporting Template

When reporting selectivity profiling results, include:

1. **Panel description**: vendor, panel name, number of targets, assay
   type (binding vs functional), concentration tested
2. **Primary target potency**: IC50/Kd with confidence interval
3. **Selectivity metrics**: at minimum Gini + one of S-score/entropy
4. **Top off-targets**: top 5 by potency, with IC50/Kd values
5. **Selectivity window**: vs closest off-target
6. **Safety flags**: hERG, muscarinic, adrenergic if on panel
7. **Visualization**: selectivity heatmap or bar chart
