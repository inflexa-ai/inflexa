#!/usr/bin/env python3
"""Smoke test for the Python `snapatac2` package.

Fully self-contained: no input files, no network. Exercises the core API
surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 snapatac2.py

Install: pip install "snapatac2>=2.7"   (import name: snapatac2)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.

MODEST + FLAGGED: SnapATAC2 is single-cell ATAC-seq analysis (Rust-backed). The
bundled `snapatac2.datasets` fetch over the network (NOT used here) and the
spectral/UMAP steps are heavy, so this only asserts the package imports and
exposes its documented namespaces (pp, tl — e.g. tl.spectral); it does NOT run
the heavy embedding steps. (correct-by-review.)
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import snapatac2
except ImportError:
    print("FAIL: package 'snapatac2' is not installed")
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


print(f"snapatac2 version: {_version(snapatac2, 'snapatac2')}")

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
    assert hasattr(snapatac2, "pp")
    assert hasattr(snapatac2, "tl")


def test_exposes_spectral():
    # spectral embedding is SnapATAC2's dimensionality-reduction entry point.
    assert hasattr(snapatac2.tl, "spectral")


run_test("exposes snapatac2.pp / snapatac2.tl", test_exposes_pp_tl_namespaces)
run_test("exposes tl.spectral", test_exposes_spectral)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all snapatac2 smoke tests passed")
