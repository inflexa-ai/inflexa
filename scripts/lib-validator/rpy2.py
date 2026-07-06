#!/usr/bin/env python3
"""Smoke test for the Python `rpy2` package.

Fully self-contained: no input files, no network, no packages beyond rpy2.
Needs a working R installation on PATH (rpy2 embeds the R interpreter), but no
extra R packages beyond base R. Exercises the core API surface and exits 0 only
if every check passes, so it can be used as a pass/fail library validator:

    python3 rpy2.py

Install: pip install rpy2   (import name: rpy2)

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
    import rpy2
except ImportError:
    print("FAIL: package 'rpy2' is not installed")
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


print(f"rpy2 version: {_version(rpy2, 'rpy2')}")

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


def test_eval_arithmetic():
    from rpy2.robjects import r

    # r() evaluates R code and returns an R vector; [0] pulls the first element.
    assert r("1 + 1")[0] == 2
    assert abs(r("sqrt(2)")[0] - 2**0.5) < 1e-9


def test_python_list_to_r_vector_and_back():
    from rpy2.robjects import FloatVector

    vec = FloatVector([1.0, 2.0, 3.0, 4.0])
    assert len(vec) == 4
    # Round-trip the values back into a Python list.
    assert list(vec) == [1.0, 2.0, 3.0, 4.0]


def test_call_r_function():
    from rpy2.robjects import FloatVector, r

    r_sum = r["sum"]
    total = r_sum(FloatVector([1.0, 2.0, 3.0, 4.0]))
    assert total[0] == 10.0
    r_mean = r["mean"]
    assert r_mean(FloatVector([2.0, 4.0, 6.0]))[0] == 4.0


run_test("evaluate R arithmetic", test_eval_arithmetic)
run_test("python list -> R vector -> back", test_python_list_to_r_vector_and_back)
run_test("call an R function", test_call_r_function)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all rpy2 smoke tests passed")
