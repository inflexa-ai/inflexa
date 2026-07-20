# Clinical Response Criteria Reference

RECIST 1.1 and iRECIST classification rules for tumor response
assessment. Use this reference for correct categorization, edge
case handling, and response derivation.

## RECIST 1.1 — Full Criteria

### Target Lesion Assessment

Target lesions are measurable at baseline (longest diameter >= 10 mm
for non-nodal, >= 15 mm short axis for lymph nodes). Maximum 5 total,
2 per organ.

| Category | Abbreviation | Criteria |
|----------|-------------|----------|
| Complete Response | CR | Disappearance of all target lesions. Any pathological lymph nodes must have short axis < 10 mm. |
| Partial Response | PR | >= 30% decrease in sum of diameters of target lesions, from baseline sum. |
| Progressive Disease | PD | >= 20% increase in sum of diameters from nadir (smallest recorded sum) AND absolute increase >= 5 mm. Or appearance of one or more new lesions. |
| Stable Disease | SD | Neither PR nor PD criteria met. |

### Non-Target Lesion Assessment

| Category | Criteria |
|----------|----------|
| CR | Disappearance of all non-target lesions and normalization of tumor marker levels. |
| Non-CR/Non-PD | Persistence of one or more non-target lesions and/or maintenance of tumor marker above normal. |
| PD | Unequivocal progression of non-target lesions. Appearance of new lesions. |

### Overall Response Derivation

Combine target and non-target assessments:

| Target | Non-Target | New Lesions | Overall |
|--------|-----------|-------------|---------|
| CR | CR | No | CR |
| CR | Non-CR/Non-PD | No | PR |
| CR | Not evaluated | No | PR |
| PR | Non-PD or not evaluated | No | PR |
| SD | Non-PD or not evaluated | No | SD |
| PD | Any | Yes or No | PD |
| Any | PD | Yes or No | PD |
| Any | Any | Yes | PD |

### Confirmation Requirements

- **CR/PR confirmation**: For trials where response is the primary
  endpoint, CR or PR must be confirmed >= 4 weeks after initial
  assessment.
- **SD minimum duration**: SD requires a minimum interval from
  baseline (protocol-defined, typically >= 6-8 weeks).

### Measurement Rules

```python
def recist_classify_target(sum_diameters_baseline, sum_diameters_current,
                            sum_diameters_nadir,
                            nonnodal_all_disappeared=None,
                            max_nodal_short_axis_mm=None):
    """
    Classify target lesion response per RECIST 1.1.

    Parameters
    ----------
    sum_diameters_baseline : float
        Sum of diameters at baseline (longest diameter for non-nodal
        lesions, short axis for nodal lesions).
    sum_diameters_current : float
        Sum of diameters at the current assessment.
    sum_diameters_nadir : float
        Smallest sum of diameters recorded since baseline.
    nonnodal_all_disappeared : bool, optional
        True when every non-nodal target lesion measures 0 mm.
    max_nodal_short_axis_mm : float, optional
        Largest short axis among *nodal* target lesions at this
        assessment. Pass 0.0 when there are no nodal targets.

    CR cannot be read off the sum. A nodal target lesion keeps
    contributing its short axis to the sum after it becomes
    non-pathological (< 10 mm), so a genuine CR routinely has a
    non-zero sum; conversely a zero sum is CR only when every target
    was non-nodal. Supply the two lesion-level arguments whenever the
    target set includes lymph nodes. Omitting them falls back to the
    zero-sum test, which is correct only for all-non-nodal target sets
    and otherwise under-calls CR as PR.

    Returns
    -------
    str
        One of: "CR", "PR", "SD", "PD".
    """
    if nonnodal_all_disappeared is None:
        # Without lesion-level data, a zero sum is the only observable
        # that implies every target lesion has gone.
        nonnodal_all_disappeared = sum_diameters_current == 0
        max_nodal_short_axis_mm = 0.0
    if max_nodal_short_axis_mm is None:
        max_nodal_short_axis_mm = 0.0

    if nonnodal_all_disappeared and max_nodal_short_axis_mm < 10:
        return "CR"

    # Change from baseline for PR
    pct_change_baseline = (
        (sum_diameters_current - sum_diameters_baseline)
        / sum_diameters_baseline * 100
        if sum_diameters_baseline > 0 else 0.0
    )

    # Change from nadir for PD. A nadir of 0 means the target lesions
    # had wholly disappeared, so any measurable regrowth is progression
    # and the percentage is unbounded — scoring it as 0% would hide a
    # relapse behind an SD.
    abs_change_nadir = sum_diameters_current - sum_diameters_nadir
    if sum_diameters_nadir > 0:
        pct_change_nadir = abs_change_nadir / sum_diameters_nadir * 100
    elif sum_diameters_current > 0:
        pct_change_nadir = float("inf")
    else:
        pct_change_nadir = 0.0

    if pct_change_nadir >= 20 and abs_change_nadir >= 5:
        return "PD"
    elif pct_change_baseline <= -30:
        return "PR"
    else:
        return "SD"


def best_overall_response(responses):
    """
    Determine best overall response from a sequence of assessments.

    Parameters
    ----------
    responses : list of str
        Ordered sequence of per-visit responses: "CR", "PR", "SD", "PD".

    Returns
    -------
    str
        Best overall response. CR > PR > SD > PD.
    """
    priority = {"CR": 0, "PR": 1, "SD": 2, "PD": 3}
    valid = [r for r in responses if r in priority]
    if not valid:
        return "NE"
    # RECIST 1.1: best response runs from start of treatment until
    # progression. Assessments recorded after the first PD are not
    # eligible, so truncate there rather than letting a later
    # post-progression reading win the min().
    if "PD" in valid:
        valid = valid[: valid.index("PD") + 1]
    return min(valid, key=lambda r: priority[r])
```

