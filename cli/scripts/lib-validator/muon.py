#!/usr/bin/env python3
"""Smoke test for the Python `muon` package.

Fully self-contained: no input files, no network, no packages beyond muon
(and its implied deps — mudata, anndata, scanpy, numpy). Exercises the core API
surface and exits 0 only if every check passes, so it can be used as a pass/fail
library validator:

    python3 muon.py

Install: pip install muon   (import name: muon)

FLAG: muon vs mudata API overlap. muon re-exports the `MuData` container from
the `mudata` package and layers multimodal *analysis* on top (`muon.pp`,
`muon.tl` — e.g. MOFA+, WNN). The container tests here overlap with mudata.py by
design; the analysis namespaces (mu.pp / mu.tl) are what muon adds.

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
    import muon as mu
except ImportError:
    print("FAIL: package 'muon' is not installed")
    sys.exit(1)

import anndata as ad
import numpy as np
import pandas as pd


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


print(f"muon version: {_version(mu, 'muon')}")

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


def _make_mudata():
    """Two modalities (rna 60x40, atac 60x25) over a shared 60-cell axis."""
    rng = np.random.default_rng(0)
    obs_names = [f"cell{i}" for i in range(60)]
    rna = ad.AnnData(
        X=rng.poisson(4, (60, 40)).astype(np.float32),
        obs=pd.DataFrame(index=obs_names),
        var=pd.DataFrame(index=[f"gene{j}" for j in range(40)]),
    )
    atac = ad.AnnData(
        X=rng.poisson(1, (60, 25)).astype(np.float32),
        obs=pd.DataFrame(index=obs_names),
        var=pd.DataFrame(index=[f"peak{j}" for j in range(25)]),
    )
    return mu.MuData({"rna": rna, "atac": atac})


def test_mudata_container():
    # FLAG: mu.MuData is the mudata container re-exported through muon.
    mdata = _make_mudata()
    assert set(mdata.mod.keys()) == {"rna", "atac"}
    assert mdata.n_obs == 60
    assert mdata["rna"].shape == (60, 40)
    assert mdata["atac"].shape == (60, 25)


def test_analysis_namespaces_present():
    # What muon adds over mudata: multimodal preprocessing / tools.
    assert hasattr(mu, "pp")
    assert hasattr(mu, "tl")
    assert callable(getattr(mu.pp, "intersect_obs", None)) or hasattr(mu.pp, "intersect_obs")


def test_intersect_obs_ops():
    mdata = _make_mudata()
    # Drop a cell from one modality, then align the shared obs axis.
    trimmed = mdata["rna"][: mdata.n_obs - 5].copy()
    mdata.mod["rna"] = trimmed
    mdata.update()
    mu.pp.intersect_obs(mdata)
    assert mdata["rna"].n_obs == mdata["atac"].n_obs
    assert mdata.n_obs == 55


run_test("MuData container (re-exported from mudata)", test_mudata_container)
run_test("mu.pp / mu.tl analysis namespaces present", test_analysis_namespaces_present)
run_test("mu.pp.intersect_obs aligns modalities", test_intersect_obs_ops)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all muon smoke tests passed")
