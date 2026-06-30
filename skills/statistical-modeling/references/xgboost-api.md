# XGBoost API Reference

## XGBClassifier (scikit-learn API)

```python
import xgboost as xgb

clf = xgb.XGBClassifier(
    n_estimators=200,
    max_depth=5,
    learning_rate=0.1,
    objective='binary:logistic',     # or 'multi:softprob' for multi-class
    eval_metric='logloss',           # or 'auc', 'mlogloss', 'error'
    tree_method='hist',              # histogram-based (fast, default)
    device='cpu',                    # 'cuda' for GPU
    subsample=0.8,
    colsample_bytree=0.8,
    reg_alpha=0.0,                   # L1 regularization
    reg_lambda=1.0,                  # L2 regularization
    early_stopping_rounds=20,        # stop if no improvement for N rounds
    random_state=42
)

# Fit with evaluation set for early stopping
clf.fit(
    X_train, y_train,
    eval_set=[(X_test, y_test)],
    verbose=False
)

print(f"Best iteration: {clf.best_iteration}")

y_pred = clf.predict(X_test)
y_proba = clf.predict_proba(X_test)[:, 1]
```

## XGBRegressor

```python
reg = xgb.XGBRegressor(
    n_estimators=200,
    max_depth=5,
    learning_rate=0.1,
    objective='reg:squarederror',    # or 'reg:absoluteerror', 'reg:squaredlogerror'
    tree_method='hist',
    early_stopping_rounds=20,
    random_state=42
)

reg.fit(X_train, y_train, eval_set=[(X_test, y_test)], verbose=False)
y_pred = reg.predict(X_test)
```

## XGBRFClassifier (Random Forest Mode)

```python
# XGBoost random forest: uses row/column subsampling per tree, 1 boosting round per tree
rf = xgb.XGBRFClassifier(
    n_estimators=100,
    max_depth=6,
    subsample=0.8,
    colsample_bynode=0.8,
    random_state=42
)
rf.fit(X_train, y_train)
```

## Feature Importance

```python
# Built-in importance (impurity/gain based)
importances = clf.feature_importances_      # ndarray, shape (n_features,)

# Plot importance
import matplotlib.pyplot as plt
xgb.plot_importance(clf, importance_type='gain', max_num_features=15)
plt.tight_layout()
plt.savefig('xgb_importance.png', dpi=150)
plt.close()

# importance_type options: 'weight' (split count), 'gain' (avg gain), 'cover' (avg coverage)
```

## DMatrix (Native API)

```python
import xgboost as xgb

dtrain = xgb.DMatrix(X_train, label=y_train)
dtest = xgb.DMatrix(X_test, label=y_test)

# With feature names
dtrain = xgb.DMatrix(X_train, label=y_train, feature_names=feature_names)

params = {
    'max_depth': 3,
    'eta': 0.1,
    'objective': 'binary:logistic',
    'eval_metric': ['logloss', 'auc'],
    'tree_method': 'hist',
    'device': 'cpu'
}

evals_result = {}
bst = xgb.train(
    params,
    dtrain,
    num_boost_round=200,
    evals=[(dtrain, 'train'), (dtest, 'eval')],
    early_stopping_rounds=20,
    evals_result=evals_result,
    verbose_eval=False
)

preds = bst.predict(dtest)
print(f"Best iteration: {bst.best_iteration}, Best AUC: {bst.best_score:.4f}")

# Native feature importance
importance = bst.get_score(importance_type='gain')   # dict: feature_name -> score
```

## GridSearchCV with XGBoost

```python
from sklearn.model_selection import GridSearchCV

param_grid = {
    'max_depth': [3, 5, 7],
    'learning_rate': [0.01, 0.1, 0.2],
    'n_estimators': [100, 200, 300],
    'subsample': [0.8, 1.0]
}

grid = GridSearchCV(
    xgb.XGBClassifier(tree_method='hist', random_state=42),
    param_grid, cv=5, scoring='roc_auc', n_jobs=-1, verbose=1
)
grid.fit(X_train, y_train)
print(f"Best params: {grid.best_params_}")
print(f"Best AUC: {grid.best_score_:.4f}")
```

## Hyperparameter Tuning with Optuna

```python
import optuna
import xgboost as xgb
from sklearn.model_selection import cross_val_score

def objective(trial):
    params = {
        'n_estimators': trial.suggest_int('n_estimators', 50, 500),
        'max_depth': trial.suggest_int('max_depth', 2, 10),
        'learning_rate': trial.suggest_float('learning_rate', 0.005, 0.3, log=True),
        'subsample': trial.suggest_float('subsample', 0.5, 1.0),
        'colsample_bytree': trial.suggest_float('colsample_bytree', 0.5, 1.0),
        'reg_alpha': trial.suggest_float('reg_alpha', 1e-8, 10.0, log=True),
        'reg_lambda': trial.suggest_float('reg_lambda', 1e-8, 10.0, log=True),
        'min_child_weight': trial.suggest_int('min_child_weight', 1, 10),
        'gamma': trial.suggest_float('gamma', 0.0, 5.0),
    }
    clf = xgb.XGBClassifier(
        **params, tree_method='hist', random_state=42, early_stopping_rounds=20
    )
    scores = cross_val_score(clf, X_train, y_train, cv=5, scoring='roc_auc')
    return scores.mean()

study = optuna.create_study(direction='maximize')
study.optimize(objective, n_trials=100, show_progress_bar=True)

print(f"Best AUC: {study.best_value:.4f}")
print(f"Best params: {study.best_params}")

# Retrain with best params
best_clf = xgb.XGBClassifier(**study.best_params, tree_method='hist', random_state=42)
best_clf.fit(X_train, y_train)
```

## Save / Load

```python
# scikit-learn API
clf.save_model('model.json')            # JSON (recommended, human-readable)
loaded = xgb.XGBClassifier()
loaded.load_model('model.json')

# Native API
bst.save_model('model.ubj')             # Universal Binary JSON (compact)
loaded_bst = xgb.Booster(model_file='model.ubj')
```

## Gotchas

- `early_stopping_rounds` requires `eval_set` in `.fit()`. Without it, the parameter is silently ignored.
- `use_label_encoder=False` is no longer needed in recent XGBoost versions (>= 1.6) -- the label encoder is removed.
- For multi-class, set `objective='multi:softprob'`. XGBoost auto-detects `num_class` from labels.
- `tree_method='hist'` is the default and recommended method (fast, memory-efficient).
- `device='cuda'` requires XGBoost built with GPU support. Falls back silently if unavailable -- check with `xgb.build_info()`.
- `feature_importances_` uses 'gain' by default in sklearn API. Use `xgb.plot_importance(model, importance_type='weight')` for split count.
- Cross-validation with early stopping requires manual fold splitting (sklearn's `cross_val_score` does not pass `eval_set` per fold).
- `predict_proba` returns shape `(n_samples, n_classes)`. For binary, positive-class probabilities are at index 1.
