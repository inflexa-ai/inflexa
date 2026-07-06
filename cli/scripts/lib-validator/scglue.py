#!/usr/bin/env python3
"""Smoke test for the Python `scglue` package.

Fully self-contained: no input files, no network. Exercises the core API
surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 scglue.py

Install: pip install scglue   (import name: scglue)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.

MODEST + FLAGGED: scGLUE is graph-linked multi-omics integration (GLUE) built on
PyTorch. Training the GLUE model needs paired multi-omics AnnData plus a guidance
graph and is heavy, so this only asserts the package imports and exposes its
documented namespaces (models, data, genomics); it does NOT run GLUE.
(correct-by-review.)
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import scglue
except ImportError:
    print("FAIL: package 'scglue' is not installed")
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


print(f"scglue version: {_version(scglue, 'scglue')}")

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


def test_exposes_models_and_data():
    assert hasattr(scglue, "models")
    assert hasattr(scglue, "data")


def test_exposes_genomics():
    assert hasattr(scglue, "genomics")


run_test("exposes scglue.models / scglue.data", test_exposes_models_and_data)
run_test("exposes scglue.genomics", test_exposes_genomics)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all scglue smoke tests passed")
