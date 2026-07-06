#!/usr/bin/env python3
"""Smoke test for the Python `pymzml` package.

Fully self-contained: no input files, no network, no packages beyond pymzml.
Exercises the core API surface and exits 0 only if every check passes, so it
can be used as a pass/fail library validator:

    python3 pymzml.py

Install: pip install pymzml   (import name: pymzml)

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
    import pymzml
except ImportError:
    print("FAIL: package 'pymzml' is not installed")
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


print(f"pymzml version: {_version(pymzml, 'pymzml')}")

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


# NOTE: pymzml is an mzML reader — its real work needs an mzML file, and
# synthesizing a valid mzML in a tempfile is brittle. This validator stays
# MODEST: it confirms the package imports and exposes its reader/spectrum
# classes. FLAG: no real spectrum file is parsed.
def test_submodules_import():
    import pymzml.run
    import pymzml.spec

    assert pymzml.run is not None
    assert pymzml.spec is not None


def test_reader_class_present():
    from pymzml.run import Reader

    assert isinstance(Reader, type)  # the mzML file reader class


def test_spectrum_class_present():
    from pymzml.spec import Spectrum

    assert isinstance(Spectrum, type)  # the per-spectrum wrapper class


run_test("run/spec submodules import", test_submodules_import)
run_test("run.Reader class present", test_reader_class_present)
run_test("spec.Spectrum class present", test_spectrum_class_present)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all pymzml smoke tests passed")
