#!/usr/bin/env python3
"""Smoke test for the Python `cellrank` package.

Fully self-contained: no input files, no network. Exercises the core API
surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 cellrank.py

Install: pip install "cellrank>=2"   (import name: cellrank)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.

MODEST + FLAGGED: CellRank is fate mapping on an AnnData. The v1 and v2 APIs
differ sharply (hence the >=2 pin), and a real run needs a preprocessed AnnData
with a transition kernel, so this only asserts the package imports and exposes
its documented v2 namespaces (kernels, estimators, tl); it does NOT run fate
mapping. (correct-by-review.)
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import cellrank
except ImportError:
    print("FAIL: package 'cellrank' is not installed")
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


print(f"cellrank version: {_version(cellrank, 'cellrank')}")

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


def test_exposes_v2_namespaces():
    # kernels + estimators are the CellRank v2 building blocks; their presence
    # confirms the >=2 API rather than the legacy v1 tl.* surface.
    assert hasattr(cellrank, "kernels")
    assert hasattr(cellrank, "estimators")


def test_exposes_tl_namespace():
    assert hasattr(cellrank, "tl")


run_test("exposes cellrank.kernels / cellrank.estimators", test_exposes_v2_namespaces)
run_test("exposes cellrank.tl", test_exposes_tl_namespace)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all cellrank smoke tests passed")
