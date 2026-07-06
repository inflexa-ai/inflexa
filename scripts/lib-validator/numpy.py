#!/usr/bin/env python3
"""Smoke test for the Python `numpy` package.

Fully self-contained: no input files, no network, no packages beyond numpy
(and its implied deps). Exercises the core API surface and exits 0 only if
every check passes, so it can be used as a pass/fail library validator:

    python3 numpy.py

Install: pip install numpy   (import name: numpy)

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
    import numpy as np
except ImportError:
    print("FAIL: package 'numpy' is not installed")
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


print(f"numpy version: {_version(np, 'numpy')}")

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


def test_array_creation_and_dtype():
    a = np.array([1, 2, 3], dtype=np.int64)
    assert a.shape == (3,)
    assert a.dtype == np.int64
    assert a.sum() == 6
    assert np.array_equal(a * 2, np.array([2, 4, 6]))


def test_arange_reshape():
    m = np.arange(12).reshape(3, 4)
    assert m.shape == (3, 4)
    assert m[2, 3] == 11
    assert np.array_equal(m.T.shape, (4, 3))
    assert np.array_equal(m.sum(axis=0), np.array([12, 15, 18, 21]))


def test_broadcasting():
    a = np.arange(3).reshape(3, 1)
    b = np.arange(4).reshape(1, 4)
    s = a + b
    assert s.shape == (3, 4)
    assert s[2, 3] == 5


def test_linalg_solve():
    A = np.array([[3.0, 2.0], [1.0, 2.0]])
    b = np.array([5.0, 5.0])
    x = np.linalg.solve(A, b)
    assert np.allclose(A @ x, b)
    assert np.isclose(np.linalg.det(A), 4.0)


def test_boolean_indexing_and_reductions():
    a = np.array([10, 20, 30, 40, 50])
    assert np.array_equal(a[a > 25], np.array([30, 40, 50]))
    assert np.isclose(a.mean(), 30.0)
    assert np.isclose(a.std(), np.sqrt(200.0))


def test_random_is_seeded_deterministic():
    rng = np.random.default_rng(0)
    x = rng.standard_normal(5)
    rng2 = np.random.default_rng(0)
    assert np.allclose(x, rng2.standard_normal(5))


run_test("array creation and dtype", test_array_creation_and_dtype)
run_test("arange/reshape/transpose", test_arange_reshape)
run_test("broadcasting", test_broadcasting)
run_test("linalg solve + det", test_linalg_solve)
run_test("boolean indexing and reductions", test_boolean_indexing_and_reductions)
run_test("seeded RNG is deterministic", test_random_is_seeded_deterministic)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all numpy smoke tests passed")
