#!/usr/bin/env python3
"""Smoke test for the Python `pyteomics` package.

Fully self-contained: no input files, no network, no packages beyond pyteomics.
Exercises the core API surface and exits 0 only if every check passes, so it
can be used as a pass/fail library validator:

    python3 pyteomics.py

Install: pip install pyteomics   (import name: pyteomics)

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
    import pyteomics
except ImportError:
    print("FAIL: package 'pyteomics' is not installed")
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


print(f"pyteomics version: {_version(pyteomics, 'pyteomics')}")

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


# pyteomics is pure-python and genuinely offline-testable: peptide masses and
# in-silico digestion are deterministic, so these checks assert known values.
def test_calculate_mass_peptide():
    import math
    from pyteomics import mass

    m = mass.calculate_mass(sequence="PEPTIDE")
    assert math.isfinite(m)
    # Monoisotopic neutral mass of PEPTIDE is ~799.36 Da.
    assert abs(m - 799.35994) < 0.02


def test_fast_mass_matches_calculate_mass():
    import math
    from pyteomics import mass

    fm = mass.fast_mass("PEPTIDE")
    assert math.isfinite(fm)
    assert abs(fm - 799.35994) < 0.02
    # fast_mass is the optimized path; it must agree with calculate_mass.
    assert abs(fm - mass.calculate_mass(sequence="PEPTIDE")) < 1e-3


def test_cleave_trypsin_single():
    from pyteomics import parser

    peptides = parser.cleave("PEPTIDEK", "trypsin")
    assert isinstance(peptides, set)
    # A single K-terminated peptide yields exactly itself.
    assert "PEPTIDEK" in peptides


def test_cleave_trypsin_multiple():
    from pyteomics import parser

    # Trypsin cuts after K and after R -> two fully-digested peptides.
    peptides = parser.cleave("AAKCCR", "trypsin")
    assert peptides == {"AAK", "CCR"}


run_test("mass.calculate_mass(PEPTIDE)", test_calculate_mass_peptide)
run_test("mass.fast_mass matches calculate_mass", test_fast_mass_matches_calculate_mass)
run_test("parser.cleave trypsin (single)", test_cleave_trypsin_single)
run_test("parser.cleave trypsin (multiple)", test_cleave_trypsin_multiple)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all pyteomics smoke tests passed")
