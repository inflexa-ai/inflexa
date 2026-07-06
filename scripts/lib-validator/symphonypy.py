#!/usr/bin/env python3
"""Smoke test for the Python `symphonypy` package.

Fully self-contained: no input files, no network. Exercises the core API
surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 symphonypy.py

Install: pip install symphonypy   (import name: symphonypy)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.

MODEST + FLAGGED: symphonypy is Symphony reference mapping on top of scanpy.
A real mapping needs a built reference AnnData plus a query, so this only
asserts the package imports and exposes its documented pp / tl namespaces
(e.g. tl.map_embedding); it does NOT run reference mapping. (correct-by-review.)
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import symphonypy
except ImportError:
    print("FAIL: package 'symphonypy' is not installed")
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


print(f"symphonypy version: {_version(symphonypy, 'symphonypy')}")

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


def test_exposes_pp_tl_namespaces():
    assert hasattr(symphonypy, "pp")
    assert hasattr(symphonypy, "tl")


def test_exposes_map_embedding():
    # map_embedding is Symphony's core query-onto-reference projection step.
    assert hasattr(symphonypy.tl, "map_embedding")
    assert callable(symphonypy.tl.map_embedding)


run_test("exposes symphonypy.pp / symphonypy.tl", test_exposes_pp_tl_namespaces)
run_test("exposes tl.map_embedding", test_exposes_map_embedding)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all symphonypy smoke tests passed")
