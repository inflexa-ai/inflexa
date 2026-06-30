# scikit-learn API Reference

## Pipeline Construction

```python
from sklearn.pipeline import Pipeline, make_pipeline
from sklearn.preprocessing import StandardScaler, MinMaxScaler
from sklearn.linear_model import LogisticRegression

# Explicit pipeline with named steps
pipe = Pipeline([
    ('scaler', StandardScaler()),
    ('clf', LogisticRegression(max_iter=1000))
])

# Shorthand (auto-generates step names)
pipe = make_pipeline(StandardScaler(), LogisticRegression(max_iter=1000))

pipe.fit(X_train, y_train)
score = pipe.score(X_test, y_test)
y_pred = pipe.predict(X_test)
```

## Scalers

```python
from sklearn.preprocessing import StandardScaler, MinMaxScaler

# StandardScaler: z-score normalization (mean=0, std=1)
scaler = StandardScaler()
X_scaled = scaler.fit_transform(X_train)      # fit + transform on train
X_test_scaled = scaler.transform(X_test)       # transform only on test

# MinMaxScaler: scale to [0, 1] range
minmax = MinMaxScaler(feature_range=(0, 1))
X_scaled = minmax.fit_transform(X_train)
```

## Common Estimators

```python
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
from sklearn.svm import SVR, SVC
from sklearn.neighbors import KNeighborsClassifier

# LogisticRegression
lr = LogisticRegression(C=1.0, penalty='l2', max_iter=1000, random_state=42)

# RandomForestClassifier
rf = RandomForestClassifier(
    n_estimators=100, max_depth=None, min_samples_split=2,
    min_samples_leaf=1, n_jobs=-1, random_state=42
)

# GradientBoostingClassifier
gb = GradientBoostingClassifier(
    n_estimators=100, learning_rate=0.1, max_depth=3, random_state=42
)

# SVR (Support Vector Regression)
svr = SVR(kernel='rbf', C=1.0, epsilon=0.1)

# KNeighborsClassifier
knn = KNeighborsClassifier(n_neighbors=5, weights='uniform', metric='minkowski')

# All follow: .fit(X, y), .predict(X), .score(X, y)
```

## Train/Test Split

```python
from sklearn.model_selection import train_test_split

X_train, X_test, y_train, y_test = train_test_split(
    X, y,
    test_size=0.2,       # 20% test
    stratify=y,          # preserve class proportions
    random_state=42
)
```

## Hyperparameter Search

```python
from sklearn.model_selection import GridSearchCV, RandomizedSearchCV
from scipy.stats import randint, uniform

# GridSearchCV: exhaustive search
param_grid = {
    'n_estimators': [50, 100, 200],
    'max_depth': [5, 10, None],
    'min_samples_split': [2, 5, 10]
}
grid = GridSearchCV(
    RandomForestClassifier(random_state=42),
    param_grid, cv=5, scoring='accuracy', n_jobs=-1
)
grid.fit(X_train, y_train)
print(grid.best_params_, grid.best_score_)
best_model = grid.best_estimator_

# RandomizedSearchCV: sampled search (faster for large spaces)
param_dist = {
    'n_estimators': randint(50, 300),
    'max_depth': [5, 10, 20, None],
    'min_samples_split': randint(2, 20)
}
random_search = RandomizedSearchCV(
    RandomForestClassifier(random_state=42),
    param_dist, n_iter=50, cv=5, scoring='accuracy', n_jobs=-1, random_state=42
)
random_search.fit(X_train, y_train)
```

## Cross-Validation

```python
from sklearn.model_selection import cross_val_score

scores = cross_val_score(
    LogisticRegression(max_iter=1000), X, y,
    cv=5, scoring='accuracy'       # also: 'f1', 'roc_auc', 'neg_mean_squared_error'
)
print(f"Mean: {scores.mean():.4f} +/- {scores.std():.4f}")
```

## Classification Metrics

```python
from sklearn.metrics import (
    classification_report, confusion_matrix, roc_auc_score,
    accuracy_score, f1_score, precision_score, recall_score
)

y_pred = model.predict(X_test)
y_proba = model.predict_proba(X_test)[:, 1]   # probabilities for positive class

# Classification report (precision, recall, f1 per class)
print(classification_report(y_test, y_pred, target_names=['class_0', 'class_1']))

# Confusion matrix
cm = confusion_matrix(y_test, y_pred)
tn, fp, fn, tp = cm.ravel()                   # binary only

# ROC AUC (requires probability scores)
auc = roc_auc_score(y_test, y_proba)

# Multi-class ROC AUC
y_proba_multi = model.predict_proba(X_test)
auc_multi = roc_auc_score(y_test, y_proba_multi, multi_class='ovr')
```

## Feature Importance

```python
from sklearn.inspection import permutation_importance

# Tree-based models: built-in impurity-based importance
rf.fit(X_train, y_train)
importances = rf.feature_importances_          # ndarray, shape (n_features,)

# Permutation importance (model-agnostic, preferred)
result = permutation_importance(
    rf, X_test, y_test,
    n_repeats=10, random_state=42, n_jobs=-1
)
# result.importances_mean   - mean importance per feature
# result.importances_std    - std across repeats
sorted_idx = result.importances_mean.argsort()[::-1]
for i in sorted_idx[:10]:
    print(f"{feature_names[i]}: {result.importances_mean[i]:.4f} +/- {result.importances_std[i]:.4f}")
```

## Complete Workflow Example

```python
import pandas as pd
from sklearn.model_selection import train_test_split, cross_val_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import classification_report, roc_auc_score
from sklearn.inspection import permutation_importance

# Prepare data
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, stratify=y, random_state=42
)

# Build pipeline
pipe = make_pipeline(
    StandardScaler(),
    GradientBoostingClassifier(n_estimators=200, learning_rate=0.1, max_depth=3, random_state=42)
)

# Cross-validate
cv_scores = cross_val_score(pipe, X_train, y_train, cv=5, scoring='roc_auc')
print(f"CV ROC AUC: {cv_scores.mean():.4f} +/- {cv_scores.std():.4f}")

# Fit and evaluate
pipe.fit(X_train, y_train)
y_pred = pipe.predict(X_test)
y_proba = pipe.predict_proba(X_test)[:, 1]

print(classification_report(y_test, y_pred))
print(f"Test ROC AUC: {roc_auc_score(y_test, y_proba):.4f}")

# Feature importance on the fitted estimator inside the pipeline
perm_imp = permutation_importance(pipe, X_test, y_test, n_repeats=10, random_state=42)
```

## Gotchas

- Always `fit_transform` on train, `transform` on test -- never fit on test data.
- `roc_auc_score` requires probability scores (`predict_proba`), not class labels.
- `feature_importances_` (impurity-based) can be biased toward high-cardinality features; prefer `permutation_importance`.
- Set `max_iter` on `LogisticRegression` (default 100 often insufficient).
- `n_jobs=-1` uses all CPU cores -- set explicitly in resource-constrained environments.
- `GridSearchCV` refits on full training set by default (`refit=True`); access via `.best_estimator_`.
