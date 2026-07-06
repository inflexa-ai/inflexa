#!/usr/bin/env python3
"""Smoke test for the Python `optuna` package.

Fully self-contained: no input files, no network, no storage backend (the
default in-memory study), and no packages beyond optuna and its implied deps.
The sampler is seeded so the search is reproducible. Exits 0 only if every
check passes, so it can be used as a pass/fail library validator:

    python3 optuna.py

Install: pip install optuna   (import name: optuna)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import optuna
except ImportError:
    print("FAIL: package 'optuna' is not installed")
    sys.exit(1)

# Keep the per-trial INFO chatter out of the validator output.
optuna.logging.set_verbosity(optuna.logging.WARNING)


def _version(mod, dist):
    """Best-effort version string: module.__version__, else installed metadata."""
    v = getattr(mod, "__version__", None)
    if v:
        return v
    try:
        import importlib.metadata as m

        return m.version(dist)
    except Exception:
        return "unknown"


print(f"optuna version: {_version(optuna, 'optuna')}")

failures = 0


def run_test(name, fn):
    """Run one check; a raised exception is a failure, not a crash."""
    global failures
    try:
        fn()
    except Exception as e:  # noqa: BLE001 - any failure is a test failure
        failures += 1
        print(f"  FAIL {name}: {e}")
    else:
        print(f"  ok   {name}")


def test_minimization_converges():
    sampler = optuna.samplers.TPESampler(seed=0)
    study = optuna.create_study(direction="minimize", sampler=sampler)
    study.optimize(
        lambda t: (t.suggest_float("x", -10.0, 10.0) - 2.0) ** 2, n_trials=25
    )
    assert len(study.trials) == 25
    # (x-2)^2 bottoms out at 0 for x=2; a seeded TPE search should land near it.
    # Tolerances are generous: |x-2| < 2 keeps the check robust across versions.
    assert study.best_value < 2.0
    assert abs(study.best_params["x"] - 2.0) < 2.0


def test_study_records_trials_and_direction():
    study = optuna.create_study(
        direction="minimize", sampler=optuna.samplers.TPESampler(seed=1)
    )
    study.optimize(lambda t: abs(t.suggest_float("x", -5.0, 5.0)), n_trials=15)
    assert len(study.trials) == 15
    assert study.direction == optuna.study.StudyDirection.MINIMIZE
    # best_value is exactly the smallest objective across completed trials.
    values = [t.value for t in study.trials if t.value is not None]
    assert study.best_value == min(values)


run_test("minimization converges near x=2", test_minimization_converges)
run_test("study records trials + direction", test_study_records_trials_and_direction)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all optuna smoke tests passed")
