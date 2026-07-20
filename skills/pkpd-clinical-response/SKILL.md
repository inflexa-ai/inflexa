---
name: pkpd-clinical-response
description: Pharmacokinetic/pharmacodynamic modeling, exposure-response analysis, clinical response classification (RECIST/iRECIST), dose-response curves, population PK covariate modeling, PD biomarker tracking, PK-PD hysteresis, and time-to-event endpoints
version: 1.1.0
tags: [pharmacokinetics, pharmacodynamics, PK/PD, exposure-response, RECIST, iRECIST, dose-response, clinical-response, pd-biomarker, hysteresis, NCA, population-pk, lifelines, survival-analysis]
---

# PK/PD & Clinical Response

This skill guides pharmacokinetic/pharmacodynamic data analysis and
clinical response evaluation in Phase 1/2 trial-adjacent contexts.

## Clinical Response Classification

### RECIST 1.1 (Response Evaluation Criteria in Solid Tumors)

**Reference:** `references/clinical-response-criteria.md` — read it for full RECIST 1.1 tables, overall response derivation matrix, `recist_classify_target()`, `best_overall_response()`, and iRECIST pseudoprogression rules.

| Category | Abbreviation | Definition |
|----------|-------------|------------|
| Complete Response | CR | Disappearance of all target lesions |
| Partial Response | PR | >=30% decrease in sum of diameters |
| Stable Disease | SD | Neither PR nor PD criteria met |
| Progressive Disease | PD | >=20% increase in sum + absolute increase >=5mm, or new lesion |

When response data is present:
- Binary: responder (CR+PR) vs non-responder (SD+PD)
- Ordinal: CR > PR > SD > PD (use ordinal logistic regression)
- Duration: time to best response, duration of response

### iRECIST (for immunotherapy)
Adds "unconfirmed" states (iUPD → must confirm with iCPD at next
assessment). For IO trials, always check if iRECIST was used.

## Pharmacokinetic Analysis

### Non-Compartmental Analysis (NCA)

**Reference:** `references/nca-analysis.md` — read it for complete NCA functions (`auc_linear_trapezoidal`, `auc_log_linear_trapezoidal`, `auc_extrapolated`, `terminal_half_life`, `derive_pk_params`), concentration-time plots, and quality checks.

Always report: Cmax, Tmax, AUC(0-last), AUC(0-inf), t1/2, CL/F, Vd/F.
Plot: concentration-time profile (linear and semi-log scale).

### Population PK Covariates

**Reference:** `references/population-pk.md` — read it for statsmodels MixedLM syntax, random effects specification, `forward_selection()`, `backward_elimination()`, standard PK covariates table, allometric scaling, and diagnostic plots.

When patient demographic/clinical data is available alongside PK data:
- Test covariates: age, weight, sex, renal function (eGFR), hepatic
  function (Child-Pugh), genotype (CYP polymorphisms)
- Use mixed-effects models (statsmodels MixedLM or lme4 via rpy2)
- Forward addition / backward elimination for covariate selection

## Exposure-Response Analysis

### Efficacy Exposure-Response

**Reference:** `references/dose-exposure-response.md` — read it for `four_param_logistic()` fitting, `exposure_response_binary()`, `safety_exposure_response()` (time-to-AE by exposure quartile), and `identify_therapeutic_window()`.

Link drug exposure (AUC, Cmax, Cmin) to efficacy outcomes. Use logistic regression for binary response vs exposure, and derive EC50 (exposure at 50% response probability) from the fitted model.

### Safety Exposure-Response

**Reference:** `references/lifelines-pkpd.md` — read it for `safety_exposure_response()` with KM + log-rank, `cox_exposure_safety()` for multivariate hazard models, and at-risk table formatting.

Link exposure to adverse event probability:
- Logistic regression: P(AE grade >= 3) ~ AUC_ss
- Kaplan-Meier: time to first grade 3+ AE by exposure quartile
- Identify therapeutic window: exposure range where efficacy is
  maintained but safety is acceptable

### Dose-Response Curves

Fit a 4-parameter logistic (Hill equation) to dose-response data. See the reference for 4PL/3PL fitting functions and plotting.

Always plot: observed data points + fitted curve + 95% CI band.
Report: EC50/IC50, Hill coefficient, Emax, R-squared.

## Responder vs Non-Responder Analysis with Omics

When paired PK/response + omics data is available:

1. **Define groups** — responder vs non-responder per RECIST or custom
   criteria. Document the exact definition.
2. **DE analysis** — standard differential expression between groups.
   Use the response classification as the contrast, not treatment
   (treatment is constant in single-arm trials).
3. **Exposure-stratified analysis** — split by exposure quartiles, then
   compare omics profiles. This separates pharmacokinetic effects
   (dose-dependent transcriptional changes) from pharmacodynamic effects
   (target-dependent biology).
