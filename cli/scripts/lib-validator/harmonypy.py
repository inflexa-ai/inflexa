#!/usr/bin/env python3
"""Smoke test for the Python `harmonypy` package.

Fully self-contained: no input files, no network, no packages beyond harmonypy
(and its implied deps: numpy, pandas). Exercises the core API surface and exits
0 only if every check passes, so it can be used as a pass/fail library
validator:

    python3 harmonypy.py

Install: pip install harmonypy   (import name: harmonypy)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.

harmonypy is genuinely offline-shaped: batch integration runs entirely in
memory. run_harmony takes a cells-by-dims embedding, a metadata DataFrame, and
the batch column name(s) via vars_use; it returns a Harmony object whose
`.Z_corr` is the corrected embedding shaped (dims, cells). Checks are seeded and
structural / tolerance-based. (correct-by-review.)
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import harmonypy
except ImportError:
    print("FAIL: package 'harmonypy' is not installed")
    sys.exit(1)


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


print(f"harmonypy version: {_version(harmonypy, 'harmonypy')}")

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


def test_exposes_run_harmony():
    assert hasattr(harmonypy, "run_harmony")
    assert callable(harmonypy.run_harmony)


def test_run_harmony_corrects_embedding():
    import numpy as np
    import pandas as pd

    rng = np.random.default_rng(0)
    n_cells, n_dims = 60, 5
    # A PCA-like embedding with an injected per-batch offset, so there is a
    # batch effect for Harmony to remove.
    batch = np.array(["A", "B"] * (n_cells // 2))
    data_mat = rng.standard_normal((n_cells, n_dims))
    data_mat[batch == "B"] += 3.0
    meta_data = pd.DataFrame({"batch": batch})

    ho = harmonypy.run_harmony(data_mat, meta_data, vars_use=["batch"])

    # Z_corr is the corrected embedding, transposed to (dims, cells).
    assert ho.Z_corr.shape == (n_dims, n_cells)
    assert np.all(np.isfinite(np.asarray(ho.Z_corr)))


run_test("exposes run_harmony", test_exposes_run_harmony)
run_test("run_harmony returns Z_corr of shape (dims, cells)", test_run_harmony_corrects_embedding)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all harmonypy smoke tests passed")
