---
name: statistical-modeling
description: Read before you fit survival, classification, regression, or mixed-effects models, select biomarkers, set a cutpoint, or compare ROC curves. It covers leakage across steps, prognostic versus predictive claims, corrected cutpoint p-values, and the metrics and validation for each outcome.
metadata:
  version: 1.0.0
  tags: [survival, machine-learning, classification, regression, mixed-models, biomarker, shap]
---

# Statistical Modeling

This skill guides method selection and execution for survival analysis, classification, regression, feature selection, mixed-effects modeling, and model interpretation in biomedical contexts.

## Method Selection Decision Tree

Choose the method based on your outcome type and analytical goal:

### 1. Survival Analysis (time-to-event data with censoring)

- **Univariate (single variable, Kaplan-Meier curves)**
  - `lifelines.KaplanMeierFitter` for survival curves, `logrank_test()` for group comparison.
- **Multivariate (adjust for covariates)**
  - `lifelines.CoxPHFitter` for Cox proportional hazards regression. Check PH assumption with `check_assumptions()`.
    If the check fails, stratify on the covariate at fault (`strata=[...]`), or add a
    time-varying term. Then report the hazard ratio as time-averaged, not as a
    constant effect.
- **ML-based survival (non-linear, high-dimensional)**
  - `scikit-survival.RandomSurvivalForest` for non-linear survival prediction.
  - `scikit-survival.GradientBoostingSurvivalAnalysis` for best predictive performance.
- **Censoring encoding**: lifelines and scikit-survival take event indicator = 1 for the event and 0 for censored. Read the coding of the input from the data before you fit.

### 2. Binary Classification (predict discrete outcome)

Escalate complexity only when simpler models underperform:

- **Start**: `sklearn.LogisticRegression` (interpretable, baseline).
- **If non-linear patterns**: `sklearn.RandomForestClassifier` (handles interactions, feature importance built in).
- **If maximum performance needed**: `xgboost.XGBClassifier` (gradient boosting, tunable).
  - xgboost is thread-parallel: raise the thread limit for the training command to the full CPU budget of the step. Do not run it under forked workers (for example joblib) at the same time.
- **Metric**: Use **AUC-ROC** as primary metric. For imbalanced classes, also report **AUPRC** (precision-recall). Never use accuracy alone on imbalanced data.

### 3. Regression (predict continuous outcome)

- **Start**: `sklearn.Ridge` (L2), `sklearn.Lasso` (L1, sparsity), `sklearn.ElasticNet` (L1+L2).
- **If non-linear**: `sklearn.RandomForestRegressor`.
- **If maximum performance**: `xgboost.XGBRegressor`.
- **Metric**: RMSE (primary), R-squared (interpretability), MAE (robust to outliers).

### 4. Feature Selection / Biomarker Discovery

- **LASSO (L1 regularization)**: First choice for sparsity -- drives irrelevant coefficients to zero.
- **Recursive feature elimination**: `sklearn.RFECV` with cross-validation for optimal feature count.
- **SHAP values**: Use `shap.TreeExplainer` for tree-based models to rank features by contribution.
- **Permutation importance**: Model-agnostic fallback via `sklearn.inspection.permutation_importance`.
- **Stability selection**: Run LASSO on bootstrap resamples, keep features selected in >60% of iterations.

### 5. Mixed-Effects Models (hierarchical/nested data)

- **Simple random effects**: `statsmodels.MixedLM` (Python).
- **Complex random effects structures**: `lme4::lmer()` / `lme4::glmer()` via rpy2 for crossed random effects, GLMM.
- Use when data has natural grouping (patients within sites, repeated measures per subject).

### 6. Quick Statistical Tests

- Use **pingouin** for clean, publication-ready output with effect sizes:
  - `pingouin.ttest()`: t-test with Cohen's d, Bayes factor, CI.
  - `pingouin.anova()` / `pingouin.rm_anova()`: one-way and repeated measures ANOVA.
  - `pingouin.corr()`: correlation with multiple methods and CI.
  - `pingouin.pairwise_tests()`: post-hoc comparisons with correction.

## Model Evaluation Constraints

- Cross-validate with `StratifiedKFold` (classification) or `KFold` (regression), k = 5 or 10.
- Give a 95% CI for each metric: bootstrap 1000 times, or use the CV folds.
- Metrics: AUC-ROC, AUPRC, sensitivity, and specificity for binary classification. C-index, time-dependent AUC, and Brier score for survival. RMSE, R-squared, and MAE for regression.
- Report a calibration curve for probabilistic predictions.
- Hold out 20-30% as a final test set. Never tune hyperparameters on the test set.

## Output Conventions

- Save model performance as JSON: metric name, mean, CI_lower, CI_upper, n_folds.
- Save feature importance as TSV: feature, importance_score, rank, direction (if applicable).

## Anti-Patterns

- **xgboost under forked workers**: xgboost uses threads. Give its one process the full CPU budget of the step.
- **Data leakage**: Preprocessing (scaling, feature selection, imputation) MUST happen inside the cross-validation loop, not before the split. Use `sklearn.Pipeline` to enforce this. Selecting features over all samples first is the most common form and the hardest to spot, because nothing errors — the estimate is simply optimistic by several AUC points.
- **A feature list from an upstream step on the same samples**: An upstream DE gene list is a selection over all samples already. See Multi-Marker Panel Development.
- **An event column with a different coding**: A `censored` column, or a status coded 1 and 2, gives inverted or invalid events with no error. Convert it to 1 = event before you fit.
- **Multicollinearity in linear models**: Correlated features inflate the coefficient variance. Do a VIF check, or use Ridge/ElasticNet.
- **Complex models on small datasets**: With N < 100, use simple models (logistic regression, Cox PH). Tree ensembles overfit.

