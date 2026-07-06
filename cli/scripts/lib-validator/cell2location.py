#!/usr/bin/env python3
"""Smoke test for the Python `cell2location` package.

Fully self-contained: no input files, no network. Exercises the core API
surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 cell2location.py

Install: pip install cell2location   (import name: cell2location)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.

MODEST + FLAGGED: cell2location maps cell types onto spatial transcriptomics via
a Bayesian model (scvi-tools / PyTorch / Pyro). Training is heavy and needs a
reference signature plus spatial AnnData, so this only asserts the package
imports and exposes its documented entry points (models, the Cell2location
model class, run_colocation); it does NOT train a model. (correct-by-review.)
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import cell2location
except ImportError:
    print("FAIL: package 'cell2location' is not installed")
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


print(f"cell2location version: {_version(cell2location, 'cell2location')}")

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


def test_exposes_models_namespace():
    assert hasattr(cell2location, "models")
    # Cell2location is the spatial mapping model class.
    assert hasattr(cell2location.models, "Cell2location")


def test_exposes_run_colocation():
    assert hasattr(cell2location, "run_colocation")


run_test("exposes cell2location.models.Cell2location", test_exposes_models_namespace)
run_test("exposes run_colocation", test_exposes_run_colocation)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all cell2location smoke tests passed")
