#!/usr/bin/env python3
"""Smoke test for the Python `datamol` package.

Fully self-contained: no input files, no network, no packages beyond datamol
and its implied deps (rdkit, numpy, pandas). Exercises the core API surface and
exits 0 only if every check passes, so it can be used as a pass/fail library
validator:

    python3 datamol.py

Install: pip install datamol   (import name: datamol)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.

MODEST + FLAG: datamol is a thin, ergonomic wrapper over RDKit — it cannot
function without rdkit installed, and most of its surface delegates straight to
`rdkit.Chem`. The checks below stick to datamol's own top-level convenience API
(to_mol / to_smiles / sanitize_mol / descriptors) on a trivial molecule.
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import datamol
except ImportError:
    print("FAIL: package 'datamol' is not installed")
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


print(f"datamol version: {_version(datamol, 'datamol')}")

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


def test_to_mol_and_smiles_roundtrip():
    mol = datamol.to_mol("CCO")
    assert mol is not None
    # Ethanol: three heavy atoms.
    assert mol.GetNumAtoms() == 3
    smi = datamol.to_smiles(mol)
    assert isinstance(smi, str)
    # Round-tripping the canonical SMILES yields the same molecule.
    assert datamol.to_smiles(datamol.to_mol(smi)) == smi


def test_sanitize_mol():
    mol = datamol.to_mol("CCO", sanitize=False)
    sane = datamol.sanitize_mol(mol)
    assert sane is not None
    assert sane.GetNumAtoms() == 3


def test_descriptors():
    mol = datamol.to_mol("CCO")
    desc = datamol.descriptors.compute_many_descriptors(mol)
    assert isinstance(desc, dict)
    # Molecular weight of ethanol ≈ 46.07; datamol exposes it as "mw".
    assert "mw" in desc
    assert abs(float(desc["mw"]) - 46.07) < 0.1


run_test("to_mol + to_smiles roundtrip", test_to_mol_and_smiles_roundtrip)
run_test("sanitize_mol", test_sanitize_mol)
run_test("descriptors (ethanol mw ~46.07)", test_descriptors)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all datamol smoke tests passed")
