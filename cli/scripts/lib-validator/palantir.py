#!/usr/bin/env python3
"""Smoke test for the Python `palantir` package.

Fully self-contained: no input files, no network. Exercises the core API
surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 palantir.py

Install: pip install palantir   (import name: palantir)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.

MODEST + FLAGGED: Palantir is a heavy trajectory/pseudotime stack (scanpy,
anndata). Running a real trajectory needs a preprocessed AnnData and diffusion
maps, so this only asserts the package imports and exposes its documented entry
points — it does NOT run Palantir. (correct-by-review.)
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import palantir
except ImportError:
    print("FAIL: package 'palantir' is not installed")
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


print(f"palantir version: {_version(palantir, 'palantir')}")

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


def test_import_exposes_submodules():
    import importlib

    # utils/core are the workhorse submodules; import lazily so a missing one
    # is a test failure, not a top-level crash.
    assert importlib.import_module("palantir.utils") is not None
    assert importlib.import_module("palantir.core") is not None


def test_exposes_run_palantir_entry_point():
    assert hasattr(palantir, "run_palantir")
    assert callable(palantir.run_palantir)


run_test("import exposes palantir.utils / palantir.core", test_import_exposes_submodules)
run_test("exposes run_palantir entry point", test_exposes_run_palantir_entry_point)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all palantir smoke tests passed")
