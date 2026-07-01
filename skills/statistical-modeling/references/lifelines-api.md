# lifelines API Reference

Survival analysis library. Data format: each row is one subject with a duration column (time to event or censoring) and an event column (1 = event occurred, 0 = censored).

## KaplanMeierFitter

```python
from lifelines import KaplanMeierFitter

kmf = KaplanMeierFitter(alpha=0.05)

# Fit: durations array, event_observed array (1=event, 0=censored)
kmf.fit(
    durations=df['time'],
    event_observed=df['event'],
    label='Treatment A'
)

# Key attributes after fitting
kmf.median_survival_time_          # median survival time (scalar)
kmf.survival_function_             # DataFrame with survival probabilities at each timepoint
kmf.confidence_interval_           # DataFrame with CI bounds
kmf.event_table                    # event table (at risk, events, censored per timepoint)

# Plotting
ax = kmf.plot_survival_function()  # returns matplotlib Axes

# Overlay multiple groups
import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(8, 5))
for name, group_df in df.groupby('group'):
    kmf.fit(group_df['time'], group_df['event'], label=name)
    kmf.plot_survival_function(ax=ax)
ax.set_xlabel('Time')
ax.set_ylabel('Survival Probability')
plt.tight_layout()
plt.savefig('km_curves.png', dpi=150)
plt.close()
```

## NelsonAalenFitter

```python
from lifelines import NelsonAalenFitter

naf = NelsonAalenFitter()
naf.fit(df['time'], event_observed=df['event'])

naf.cumulative_hazard_             # DataFrame with cumulative hazard estimates
naf.confidence_interval_           # CI for cumulative hazard
naf.plot_cumulative_hazard()
```

## CoxPHFitter

```python
from lifelines import CoxPHFitter

cph = CoxPHFitter(penalizer=0.01, l1_ratio=0.0)

# Input: DataFrame with covariates + duration + event columns
cph.fit(
    df,
    duration_col='time',
    event_col='event',
    show_progress=True
)

# Results
cph.print_summary()                # full summary table
cph.summary                        # DataFrame: coef, exp(coef), se, p, CI
cph.concordance_index_             # C-index (predictive accuracy)
cph.params_                        # Series of coefficients
cph.hazard_ratios_                 # Series of exp(coef) = hazard ratios

# Plotting
cph.plot()                         # forest plot of hazard ratios with CIs

# Predictions
cph.predict_median(new_df)                   # median survival for new subjects
cph.predict_survival_function(new_df)        # full survival curve per subject
cph.predict_partial_hazard(new_df)           # exp(X * beta) partial hazard

# Proportional hazards assumption check
cph.check_assumptions(df, p_value_threshold=0.05, show_plots=True)
```

## Log-Rank Test

```python
from lifelines.statistics import logrank_test, multivariate_logrank_test

# Two-group comparison
results = logrank_test(
    durations_A=df_a['time'],
    durations_B=df_b['time'],
    event_observed_A=df_a['event'],
    event_observed_B=df_b['event'],
    alpha=0.95
)
results.print_summary()
results.p_value                    # float
results.test_statistic             # chi-squared statistic

# Weighting options: 'wilcoxon', 'tarone-ware', 'peto', 'fleming-harrington'
results = logrank_test(T_a, T_b, E_a, E_b, weightings='wilcoxon')

# Multi-group comparison (3+ groups)
results = multivariate_logrank_test(
    df['time'],
    df['group'],
    df['event']
)
results.print_summary()
results.p_value
```

## Concordance Index

```python
from lifelines.utils import concordance_index

# Compare predicted risk scores against actual outcomes
c_index = concordance_index(
    event_times=df['time'],
    predicted_scores=-cph.predict_partial_hazard(df),  # negate so higher = longer survival
    event_observed=df['event']
)
```

## Complete Workflow Example

```python
import pandas as pd
import matplotlib.pyplot as plt
from lifelines import KaplanMeierFitter, CoxPHFitter
from lifelines.statistics import logrank_test

# Kaplan-Meier by group
fig, ax = plt.subplots(figsize=(8, 5))
kmf = KaplanMeierFitter()
for group_name, group_df in df.groupby('treatment'):
    kmf.fit(group_df['duration'], group_df['event'], label=group_name)
    kmf.plot_survival_function(ax=ax)
    print(f"{group_name} median survival: {kmf.median_survival_time_:.1f}")

# Log-rank test
treated = df[df['treatment'] == 'drug']
control = df[df['treatment'] == 'placebo']
lr = logrank_test(treated['duration'], control['duration'],
                  treated['event'], control['event'])
ax.set_title(f'Survival by Treatment (log-rank p={lr.p_value:.4f})')
plt.tight_layout()
plt.savefig('survival_analysis.png', dpi=150)
plt.close()

# Cox PH regression
cph = CoxPHFitter(penalizer=0.01)
cph.fit(df[['duration', 'event', 'age', 'treatment_binary', 'stage']],
        duration_col='duration', event_col='event')
cph.print_summary()
cph.check_assumptions(df)
cph.plot()
plt.tight_layout()
plt.savefig('cox_forest.png', dpi=150)
plt.close()
```

## Gotchas

- `event_col`: 1 = event occurred, 0 = right-censored. Boolean also works (True = event).
- `duration_col` must be positive (> 0). Zero durations cause fitting errors.
- `CoxPHFitter` requires no missing values in covariates -- drop or impute NaNs before fitting.
- `check_assumptions()` needs the original DataFrame (not just duration/event columns).
- `median_survival_time_` returns `inf` if the survival curve never drops below 0.5.
- `concordance_index` from `lifelines.utils` expects higher predicted scores = higher risk. Negate if your model predicts survival time.
- Penalizer (`penalizer=0.01`) helps with convergence when covariates are correlated.
