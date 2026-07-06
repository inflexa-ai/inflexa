#!/usr/bin/env python3
"""Smoke test for the Python `liana` package.

Fully self-contained: no input files, no network. Exercises the core API
surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 liana.py

Install: pip install "liana[extras]"   (import name: liana)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.

MODEST + FLAGGED: liana is ligand-receptor / cell-cell communication. Running
rank_aggregate needs an AnnData with cell-type labels, and resource fetching
(the ligand-receptor database) may hit the network — NEITHER is done here.
This only asserts the package imports and exposes its documented method entry
points (mt.rank_aggregate, the method namespace); it does NOT run the full
method or fetch a resource. (correct-by-review.)
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import liana
except ImportError:
    print("FAIL: package 'liana' is not installed")
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


print(f"liana version: {_version(liana, 'liana')}")

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


def test_exposes_method_and_mt_namespaces():
    assert hasattr(liana, "mt")
    assert hasattr(liana, "method")


def test_exposes_rank_aggregate():
    # rank_aggregate is liana's consensus multi-method entry point.
    assert hasattr(liana.mt, "rank_aggregate")


run_test("exposes liana.mt / liana.method", test_exposes_method_and_mt_namespaces)
run_test("exposes mt.rank_aggregate", test_exposes_rank_aggregate)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all liana smoke tests passed")
