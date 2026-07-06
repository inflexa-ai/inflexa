#!/usr/bin/env python3
"""Smoke test for the Python `celltypist` package.

Fully self-contained: no input files, no network. Exercises the core API
surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 celltypist.py

Install: pip install celltypist   (import name: celltypist)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.

MODEST + FLAGGED: celltypist.annotate needs a pretrained model, which is
DOWNLOADED over the network on first use — NOT done here. This only asserts the
package imports and exposes its documented entry points (Model, annotate,
train); it does NOT fetch a model or annotate anything. (correct-by-review.)
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import celltypist
except ImportError:
    print("FAIL: package 'celltypist' is not installed")
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


print(f"celltypist version: {_version(celltypist, 'celltypist')}")

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


def test_exposes_model_class():
    assert hasattr(celltypist, "Model")


def test_exposes_annotate_and_train():
    assert hasattr(celltypist, "annotate")
    assert callable(celltypist.annotate)
    assert hasattr(celltypist, "train")
    assert callable(celltypist.train)


run_test("exposes celltypist.Model", test_exposes_model_class)
run_test("exposes annotate / train entry points", test_exposes_annotate_and_train)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all celltypist smoke tests passed")