## iRECIST — Immune-Specific Modifications

For immunotherapy trials, iRECIST accounts for pseudoprogression
(initial enlargement followed by subsequent shrinkage).

### Modified Categories

| iRECIST | Equivalent | Key Difference |
|---------|-----------|----------------|
| iCR | CR | Same as RECIST |
| iPR | PR | Same as RECIST |
| iSD | SD | Same as RECIST |
| iUPD | Unconfirmed PD | First occurrence of PD criteria. Must confirm at next assessment. |
| iCPD | Confirmed PD | PD confirmed at subsequent assessment (>= 4 weeks later). |

### iRECIST Decision Flow

```python
def irecist_classify(current_response, prior_response):
    """
    Apply iRECIST pseudoprogression rules.

    Parameters
    ----------
    current_response : str
        RECIST 1.1 classification at current visit.
    prior_response : str
        iRECIST classification at prior visit.

    Returns
    -------
    str
        iRECIST classification.
    """
    if current_response == "PD":
        if prior_response == "iUPD":
            return "iCPD"    # Confirmed progression
        else:
            return "iUPD"    # Unconfirmed — wait for next assessment
    elif current_response in ("CR", "PR", "SD"):
        if prior_response == "iUPD":
            return f"i{current_response}"  # Pseudoprogression resolved
        return f"i{current_response}"
    return current_response
```

### Key iRECIST Rules

1. After iUPD, treatment MAY continue at investigator discretion.
2. Next assessment must be >= 4 weeks after iUPD.
3. If next assessment confirms PD (same or new lesions) → iCPD.
4. If next assessment shows CR/PR/SD → reset to iCR/iPR/iSD.
5. If a subsequent assessment after reset shows PD again → new iUPD.

## Response-Derived Endpoints

```python
def compute_response_endpoints(df, subject_col, visit_col,
                                 response_col, time_col):
    """
    Derive standard clinical trial response endpoints.

    Returns
    -------
    dict
        ORR, DCR, median DOR, median TTR.
    """
    bor = df.groupby(subject_col).apply(
        lambda g: best_overall_response(g[response_col].tolist())
    )

    n_total = len(bor)
    n_responders = (bor.isin(["CR", "PR"])).sum()
    n_disease_control = (bor.isin(["CR", "PR", "SD"])).sum()

    orr = n_responders / n_total * 100   # Objective Response Rate
    dcr = n_disease_control / n_total * 100  # Disease Control Rate

    return {
        "ORR_pct": orr,
        "DCR_pct": dcr,
        "n_CR": (bor == "CR").sum(),
        "n_PR": (bor == "PR").sum(),
        "n_SD": (bor == "SD").sum(),
        "n_PD": (bor == "PD").sum(),
        "n_total": n_total,
    }
```

| Endpoint | Definition | Typical Reporting |
|----------|-----------|-------------------|
| ORR | (CR + PR) / total × 100% | Primary endpoint in single-arm trials |
| DCR | (CR + PR + SD) / total × 100% | Broader measure of benefit |
| DOR | Time from first response to PD or death | Kaplan-Meier with median + CI |
| TTR | Time from treatment start to first CR/PR | Descriptive (median + range) |
| PFS | Time from treatment start to PD or death | Kaplan-Meier with median + CI |

## Gotchas

- **Nadir, not baseline, for PD**: The 20% increase for PD is from
  the nadir (smallest recorded sum), not from baseline. This is the
  most common RECIST error.
- **5 mm absolute increase**: PD requires BOTH >= 20% increase AND
  >= 5 mm absolute increase. The 5 mm rule prevents tiny absolute
  changes from triggering PD.
- **New lesions = PD**: Any unambiguous new lesion is PD regardless
  of target lesion measurements.
- **Lymph nodes**: a nodal target lesion is CR at short axis < 10 mm,
  not at 0 mm, and its residual short axis stays in the sum of
  diameters. So CR and a non-zero sum coexist routinely, and
  `sum == 0` is neither necessary nor sufficient for CR. Never derive
  CR from the sum alone when any target lesion is a lymph node — pass
  the lesion-level arguments to `recist_classify_target`.
- **Missing assessments**: A single missing assessment does not
  change the prior response. Two consecutive missed assessments →
  "Not Evaluable" (NE).
- **iRECIST only for IO**: Only use iRECIST for checkpoint
  inhibitor trials. Standard RECIST 1.1 for cytotoxic agents.
