#!/usr/bin/env python3
"""Smoke test for the Python `conorm` package.

Fully self-contained: no input files, no network, no packages beyond conorm
(and its implied deps: numpy + pandas). Exercises the core API surface and exits
0 only if every check passes, so it can be used as a pass/fail library
validator:

    python3 conorm.py

Install: pip install conorm   (import name: conorm)

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
    import conorm
except ImportError:
    print("FAIL: package 'conorm' is not installed")
    sys.exit(1)

import numpy as np
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


print(f"conorm version: {_version(conorm, 'conorm')}")

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


def _counts():
    """A seeded genes x samples RNA-seq count matrix (rows=genes, cols=samples)."""
    rng = np.random.default_rng(0)
    data = rng.integers(1, 1000, size=(50, 4))
    return pd.DataFrame(
        data,
        index=[f"gene{i}" for i in range(50)],
        columns=["s1", "s2", "s3", "s4"],
    )


def test_cpm_columns_sum_to_million():
    counts = _counts()
    cpm = conorm.cpm(counts)
    assert isinstance(cpm, pd.DataFrame)
    assert cpm.shape == counts.shape
    # Counts-per-million: every sample (column) is scaled to sum to 1e6.
    assert np.allclose(cpm.sum(axis=0).values, 1e6, rtol=1e-6)


def test_tmm_preserves_shape():
    counts = _counts()
    tmm = conorm.tmm(counts)
    assert isinstance(tmm, pd.DataFrame)
    assert tmm.shape == counts.shape
    assert list(tmm.columns) == list(counts.columns)
    assert list(tmm.index) == list(counts.index)
    # Normalized counts stay finite and non-negative.
    assert np.isfinite(tmm.values).all()
    assert (tmm.values >= 0).all()


def test_tmm_norm_factors_center_on_one():
    counts = _counts()
    nf = conorm.tmm_norm_factors(counts)
    assert len(nf) == counts.shape[1]
    # TMM normalization factors are scaled to have a geometric mean of 1.
    assert np.isclose(np.exp(np.log(np.asarray(nf).ravel()).mean()), 1.0, rtol=1e-6)


run_test("cpm columns sum to 1e6", test_cpm_columns_sum_to_million)
run_test("tmm preserves shape/labels", test_tmm_preserves_shape)
run_test("tmm_norm_factors center on 1", test_tmm_norm_factors_center_on_one)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all conorm smoke tests passed")
