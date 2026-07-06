#!/usr/bin/env python3
"""Smoke test for the Python `deepchem` package.

Fully self-contained: no input files, no network. deepchem is a large library
whose deep-learning models sit behind optional backends (jax / torch /
tensorflow); this validator deliberately touches only the backend-free surface
— featurizers (which need rdkit) and the in-memory dataset container — so it
can pass without any DL framework installed. Exits 0 only if every check
passes, so it can be used as a pass/fail library validator:

    python3 deepchem.py

Install: pip install "deepchem[jax]"   (import name: deepchem)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.

MODEST + FLAG (heavily): deepchem is huge and its model classes require one of
jax / pytorch / tensorflow — none of which this smoke test assumes. The
featurizer check below needs rdkit (deepchem's chem featurizers wrap it). We
therefore assert the top-level subpackages exist, run one lightweight
featurizer, and build a NumpyDataset — no model training, no backend import.
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import deepchem
except ImportError:
    print("FAIL: package 'deepchem' is not installed")
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


print(f"deepchem version: {_version(deepchem, 'deepchem')}")

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


def test_subpackages_present():
    # The three pillars of the API surface. Import lazily so a broken optional
    # backend in one doesn't mask the others.
    import deepchem.data as dcdata
    import deepchem.feat as dcfeat
    import deepchem.models as dcmodels  # noqa: F401 - existence check only

    assert hasattr(dcfeat, "CircularFingerprint")
    assert hasattr(dcdata, "NumpyDataset")


def test_circular_fingerprint_featurize():
    import numpy as np
    import deepchem.feat as dcfeat

    feat = dcfeat.CircularFingerprint(size=1024, radius=2)
    # Featurizing ethanol's SMILES yields a (n_mols, size) bit array (via rdkit).
    X = feat.featurize(["CCO"])
    X = np.asarray(X)
    assert X.shape[0] == 1
    # One featurized molecule with a non-trivial feature vector.
    assert X.shape[-1] == 1024
    assert np.isfinite(X).all()


def test_numpy_dataset_container():
    import numpy as np
    import deepchem.data as dcdata

    X = np.arange(12, dtype="float64").reshape(3, 4)
    y = np.array([0.0, 1.0, 0.0])
    ds = dcdata.NumpyDataset(X=X, y=y)
    assert ds.X.shape == (3, 4)
    assert ds.y.shape == (3,)
    assert len(ds) == 3
    assert np.allclose(ds.X, X)


run_test("data/feat/models subpackages present", test_subpackages_present)
run_test("CircularFingerprint featurize (needs rdkit)", test_circular_fingerprint_featurize)
run_test("NumpyDataset container", test_numpy_dataset_container)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all deepchem smoke tests passed")
