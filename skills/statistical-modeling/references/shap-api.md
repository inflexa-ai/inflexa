# SHAP API Reference

SHapley Additive exPlanations for model interpretability. Computes feature contributions to individual predictions.

## Explainers

```python
import shap

# TreeExplainer: exact SHAP for tree-based models (XGBoost, LightGBM, CatBoost, sklearn)
explainer = shap.TreeExplainer(model)
shap_values = explainer(X_test)                              # Explanation object

# With background data (interventional, accounts for feature dependencies)
explainer = shap.TreeExplainer(model, X_train, feature_perturbation="interventional")
shap_values = explainer(X_test)

# Model-agnostic Explainer (auto-selects best algorithm)
explainer = shap.Explainer(model, X_train)
shap_values = explainer(X_test)

# KernelExplainer: model-agnostic (slow, use as fallback)
explainer = shap.KernelExplainer(model.predict, X_train[:100])
shap_values = explainer.shap_values(X_test, nsamples=200)    # returns ndarray

# LinearExplainer: for linear models
explainer = shap.LinearExplainer(model, X_train)
shap_values = explainer(X_test)
```

## Explanation Object

```python
# The Explanation object from explainer(X) contains:
shap_values = explainer(X_test)

shap_values.values        # ndarray: SHAP values, shape (n_samples, n_features)
shap_values.base_values   # ndarray: expected value (model mean prediction), shape (n_samples,)
shap_values.data          # ndarray: feature values for each sample
shap_values.feature_names # list of feature names (from DataFrame input)

# Single sample access
shap_values[0]            # Explanation for first sample
shap_values[0].values     # SHAP values for first sample

# Multi-output models
shap_values[:, :, 0]      # SHAP values for first output class
```

## Visualization: Bar Plot

```python
import matplotlib.pyplot as plt

# Global feature importance (mean |SHAP|)
shap.plots.bar(shap_values, max_display=15, show=False)
plt.tight_layout()
plt.savefig('shap_bar_global.png', dpi=150, bbox_inches='tight')
plt.close()

# Local feature importance (single prediction)
shap.plots.bar(shap_values[0], max_display=10, show=False)
plt.tight_layout()
plt.savefig('shap_bar_local.png', dpi=150, bbox_inches='tight')
plt.close()
```

## Visualization: Beeswarm Plot

```python
# Overview: SHAP value distribution per feature, colored by feature value
shap.plots.beeswarm(shap_values, max_display=15, show=False)
plt.tight_layout()
plt.savefig('shap_beeswarm.png', dpi=150, bbox_inches='tight')
plt.close()
```

## Visualization: Waterfall Plot

```python
# Single prediction explanation: base value -> feature contributions -> final prediction
shap.plots.waterfall(shap_values[0], max_display=15, show=False)
plt.title('Feature Contributions')
plt.tight_layout()
plt.savefig('shap_waterfall.png', dpi=150, bbox_inches='tight')
plt.close()
```

## Visualization: Dependence Plot

```python
# Feature effect: SHAP value vs feature value, colored by interaction feature
shap.plots.scatter(shap_values[:, 'feature_name'], color=shap_values, show=False)
plt.tight_layout()
plt.savefig('shap_dependence.png', dpi=150, bbox_inches='tight')
plt.close()

# Legacy API (also works)
shap.dependence_plot('feature_name', shap_values.values, X_test, show=False)
plt.tight_layout()
plt.savefig('shap_dep_legacy.png', dpi=150, bbox_inches='tight')
plt.close()
```

## Visualization: Force Plot

```python
# Single prediction force plot (matplotlib mode for non-notebook)
shap.plots.force(shap_values[0], matplotlib=True, show=False, figsize=(16, 3))
plt.tight_layout()
plt.savefig('shap_force.png', dpi=150, bbox_inches='tight')
plt.close()

# Legacy API
shap.force_plot(
    explainer.expected_value,
    shap_values.values[0],
    X_test.iloc[0],
    matplotlib=True, show=False
)
```

## Visualization: Summary Plot (Legacy)

```python
# Legacy summary_plot (equivalent to beeswarm + bar)
shap.summary_plot(shap_values.values, X_test, plot_type='dot', show=False)   # beeswarm
plt.tight_layout()
plt.savefig('shap_summary_dot.png', dpi=150, bbox_inches='tight')
plt.close()

shap.summary_plot(shap_values.values, X_test, plot_type='bar', show=False)   # bar
plt.tight_layout()
plt.savefig('shap_summary_bar.png', dpi=150, bbox_inches='tight')
plt.close()
```

## SHAP Interaction Values

```python
# Only for TreeExplainer
explainer = shap.TreeExplainer(model)
interaction_values = explainer.shap_interaction_values(X_test[:200])
# shape: (n_samples, n_features, n_features)
# Diagonal: main effects; off-diagonal: pairwise interactions
```

## Complete Workflow Example

```python
import shap
import xgboost
import matplotlib.pyplot as plt
import pandas as pd

# Train model
model = xgboost.XGBClassifier(n_estimators=200, max_depth=5, random_state=42)
model.fit(X_train, y_train)

# Compute SHAP values
explainer = shap.TreeExplainer(model)
shap_values = explainer(X_test)

# Global importance bar
shap.plots.bar(shap_values, max_display=15, show=False)
plt.tight_layout()
plt.savefig('global_importance.png', dpi=150, bbox_inches='tight')
plt.close()

# Beeswarm overview
shap.plots.beeswarm(shap_values, max_display=15, show=False)
plt.tight_layout()
plt.savefig('beeswarm.png', dpi=150, bbox_inches='tight')
plt.close()

# Top sample explanation
shap.plots.waterfall(shap_values[0], max_display=10, show=False)
plt.tight_layout()
plt.savefig('waterfall_sample0.png', dpi=150, bbox_inches='tight')
plt.close()
```

## Gotchas

- Always pass `show=False` and use `plt.savefig()` / `plt.close()` in non-interactive (script/sandbox) contexts.
- `TreeExplainer` is orders of magnitude faster than `KernelExplainer` for tree models -- always prefer it.
- Pass pandas DataFrames (not numpy arrays) to preserve feature names in plots.
- `KernelExplainer.shap_values()` returns raw ndarray, not an Explanation object -- use `shap.summary_plot(values, X)` legacy API.
- For binary classification, `TreeExplainer` may return values for both classes. Check `shap_values.shape` and index `[:, :, 1]` for positive class if needed.
- `expected_value` / `base_values` is the mean model output on the background data.
- Large datasets: subsample X for explainer background (`X_train[:500]`) and for SHAP computation to manage memory.
- `dependence_plot` auto-selects the interaction feature for coloring; pass `interaction_index` to override.
