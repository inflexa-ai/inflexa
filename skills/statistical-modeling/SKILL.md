---
name: statistical-modeling
description: Statistical modeling and machine learning for biomarker discovery, survival analysis, classification, regression, and model interpretation
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
- **ML-based survival (non-linear, high-dimensional)**
  - `scikit-survival.RandomSurvivalForest` for non-linear survival prediction.
  - `scikit-survival.GradientBoostingSurvivalAnalysis` for best predictive performance.
- **Censoring encoding**: event indicator = 1 means the event occurred, 0 means censored. Verify this before fitting.

### 2. Binary Classification (predict discrete outcome)

Escalate complexity only when simpler models underperform:

- **Start**: `sklearn.LogisticRegression` (interpretable, baseline).
- **If non-linear patterns**: `sklearn.RandomForestClassifier` (handles interactions, feature importance built in).
- **If maximum performance needed**: `xgboost.XGBClassifier` (gradient boosting, tunable).
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

## Model Evaluation Protocol

- **ALWAYS cross-validate**: Use `sklearn.StratifiedKFold` (classification) or `sklearn.KFold` (regression) with k=5 or k=10.
- **Report confidence intervals**: Bootstrap the performance metric (1000 iterations) or use cross-validation folds to compute mean and 95% CI.
- **Appropriate metrics by task**:
  - Binary classification: AUC-ROC, AUPRC, sensitivity, specificity at optimal threshold.
  - Survival: Concordance index (C-index), time-dependent AUC, Brier score.
  - Regression: RMSE, R-squared, MAE.
- **Calibration**: For probabilistic predictions, report calibration curves (`sklearn.calibration.calibration_curve`).
- **Train/test split**: Hold out 20-30% as a final test set. Never tune hyperparameters on the test set.

## Interpretability

- **SHAP TreeExplainer**: Primary choice for tree-based models (RandomForest, XGBoost). Produces summary plots, dependence plots, and force plots.
- **SHAP KernelExplainer**: Model-agnostic fallback for non-tree models. Slower but universal.
- **Permutation importance**: Quick, model-agnostic. Use as a sanity check alongside SHAP.
- **Partial dependence plots**: `sklearn.inspection.PartialDependenceDisplay` for marginal effect of top features.
- Always report top 10-20 features with their importance scores and direction of effect.

## Output Conventions

- Save model performance as JSON: metric name, mean, CI_lower, CI_upper, n_folds.
- Save feature importance as TSV: feature, importance_score, rank, direction (if applicable).
- Generate ROC curve plot (with AUC and CI in legend) for classification.
- Generate Kaplan-Meier plot (with risk table, log-rank p-value, median survival) for survival.
- Generate SHAP summary plot (beeswarm) for top 20 features.
- Write methods section describing model choice, cross-validation strategy, and evaluation metrics.

## Anti-Patterns

- **No cross-validation**: Reporting train-set performance leads to overfitting claims. ALWAYS cross-validate.
- **Data leakage**: Preprocessing (scaling, feature selection, imputation) MUST happen inside the cross-validation loop, not before the split. Use `sklearn.Pipeline` to enforce this.
- **Wrong survival censoring encoding**: Verify that 1 = event occurred, 0 = censored. Swapping these inverts all results silently.
- **Using accuracy for imbalanced classes**: A 95/5 class split gives 95% accuracy by predicting the majority class. Use AUC-ROC or AUPRC instead.
- **Not reporting confidence intervals**: A single point estimate of AUC is insufficient. Always report CI from cross-validation or bootstrapping.
- **Feature selection on full dataset then evaluating on same data**: This is a form of data leakage. Feature selection must be part of the cross-validation loop.
- **Ignoring multicollinearity in linear models**: Highly correlated features inflate coefficient variance. Use VIF checks or regularization (Ridge/ElasticNet).
- **Overly complex models on small datasets**: With N < 100 samples, prefer simple models (logistic regression, Cox PH). Tree ensembles overfit on small N.

## Additional Available Packages

