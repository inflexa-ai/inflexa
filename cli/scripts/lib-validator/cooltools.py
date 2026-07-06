#!/usr/bin/env python3
"""Smoke test for the Python `cooltools` package.

Fully self-contained: no input files, no network, no packages beyond cooltools
and its implied deps (cooler, numpy, pandas, scipy). Exercises the core API
surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 cooltools.py

Install: pip install cooltools   (import name: cooltools)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.

MODEST + FLAG: cooltools runs genome-scale analyses (expected, insulation,
compartment eigenvectors) on real `cooler` objects — a proper end-to-end run
needs a populated `.cool` with genome-wide coverage, which is heavier than a
smoke test should build. So this validator asserts the package imports and
that its headline analysis entry points are exposed and callable, WITHOUT
running them against a real matrix. The dependency on `cooler` is implicit;
if cooler is missing, cooltools import itself will fail.
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import cooltools
except ImportError:
    print("FAIL: package 'cooltools' is not installed")
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


print(f"cooltools version: {_version(cooltools, 'cooltools')}")

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


def test_analysis_entry_points_exposed():
    # The headline analyses. We assert they are present and callable, but do
    # NOT invoke them — each needs a real, genome-wide cooler to be meaningful.
    for attr in ("expected_cis", "insulation", "eigs_cis"):
        assert hasattr(cooltools, attr), f"cooltools.{attr} missing"
        assert callable(getattr(cooltools, attr)), f"cooltools.{attr} not callable"


def test_cooler_dependency_importable():
    # cooltools operates on cooler objects; its own import implies cooler is
    # present, but assert it explicitly so a broken dep surfaces clearly.
    import cooler

    assert hasattr(cooler, "Cooler")


run_test("analysis entry points exposed (not run)", test_analysis_entry_points_exposed)
run_test("cooler dependency importable", test_cooler_dependency_importable)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all cooltools smoke tests passed")
