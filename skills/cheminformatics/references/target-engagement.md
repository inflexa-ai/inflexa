# Target Engagement Reference

Pharmacological framework for assessing whether a drug reaches and
modulates its intended target at therapeutic concentrations.

## Occupancy Model

Target occupancy is the fraction of target molecules bound by drug
at equilibrium. Derived from the law of mass action:

```
Occupancy (%) = [Drug_free] / ([Drug_free] + Kd) × 100
```

Where `[Drug_free]` is the free (unbound) drug concentration at the
target site, and `Kd` is the equilibrium dissociation constant.

```python
import numpy as np

def estimate_occupancy(conc_free_nM, kd_nM):
    """
    Fractional target occupancy from free drug concentration and Kd.

    Parameters
    ----------
    conc_free_nM : float or array
        Free (unbound) drug concentration in nM. For plasma-derived
        estimates, multiply total concentration by fraction unbound
        (fu): conc_free = conc_total * fu.
    kd_nM : float
        Equilibrium dissociation constant in nM. For competitive
        inhibitors, use Ki from a binding assay.

    Returns
    -------
    float or array
        Occupancy as percentage (0-100).
    """
    return np.asarray(conc_free_nM) / (np.asarray(conc_free_nM) + kd_nM) * 100


def occupancy_at_doses(cmax_nM, ctrough_nM, kd_nM, fu=1.0):
    """
    Compute occupancy at Cmax and Ctrough.

    Parameters
    ----------
    cmax_nM : float
        Peak total plasma concentration.
    ctrough_nM : float
        Trough total plasma concentration (pre-next-dose).
    kd_nM : float
        Equilibrium dissociation constant.
    fu : float
        Fraction unbound in plasma (0 to 1). Default 1.0 (fully
        unbound, e.g., for intracellular targets where free drug
        approximation is used directly).

    Returns
    -------
    dict
        Occupancy at Cmax and Ctrough.
    """
    return {
        "occupancy_at_cmax": estimate_occupancy(cmax_nM * fu, kd_nM),
        "occupancy_at_ctrough": estimate_occupancy(ctrough_nM * fu, kd_nM),
    }
```

### Occupancy Thresholds

| Occupancy at Ctrough | Interpretation |
|---------------------|----------------|
| >= 90% | Full target suppression (standard benchmark) |
| 70-90% | Substantial engagement; may be sufficient for some targets |
| 50-70% | Moderate engagement; biological effect depends on target |
| < 50% | Insufficient for most applications |

**Note**: The 90% threshold is a common rule-of-thumb, not a universal
requirement. Some targets require >95% (e.g., kinases with steep
dose-response), while others show efficacy at 50-70% (e.g., GPCRs
with receptor reserve).

### Free Drug Hypothesis

Occupancy estimates require **free** drug concentration, not total
plasma concentration. The free drug hypothesis states that only
unbound drug molecules can interact with the target.

| Parameter | Source | Typical Range |
|-----------|--------|---------------|
| fu (fraction unbound, plasma) | Equilibrium dialysis, ultrafiltration | 0.001-1.0 |
| fu,tissue (fraction unbound, tissue) | Tissue binding studies | Often approximated as fu |
| Kd or Ki | Binding assay (SPR, FP, TR-FRET) | 0.1 nM - 10 μM |
| Cmax, Ctrough | PK study (NCA) | Dose-dependent |

**Common error**: Using total plasma Cmax to estimate occupancy for
a highly protein-bound drug (fu = 0.01) overestimates occupancy by
100-fold. Always account for protein binding.

## Residence Time

Drug-target residence time measures how long a drug stays bound to
its target after unbound drug is removed.

```python
def residence_time_min(koff_per_sec):
    """
    Compute residence time in minutes from dissociation rate constant.

    Parameters
    ----------
    koff_per_sec : float
        Dissociation rate constant (s^-1). Measured by SPR (surface
        plasmon resonance) or similar kinetic binding assay.

    Returns
    -------
    float
        Residence time tau = 1/koff, in minutes.
    """
    return 1.0 / koff_per_sec / 60.0


def classify_residence_time(tau_min):
    """Classify residence time by pharmacological impact."""
    if tau_min < 1:
        return "ultra-short"
    elif tau_min < 30:
        return "short"
    elif tau_min < 240:
        return "moderate"
    else:
        return "long"
```

### Pharmacological Implications