4. **Predictive biomarker analysis** — if treatment and control arms
   exist, test marker x treatment interaction (see statistical-modeling
   skill for predictive vs prognostic testing).

## Waterfall and Spider Plots

Standard clinical trial visualizations. See PD biomarker tracking reference for waterfall plot functions.

- **Waterfall plot**: Best % change from baseline per patient, sorted ascending, colored by response category (green = PR threshold at -30%, red = PD threshold at +20%).
- **Spider plot**: Per-patient tumor burden over time (individual traces), with RECIST thresholds overlaid.

## Pharmacodynamic Biomarker Tracking

**Reference:** `references/pd-biomarker-tracking.md` — read it for complete PD assessment functions (`compute_pd_change`, `classify_pd_response`, `plot_pd_timecourse`, `plot_pd_by_dose`), hysteresis diagnosis, PD-exposure mixed-effects modeling, and waterfall plots.

### Longitudinal PD Marker Assessment

PD biomarkers measure target modulation and downstream biological
effects over time. Track them at defined timepoints relative to dosing:

| Phase | Typical Timepoints | Purpose |
|-------|-------------------|---------|
| Pre-treatment (baseline) | C1D1 pre-dose | Reference values |
| On-treatment early | C1D2, C1D8, C1D15 | Onset of PD effect |
| On-treatment steady-state | C2D1, C3D1 | Sustained modulation |
| Post-treatment washout | 1w, 2w, 4w post-last-dose | Recovery kinetics |

C = cycle, D = day, w = week.

### PD Response Criteria

Define PD response categories based on marker change thresholds:

| Category | Typical Threshold | Example |
|----------|------------------|---------|
| PD responder | >= 50% decrease from baseline | Phospho-protein inhibition |
| PD partial responder | 30-50% decrease | Cytokine reduction |
| PD non-responder | < 30% decrease | No target modulation |
| PD rebound | Return to >= 80% of baseline after initial decrease | Resistance or washout |

Always document: which marker, what threshold, at which timepoint, and
the biological rationale for the threshold.

### PK-PD Hysteresis

When plotting PD effect vs drug concentration, a hysteresis loop
indicates temporal dissociation between PK and PD:

- **Counter-clockwise hysteresis** — PD effect lags behind concentration
  (common: indirect response mechanisms, signal transduction delays).
- **Clockwise hysteresis** — PD effect precedes concentration decline
  (rare: tolerance, receptor desensitization).

### PD Marker-Exposure Correlation

Link PD marker changes to drug exposure using mixed-effects models
to account for repeated measures. Always report whether the PD-exposure relationship is:
- **Monotonic** — more drug = more PD effect (expected for on-target)
- **Saturating** — PD effect plateaus at high exposure (target fully engaged)
- **Bell-shaped** — PD effect decreases at very high exposure (off-target or toxicity)

## References

Detailed API references, ready-to-use functions, and domain-specific
gotchas. Read the reference file itself before writing code in that area.

| Reference | File | Contents |
|-----------|------|----------|
| NCA Analysis | `references/nca-analysis.md` | AUC (linear/log-linear/extrapolated), terminal half-life, full NCA parameter derivation, concentration-time plots, quality checks |
| Dose & Exposure-Response | `references/dose-exposure-response.md` | 4PL/3PL dose-response fitting, exposure-response logistic regression, safety E-R (time-to-AE by quartile), therapeutic window identification |
| Population PK | `references/population-pk.md` | statsmodels MixedLM for pop PK, random effects specification, forward/backward covariate selection, standard covariates table, allometric scaling, diagnostic plots |
| Clinical Response Criteria | `references/clinical-response-criteria.md` | RECIST 1.1 full tables (target/non-target/overall), iRECIST pseudoprogression rules, response endpoint derivation (ORR, DCR, DOR, TTR, PFS) |
| PD Biomarker Tracking | `references/pd-biomarker-tracking.md` | PD change from baseline, PD response classification, PK-PD hysteresis (plot + diagnosis), PD-exposure correlation, waterfall plots |
| Lifelines for PK/PD | `references/lifelines-pkpd.md` | KM for DOR/PFS/TTR, safety exposure-response, Cox PH for multivariate analysis, at-risk tables, competing risks guidance |

## Do NOT

- Fit compartmental PK models without sufficient timepoints (need >=
  2x the number of parameters)
- Report PK parameters without specifying the dose, route, and whether
  steady-state was reached
- Use NCA terminal half-life if the terminal phase has fewer than 3
  points or R-squared < 0.8
- Conflate exposure-response with dose-response — exposure accounts
  for PK variability, dose does not
- Call a biomarker "predictive" without a treatment x marker interaction
  test (this is the single most common error)
- Assume single-arm trial biomarkers are predictive — they can only be
  prognostic without a control arm
