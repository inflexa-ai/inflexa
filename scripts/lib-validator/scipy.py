#!/usr/bin/env python3
"""Smoke test for the Python `scipy` package.

Fully self-contained: no input files, no network, no packages beyond scipy
(and its implied deps: numpy). Exercises the core API surface and exits 0 only
if every check passes, so it can be used as a pass/fail library validator:

    python3 scipy.py

Install: pip install scipy   (import name: scipy)

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
    import scipy
except ImportError:
    print("FAIL: package 'scipy' is not installed")
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


print(f"scipy version: {_version(scipy, 'scipy')}")

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


def test_linalg_solve_and_det():
    import numpy as np
    from scipy import linalg

    A = np.array([[3.0, 2.0], [1.0, 2.0]])
    b = np.array([5.0, 5.0])
    x = linalg.solve(A, b)
    assert np.allclose(A @ x, b)
    assert abs(linalg.det(A) - 4.0) < 1e-9


def test_stats_ttest_ind():
    import numpy as np
    from scipy import stats

    rng = np.random.default_rng(0)
    a = rng.normal(0.0, 1.0, 50)
    b = rng.normal(0.5, 1.0, 50)
    res = stats.ttest_ind(a, b)
    assert np.isfinite(res.statistic)
    assert 0.0 <= res.pvalue <= 1.0


def test_stats_norm_cdf():
    from scipy import stats

    assert abs(stats.norm.cdf(0.0) - 0.5) < 1e-12


def test_sparse_csr_roundtrip():
    import numpy as np
    from scipy import sparse

    dense = np.array([[1, 0, 2], [0, 3, 0], [4, 0, 5]])
    m = sparse.csr_matrix(dense)
    assert m.shape == (3, 3)
    assert m.nnz == 5
    assert np.array_equal(m.toarray(), dense)


def test_optimize_minimize_quadratic():
    import numpy as np
    from scipy import optimize

    # Known minimum of (x-3)^2 + (y+1)^2 is at (3, -1).
    res = optimize.minimize(lambda v: (v[0] - 3.0) ** 2 + (v[1] + 1.0) ** 2, [0.0, 0.0])
    assert res.success
    assert np.allclose(res.x, [3.0, -1.0], atol=1e-4)


run_test("linalg solve + det", test_linalg_solve_and_det)
run_test("stats ttest_ind on seeded samples", test_stats_ttest_ind)
run_test("stats norm.cdf(0) == 0.5", test_stats_norm_cdf)
run_test("sparse csr_matrix roundtrip", test_sparse_csr_roundtrip)
run_test("optimize.minimize quadratic", test_optimize_minimize_quadratic)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all scipy smoke tests passed")
