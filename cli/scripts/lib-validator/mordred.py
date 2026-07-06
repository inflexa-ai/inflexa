#!/usr/bin/env python3
"""Smoke test for the Python `mordred` package.

Fully self-contained: no input files, no network, no packages beyond mordred
and its implied deps (rdkit, numpy). Exercises the core API surface and exits 0
only if every check passes, so it can be used as a pass/fail library validator:

    python3 mordred.py

Install: pip install mordred   (import name: mordred)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.

MODEST + FLAG: mordred is a molecular-descriptor calculator that runs ON TOP of
RDKit — it needs rdkit installed and an rdkit Mol as input. It computes a large
descriptor block (1000+ 2D/3D descriptors); the check below builds the 2D
calculator (ignore_3D=True), runs it on ethanol, and asserts one well-known
descriptor (molecular weight) is finite. NOTE: mordred is unmaintained and its
Python 3.14 compatibility is uncertain (it historically pins older numpy and
uses `networkx` internals); if import fails on a modern interpreter that is a
known risk, not a defect in this validator.
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import mordred
    from mordred import Calculator, descriptors
except ImportError:
    print("FAIL: package 'mordred' is not installed")
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


print(f"mordred version: {_version(mordred, 'mordred')}")

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


def test_calculator_builds_large_descriptor_set():
    calc = Calculator(descriptors, ignore_3D=True)
    # The 2D descriptor block is large — hundreds of registered descriptors.
    assert len(calc.descriptors) > 100


def test_calc_ethanol_molecular_weight_finite():
    import math
    from rdkit import Chem

    calc = Calculator(descriptors, ignore_3D=True)
    mol = Chem.MolFromSmiles("CCO")
    assert mol is not None
    result = calc(mol)
    # The Result maps descriptor -> value; molecular weight lives under "MW".
    values = result.asdict()
    assert "MW" in values
    mw = float(values["MW"])
    assert math.isfinite(mw)
    # Ethanol MW ≈ 46.07 (mordred's MW is the full monoisotopic-ish mass; use a
    # loose tolerance since the exact definition differs slightly from rdkit's).
    assert 40.0 < mw < 52.0


run_test("Calculator builds large descriptor set", test_calculator_builds_large_descriptor_set)
run_test("calc(ethanol) MW is finite", test_calc_ethanol_molecular_weight_finite)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all mordred smoke tests passed")