## Additional Available Packages

- **glmnet** (R via rpy2): LASSO, Ridge, and ElasticNet penalized regression. Use for high-dimensional feature selection (p >> n). `cv.glmnet()` for cross-validated lambda selection.
- **scikit-posthocs** (Python): Post-hoc pairwise tests (Dunn, Conover, Nemenyi, Games-Howell). Use after significant ANOVA/Kruskal-Wallis.
- **mgcv** (R via rpy2): Generalized Additive Models (GAMs). Use for non-linear covariate effects (`gam(y ~ s(x1) + x2)`).
- **nlme** (R via rpy2): Nonlinear mixed-effects models. Use when relationships are inherently nonlinear (dose-response curves, growth models).

## Biomarker Discovery & Qualification

### Biomarker Phase

State which phase of the FDA BEST framework the step addresses: discovery, analytical validation, clinical validation, or clinical utility. Most analyses here are discovery, or clinical validation when an independent outcome cohort exists.

### Predictive vs Prognostic Biomarkers — CRITICAL DISTINCTION

- **Prognostic**: associated with outcome REGARDLESS of treatment.
  Test: Cox PH or logistic regression with marker as predictor, no
  treatment interaction term. A gene that predicts poor survival in
  both treated and untreated patients is prognostic.

- **Predictive**: associated with DIFFERENTIAL response to a specific
  treatment. Test: include a treatment x marker interaction term in the
  model. Only if the interaction is significant can the marker be called
  predictive.

Do NOT call a marker "predictive" unless the interaction test is significant.
A marker that is only prognostic has no value for treatment selection, and a
single-arm study cannot produce the interaction at all. See
`references/lifelines-api.md` for the Cox interaction model.

### Cutpoint Optimization

**Reference:** `references/biomarker-cutpoints-roc.md` — read it for
`surv_cutpoint`, the `maxstat` corrected p-value, `OptimalCutpoints` criteria,
DeLong CIs and `timeROC`.

When a continuous biomarker must be dichotomized (high/low) for clinical use:

- **Survival outcome** → `survminer::surv_cutpoint` (R via rpy2), maximally
  selected rank statistics. Do not reimplement the scan: the maximum of a
  log-rank statistic over many candidate cutpoints is not chi-squared
  distributed, so the nominal p-value of the best split is meaningless. The
  multiplicity-corrected p-value comes from `maxstat`, and it is the number to
  report.
- **Binary outcome** → `OptimalCutpoints` (R via rpy2). Pick the criterion the
  clinical question implies — Youden weights false positives and false negatives
  equally, which is usually not what a screening setting wants.

Always report the cutpoint, the corrected p-value, the group sizes either side,
and Kaplan-Meier curves for high/low. A split that leaves 5% in one arm is an
artefact whatever its p-value.

**Anti-pattern:** Optimizing on the same data you report performance on.
Use nested CV or a held-out test set.

### Multi-Marker Panel Development

The goal is a locked panel: the selected features and the model coefficients, with the performance on held-out folds (AUC-ROC, AUC-PRC, or C-index) and bootstrap confidence intervals.

Feature selection belongs **inside** the cross-validation loop, not before it —
selecting over all samples first is the most common leak in panel development
and reliably adds several AUC points that do not survive external validation.
See `references/scikit-learn-api.md` for the nested-CV construction.

The rule spans steps. A gene list from an upstream differential-expression
step on the same samples is already a selection over all samples. Build the
panel from the full feature matrix, and select again inside cross-validation.
If only the pre-selected list is available, report the performance estimate
as optimistic, and say why.

### ROC Analysis

**Reference:** `references/biomarker-cutpoints-roc.md`.

Pick on the outcome type — a single AUC is undefined once outcomes are censored:

```
Outcome?
├── Binary, no censoring
│   ├── Curve and AUC → sklearn.metrics (roc_curve, roc_auc_score)
│   ├── Confidence interval → pROC::ci.auc (DeLong, closed form)
│   └── Comparing two markers on the SAME subjects → pROC::roc.test (paired)
└── Time-to-event, censored
    └── timeROC at clinically meaningful horizons, iid=TRUE for CIs
```

- **Do not bootstrap an AUC CI.** DeLong is analytic — faster, and not subject to
  resampling noise.
- **Overlapping CIs are not a test.** Two markers measured on the same subjects
  are correlated; `roc.test` accounts for it, CI overlap does not.
- **Do not collapse censored survival into a binary label** to reuse a fixed-time
  AUC. It discards timing and misclassifies everyone censored early.

Always report BOTH AUC-ROC and AUPRC. For imbalanced datasets, AUPRC
is more informative than AUC-ROC.

## References

| File | Purpose |
|-|-|
| `references/lifelines-api.md` | lifelines API: KaplanMeier, CoxPH, log-rank test, prognostic-vs-predictive interaction model |
| `references/scikit-learn-api.md` | scikit-learn API: classifiers, regressors, pipelines, cross-validation, nested CV for panel development |
| `references/scikit-survival-api.md` | scikit-survival API: RSF, GBS, concordance index |
| `references/xgboost-api.md` | XGBoost API: XGBClassifier, XGBRegressor, tuning |
| `references/shap-api.md` | SHAP API: TreeExplainer, summary plots, dependence |
| `references/statsmodels-api.md` | statsmodels API: MixedLM, OLS, GLM |
| `references/pingouin-api.md` | pingouin API: ttest, anova, correlation, effect sizes |
| `references/biomarker-cutpoints-roc.md` | survminer/maxstat cutpoints with corrected p-values, OptimalCutpoints criteria, pROC DeLong CIs and paired tests, timeROC time-dependent AUC |