- **glmnet** (R via rpy2): LASSO, Ridge, and ElasticNet penalized regression. Use for high-dimensional feature selection (p >> n). `cv.glmnet()` for cross-validated lambda selection.
- **pROC** (R via rpy2): ROC curve analysis with DeLong confidence intervals for AUC. Use for binary classifier evaluation.
- **scikit-posthocs** (Python): Post-hoc pairwise tests (Dunn, Conover, Nemenyi, Games-Howell). Use after significant ANOVA/Kruskal-Wallis.
- **formulaic** (Python): Patsy-compatible formula interface. Use with statsmodels for R-style formulas (`y ~ C(group) * covariate`).
- **mgcv** (R via rpy2): Generalized Additive Models (GAMs). Use for non-linear covariate effects (`gam(y ~ s(x1) + x2)`).
- **nlme** (R via rpy2): Nonlinear mixed-effects models. Use when relationships are inherently nonlinear (dose-response curves, growth models).

## References

| File | Purpose |
|-|-|
| `references/lifelines-api.md` | lifelines API: KaplanMeier, CoxPH, log-rank test |
| `references/scikit-learn-api.md` | scikit-learn API: classifiers, regressors, pipelines, CV |
| `references/scikit-survival-api.md` | scikit-survival API: RSF, GBS, concordance index |
| `references/xgboost-api.md` | XGBoost API: XGBClassifier, XGBRegressor, tuning |
| `references/shap-api.md` | SHAP API: TreeExplainer, summary plots, dependence |
| `references/statsmodels-api.md` | statsmodels API: MixedLM, OLS, GLM |
| `references/pingouin-api.md` | pingouin API: ttest, anova, correlation, effect sizes |

## Biomarker Discovery & Qualification

### BEST Framework (FDA Biomarkers, EndpointS, and other Tools)

Biomarker development has distinct phases. Each analysis step should
know which phase it operates in:

1. **Discovery** — identify candidate markers from omics data (DE genes,
   ML feature importance, survival-associated features). This is what
   most omics analyses produce.
2. **Analytical Validation** — assess measurement properties: precision,
   reproducibility, dynamic range, limits of detection. Requires
   replicate measurements or technical validation data.
3. **Clinical Validation** — test marker-outcome association in an
   independent clinical cohort. Requires outcome data separate from
   the discovery cohort.
4. **Clinical Utility** — demonstrate that using the biomarker improves
   patient outcomes. Requires interventional trial data (rare in
   computational-only work).

Most Cortex analyses operate at phase 1 (discovery) or phase 3
(clinical validation if outcome data is available). Be explicit about
which phase the current analysis addresses.

### Predictive vs Prognostic Biomarkers — CRITICAL DISTINCTION

- **Prognostic**: associated with outcome REGARDLESS of treatment.
  Test: Cox PH or logistic regression with marker as predictor, no
  treatment interaction term. A gene that predicts poor survival in
  both treated and untreated patients is prognostic.

- **Predictive**: associated with DIFFERENTIAL response to a specific
  treatment. Test: include a treatment x marker interaction term in the
  model. Only if the interaction is significant can the marker be called
  predictive.

```python
# Prognostic test (marker → outcome)
from lifelines import CoxPHFitter
cph = CoxPHFitter()
cph.fit(df[["time", "event", "marker"]], "time", "event")

# Predictive test (marker x treatment → outcome)
df["marker_x_treatment"] = df["marker"] * df["treatment"]
cph_pred = CoxPHFitter()
cph_pred.fit(
    df[["time", "event", "marker", "treatment", "marker_x_treatment"]],
    "time", "event",
)
interaction_pval = cph_pred.summary.loc["marker_x_treatment", "p"]
```

Do NOT call a marker "predictive" unless the interaction test is significant.
A marker that is only prognostic has no value for treatment selection.

### Cutpoint Optimization

When a continuous biomarker must be dichotomized (high/low) for clinical use:

```python
# MaxStat approach (survminer-like in Python)
from lifelines import CoxPHFitter
from lifelines.statistics import logrank_test
import numpy as np

def find_optimal_cutpoint(df, marker_col, time_col, event_col,
                          min_group_frac=0.2):
    """Find optimal cutpoint via maximally selected rank statistics."""
    values = df[marker_col].dropna().sort_values().unique()
    lo = np.quantile(values, min_group_frac)
    hi = np.quantile(values, 1 - min_group_frac)
    candidates = values[(values >= lo) & (values <= hi)]

    best_stat, best_cut = -np.inf, None
    for cut in candidates:
        mask = df[marker_col] >= cut
        if mask.sum() < 5 or (~mask).sum() < 5:
            continue
        result = logrank_test(
            df.loc[mask, time_col], df.loc[~mask, time_col],
            df.loc[mask, event_col], df.loc[~mask, event_col],
        )
        if result.test_statistic > best_stat:
            best_stat = result.test_statistic
            best_cut = cut
    return best_cut, best_stat
```

Always report:
- The optimal cutpoint and its log-rank statistic
- Kaplan-Meier curves for high/low groups
- Bootstrap confidence interval for the cutpoint (resample 1000x)
- Sensitivity analysis: how does performance change +/- 10% from cutpoint?

**Anti-pattern:** Optimizing on the same data you report performance on.
Use nested CV or a held-out test set.

### Multi-Marker Panel Development

When building a biomarker panel (signature of multiple markers):

1. **Feature selection** — LASSO, elastic net, or recursive feature
   elimination with cross-validation. Report the number of features
   selected and their identities.
2. **Panel construction** — fit a model using selected features.
   Logistic regression for classification, Cox for survival.
3. **Internal validation** — report performance on held-out folds
   (AUC-ROC, AUC-PRC, C-index). Include confidence intervals via
   bootstrap (1000 iterations).
4. **Panel lock-down** — after validation, freeze the feature set and
   model coefficients. Report the locked signature for external
   validation.

```python
from sklearn.linear_model import LogisticRegressionCV
from sklearn.model_selection import RepeatedStratifiedKFold
from sklearn.metrics import roc_auc_score
import numpy as np

# Panel construction with nested CV
cv_outer = RepeatedStratifiedKFold(n_splits=5, n_repeats=10, random_state=42)
aucs = []
for train_idx, test_idx in cv_outer.split(X, y):
    model = LogisticRegressionCV(
        penalty="elasticnet", solver="saga", l1_ratios=[0.5],
        cv=5, scoring="roc_auc", max_iter=5000, random_state=42,
    )
    model.fit(X[train_idx], y[train_idx])
    prob = model.predict_proba(X[test_idx])[:, 1]
    aucs.append(roc_auc_score(y[test_idx], prob))

print(f"AUC: {np.mean(aucs):.3f} (95% CI: {np.percentile(aucs, 2.5):.3f}-{np.percentile(aucs, 97.5):.3f})")
```

### ROC Analysis Best Practices

Use `sklearn.metrics` for ROC analysis in Python:

```python
from sklearn.metrics import (
    roc_curve, roc_auc_score, precision_recall_curve,
    average_precision_score,
)
import matplotlib.pyplot as plt

# ROC curve with AUC and CI
fpr, tpr, thresholds = roc_curve(y_true, y_score)
auc = roc_auc_score(y_true, y_score)

# Bootstrap AUC CI
from sklearn.utils import resample
boot_aucs = []
for _ in range(1000):
    idx = resample(range(len(y_true)), random_state=None)
    if len(set(y_true[idx])) < 2:
        continue
    boot_aucs.append(roc_auc_score(y_true[idx], y_score[idx]))
ci_lo, ci_hi = np.percentile(boot_aucs, [2.5, 97.5])

# Youden's J for optimal threshold
j_scores = tpr - fpr
best_idx = np.argmax(j_scores)
optimal_threshold = thresholds[best_idx]
```

Always report BOTH AUC-ROC and AUPRC. For imbalanced datasets, AUPRC
is more informative than AUC-ROC.