| Residence Time | Classification | Drug Behavior |
|---------------|---------------|---------------|
| < 1 min | Ultra-short | Effect tracks free concentration exactly. Must maintain plasma levels for continuous effect. |
| 1-30 min | Short | Standard reversible inhibitor. Effect declines within minutes of drug removal. |
| 30 min - 4 h | Moderate | Pharmacological effect outlasts plasma exposure. Allows less frequent dosing. |
| > 4 h | Long | Pseudo-irreversible on clinical timescale. Once-daily dosing feasible even with short plasma t1/2. |

### When Residence Time Matters

- **Competitive environment**: Long residence time provides advantage
  when competing with high endogenous ligand concentrations.
- **Fluctuating PK**: Long tau buffers against plasma concentration
  troughs — effect persists even when free drug drops.
- **Safety**: Long residence time at off-targets can amplify adverse
  effects. Report residence time at primary AND key off-targets.

## Functional Readouts for Target Engagement

Occupancy = binding. Functional readouts = biological consequence.
A compound can achieve 90% occupancy with no functional effect
(non-productive binding mode) or 50% occupancy with full pathway
inhibition (signal amplification).

### Readout Selection Guide

| Target Class | Primary Readout | Method | Timepoint |
|-------------|----------------|--------|-----------|
| Kinase | Phospho-substrate inhibition | Western blot, MSD, AlphaLISA | 1-4 h post-dose |
| Nuclear receptor | Reporter gene (luciferase) | Cell-based reporter | 6-24 h |
| Protease | Substrate cleavage rate | Fluorogenic substrate | 0.5-2 h |
| PPI disruptor | Co-immunoprecipitation | Co-IP, BRET, NanoBRET | 2-6 h |
| Epigenetic (HDAC, BET) | Histone mark change | Western blot, ChIP-qPCR | 4-24 h |
| Immune target (cytokine path) | Cytokine level | ELISA, Luminex | 6-48 h |
| Metabolic enzyme | Metabolite level | LC-MS/MS metabolomics | 1-4 h |
| Ion channel | Electrophysiology | Patch clamp, FLIPR | Minutes |

### Dose-Response for Target Engagement

Always generate a dose-response curve for the functional readout,
not just a single-dose measurement:

```python
from scipy.optimize import curve_fit

def sigmoid_emax(dose, emax, ec50, hill, baseline):
    """Standard Emax (Hill) model for PD dose-response."""
    return baseline + emax * dose**hill / (ec50**hill + dose**hill)

# Fit to observed data
popt, pcov = curve_fit(
    sigmoid_emax, doses, responses,
    p0=[100, np.median(doses), 1, 0],
    bounds=([0, 0, 0.1, -np.inf], [np.inf, np.inf, 10, np.inf]),
)
emax, ec50, hill, baseline = popt
```

Report: Emax (maximum effect), EC50 (concentration at 50% effect),
Hill coefficient (steepness), and R² of the fit.

## Integrated Target Engagement Assessment

A complete target engagement package combines:

1. **In vitro binding**: Kd/Ki from biochemical assay → predicted
   occupancy at clinical concentrations.
2. **Cellular functional readout**: EC50 for pathway modulation in
   relevant cell type → confirms productive binding.
3. **In vivo PD biomarker**: Pharmacodynamic marker change in tissue
   or surrogate (plasma, PBMCs) → confirms target modulation in the
   whole organism.
4. **PK-PD relationship**: Correlate PD biomarker change with drug
   exposure → establishes the exposure-PD relationship.

| Assessment Level | Confidence | Required Data |
|-----------------|------------|---------------|
| Occupancy only (calculated) | Low | Kd + PK (Cmax, Ctrough, fu) |
| Occupancy + cellular functional | Medium | Add cell-based EC50 |
| Occupancy + in vivo PD marker | High | Add pre-clinical or clinical PD biomarker |
| Full PK-PD model | Highest | Add exposure-response correlation |

## Gotchas

- **Total vs free concentration**: Using total plasma concentration
  for a drug with fu = 0.01 overestimates occupancy 100-fold.
- **Kd vs Ki vs IC50**: Kd (binding) is the correct input for
  occupancy calculations. Ki (inhibition constant) is acceptable
  for competitive inhibitors. IC50 depends on assay conditions and
  should NOT be used directly — convert via Cheng-Prusoff:
  Ki = IC50 / (1 + [S]/Km).
- **Intracellular targets**: Free drug at the target site may differ
  from free plasma drug due to active transport, efflux (P-gp),
  or intracellular accumulation. Note this uncertainty.
- **Covalent inhibitors**: Occupancy model does not apply directly —
  binding is irreversible, occupancy accumulates over time. Use
  kinact/KI instead of Kd.
- **Allosteric modulators**: Standard occupancy-response assumptions
  may not hold — allosteric mechanisms can show non-linear
  occupancy-response relationships.
