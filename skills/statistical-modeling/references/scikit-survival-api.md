# scikit-survival API Reference

Survival analysis built on scikit-learn. Uses structured NumPy arrays with `(event: bool, time: float)` tuples as the target variable.

## Structured Array Creation

```python
import numpy as np
from sksurv.util import Surv

# From separate arrays
y = Surv.from_arrays(
    event=df['event'].astype(bool),    # True = event, False = censored
    time=df['time'].astype(float)
)
# Returns: numpy structured array, dtype=[('event', '?'), ('time', '<f8')]

# Manual creation (equivalent)
y = np.array(
    [(True, 5.0), (False, 3.2), (True, 8.1)],
    dtype=[('event', bool), ('time', float)]
)

# Access fields
y['event']   # boolean array
y['time']    # float array
```

## CoxPHSurvivalAnalysis

```python
from sksurv.linear_model import CoxPHSurvivalAnalysis

cph = CoxPHSurvivalAnalysis(alpha=0.0001, ties='breslow')
cph.fit(X_train, y_train)

# Risk scores (higher = higher risk)
risk_scores = cph.predict(X_test)

# Survival function per sample (returns array of StepFunction objects)
surv_fns = cph.predict_survival_function(X_test)
for fn in surv_fns[:3]:
    plt.step(fn.x, fn(fn.x), where='post')

# Cumulative hazard
cum_haz_fns = cph.predict_cumulative_hazard_function(X_test)

# Coefficients
cph.coef_                          # ndarray of fitted coefficients
```

## RandomSurvivalForest

```python
from sksurv.ensemble import RandomSurvivalForest

rsf = RandomSurvivalForest(
    n_estimators=100,
    min_samples_split=10,
    min_samples_leaf=15,
    n_jobs=-1,
    random_state=42
)
rsf.fit(X_train, y_train)

# Risk scores
risk_scores = rsf.predict(X_test)

# Survival curves (array of StepFunction objects)
surv_fns = rsf.predict_survival_function(X_test)

# Evaluate survival probabilities at specific times
import numpy as np
times = np.array([12, 24, 36, 60])
surv_probs = np.vstack([fn(times) for fn in surv_fns])   # shape: (n_samples, n_times)

# Feature importance (impurity-based, same as sklearn RandomForest)
rsf.feature_importances_
```

## GradientBoostingSurvivalAnalysis

```python
from sksurv.ensemble import GradientBoostingSurvivalAnalysis

gbs = GradientBoostingSurvivalAnalysis(
    n_estimators=100,
    learning_rate=0.1,
    max_depth=3,
    loss='coxph',                  # 'coxph' enables survival function prediction
    random_state=42
)
gbs.fit(X_train, y_train)

risk_scores = gbs.predict(X_test)
gbs.feature_importances_

# Survival function (only with loss='coxph')
surv_fns = gbs.predict_survival_function(X_test)
```

## Metrics

```python
from sksurv.metrics import (
    concordance_index_censored,
    concordance_index_ipcw,
    brier_score,
    integrated_brier_score,
    cumulative_dynamic_auc
)

# Concordance index (C-index)
c_index, concordant, discordant, tied_risk, tied_time = concordance_index_censored(
    y_test['event'],
    y_test['time'],
    risk_scores                    # higher = higher risk
)

# IPCW C-index (accounts for censoring bias)
c_ipcw, _, _, _, _ = concordance_index_ipcw(
    y_train, y_test,               # structured arrays
    risk_scores,
    tau=None                       # optional time horizon
)

# Brier score at specific times
lower, upper = np.percentile(y_test['time'][y_test['event']], [10, 90])
times = np.arange(lower, upper + 1)
surv_probs = np.vstack([fn(times) for fn in model.predict_survival_function(X_test)])

_, bs = brier_score(y_train, y_test, surv_probs, times)

# Integrated Brier score (single summary metric)
ibs = integrated_brier_score(y_train, y_test, surv_probs, times)

# Cumulative dynamic AUC (time-dependent discrimination)
auc, mean_auc = cumulative_dynamic_auc(y_train, y_test, risk_scores, times)
```

## Complete Workflow Example

```python
import numpy as np
import matplotlib.pyplot as plt
from sklearn.model_selection import train_test_split
from sksurv.util import Surv
from sksurv.ensemble import RandomSurvivalForest
from sksurv.metrics import concordance_index_censored, integrated_brier_score

# Prepare structured target
y = Surv.from_arrays(event=df['event'].astype(bool), time=df['time'])
X = df.drop(columns=['event', 'time'])

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

# Fit model
rsf = RandomSurvivalForest(n_estimators=200, min_samples_leaf=10, n_jobs=-1, random_state=42)
rsf.fit(X_train, y_train)

# C-index
risk = rsf.predict(X_test)
c_idx = concordance_index_censored(y_test['event'], y_test['time'], risk)[0]
print(f"C-index: {c_idx:.4f}")

# Plot survival curves for select samples
surv_fns = rsf.predict_survival_function(X_test)
fig, ax = plt.subplots(figsize=(8, 5))
for i, fn in enumerate(surv_fns[:5]):
    ax.step(fn.x, fn(fn.x), where='post', label=f'Sample {i}')
ax.set_xlabel('Time')
ax.set_ylabel('Survival Probability')
ax.legend()
plt.tight_layout()
plt.savefig('rsf_survival_curves.png', dpi=150)
plt.close()
```

## Gotchas

- Target `y` must be a NumPy structured array with `(event: bool, time: float)` -- use `Surv.from_arrays()`.
- `event` field must be boolean (`True` = event, `False` = censored). Integer 1/0 must be cast with `.astype(bool)`.
- `predict()` returns risk scores (higher = higher risk), not survival times.
- `predict_survival_function()` returns `StepFunction` objects by default. Call `fn(times)` to evaluate at specific timepoints.
- For `GradientBoostingSurvivalAnalysis`, survival function prediction requires `loss='coxph'`.
- `brier_score` and `integrated_brier_score` require both `y_train` and `y_test` structured arrays (train is used for inverse probability of censoring weights).
- All features must be numeric -- encode categoricals before fitting.
- `concordance_index_censored` returns a 5-tuple; the C-index is the first element.
