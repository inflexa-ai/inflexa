#!/usr/bin/env python3
"""Smoke test for the Python `formulaic` package.

Fully self-contained: no input files, no network, no packages beyond formulaic
and its implied deps (numpy, pandas). Exercises the core API surface and exits
0 only if every check passes, so it can be used as a pass/fail library
validator:

    python3 formulaic.py

Install: pip install formulaic   (import name: formulaic)

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
    import formulaic
except ImportError:
    print("FAIL: package 'formulaic' is not installed")
    sys.exit(1)

import pandas as pd


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


print(f"formulaic version: {_version(formulaic, 'formulaic')}")

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


def test_two_sided_model_matrix():
    from formulaic import model_matrix

    df = pd.DataFrame(
        {
            "y": [1.0, 2.0, 3.0, 4.0],
            "x1": [0.0, 1.0, 2.0, 3.0],
            "x2": [1.0, 0.0, 1.0, 0.0],
        }
    )
    # A two-sided formula yields a structured result with .lhs / .rhs.
    mm = model_matrix("y ~ x1 + x2", df)
    y = mm.lhs
    X = mm.rhs
    # RHS carries an implicit intercept plus the two named terms.
    assert list(X.columns) == ["Intercept", "x1", "x2"]
    assert (X["Intercept"] == 1.0).all()
    assert X.shape == (4, 3)
    assert list(y.columns) == ["y"]
    assert y.shape == (4, 1)
    # formulaic attaches the derivation spec to every produced matrix.
    assert hasattr(X, "model_spec")


def test_categorical_expansion():
    from formulaic import model_matrix

    df = pd.DataFrame(
        {
            "y": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
            "g": ["a", "b", "c", "a", "b", "c"],
        }
    )
    X = model_matrix("y ~ g", df).rhs
    # Treatment coding drops the reference level "a"; b and c get contrast cols.
    assert "Intercept" in X.columns
    assert "g[T.b]" in X.columns
    assert "g[T.c]" in X.columns
    assert "g[T.a]" not in X.columns
    assert X.shape == (6, 3)


def test_model_matrix_type_surface():
    from formulaic import ModelMatrix, model_matrix

    # The library exposes the ModelMatrix type as its public structure.
    assert ModelMatrix is not None
    df = pd.DataFrame({"z": [1.0, 2.0, 3.0]})
    # A one-sided formula yields a single design matrix (intercept + z).
    X = model_matrix("~ z", df)
    assert list(X.columns) == ["Intercept", "z"]
    assert X.shape == (3, 2)


run_test("two-sided model_matrix lhs/rhs", test_two_sided_model_matrix)
run_test("categorical treatment expansion", test_categorical_expansion)
run_test("ModelMatrix type + one-sided", test_model_matrix_type_surface)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all formulaic smoke tests passed")
