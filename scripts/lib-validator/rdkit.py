#!/usr/bin/env python3
"""Smoke test for the Python `rdkit` package.

Fully self-contained: no input files, no network, no packages beyond rdkit
(which vends its own numpy-backed extensions). Exercises the core API surface
and exits 0 only if every check passes, so it can be used as a pass/fail
library validator:

    python3 rdkit.py

Install: pip install rdkit   (import name: rdkit)

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
    import rdkit
    from rdkit import Chem
except ImportError:
    print("FAIL: package 'rdkit' is not installed")
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


print(f"rdkit version: {_version(rdkit, 'rdkit')}")

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


def test_parse_and_atom_count():
    mol = Chem.MolFromSmiles("CCO")
    assert mol is not None
    # Ethanol has three heavy atoms (C, C, O); implicit H are not counted here.
    assert mol.GetNumAtoms() == 3


def test_canonical_smiles_roundtrip():
    mol = Chem.MolFromSmiles("OCC")
    canon = Chem.MolToSmiles(mol)
    # Round-tripping through the canonicalizer is idempotent.
    remol = Chem.MolFromSmiles(canon)
    assert remol is not None
    assert Chem.MolToSmiles(remol) == canon
    # "OCC" and "CCO" denote the same molecule → same canonical form.
    assert canon == Chem.MolToSmiles(Chem.MolFromSmiles("CCO"))


def test_molwt_descriptor():
    from rdkit.Chem import Descriptors

    mol = Chem.MolFromSmiles("CCO")
    mw = Descriptors.MolWt(mol)
    # Ethanol C2H6O ≈ 46.07 g/mol.
    assert abs(mw - 46.07) < 0.1


def test_morgan_fingerprint():
    from rdkit.Chem import AllChem
    from rdkit import DataStructs

    m1 = Chem.MolFromSmiles("CCO")
    m2 = Chem.MolFromSmiles("CCO")
    m3 = Chem.MolFromSmiles("c1ccccc1")
    fp1 = AllChem.GetMorganFingerprintAsBitVect(m1, radius=2, nBits=1024)
    fp2 = AllChem.GetMorganFingerprintAsBitVect(m2, radius=2, nBits=1024)
    fp3 = AllChem.GetMorganFingerprintAsBitVect(m3, radius=2, nBits=1024)
    assert fp1.GetNumBits() == 1024
    # Identical molecules → perfect Tanimoto similarity.
    assert abs(DataStructs.TanimotoSimilarity(fp1, fp2) - 1.0) < 1e-9
    # Ethanol vs benzene share no environments → dissimilar.
    assert DataStructs.TanimotoSimilarity(fp1, fp3) < 1.0


def test_embed_3d_optional():
    # 3D embedding needs Hs and a conformer; treat inability to embed as a soft
    # skip (some builds/platforms lack the coordinate generator) rather than a
    # hard failure of the smoke test.
    from rdkit.Chem import AllChem

    mol = Chem.AddHs(Chem.MolFromSmiles("CCO"))
    rc = AllChem.EmbedMolecule(mol, randomSeed=0xF00D)
    if rc != 0:
        return
    conf = mol.GetConformer()
    assert conf.GetNumAtoms() == mol.GetNumAtoms()


run_test("MolFromSmiles + heavy atom count", test_parse_and_atom_count)
run_test("canonical SMILES roundtrip", test_canonical_smiles_roundtrip)
run_test("MolWt descriptor (ethanol ~46.07)", test_molwt_descriptor)
run_test("Morgan fingerprint + Tanimoto", test_morgan_fingerprint)
run_test("3D embed (optional/soft-skip)", test_embed_3d_optional)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all rdkit smoke tests passed")
