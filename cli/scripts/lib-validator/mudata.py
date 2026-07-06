#!/usr/bin/env python3
"""Smoke test for the Python `mudata` package.

Fully self-contained: no input files, no network, no packages beyond mudata
(and its implied deps — anndata, numpy, pandas, h5py). Exercises the core API
surface and exits 0 only if every check passes, so it can be used as a pass/fail
library validator:

    python3 mudata.py

Install: pip install mudata   (import name: mudata)

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
    import mudata as md
except ImportError:
    print("FAIL: package 'mudata' is not installed")
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


print(f"mudata version: {_version(md, 'mudata')}")

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
    """Two modalities (rna 50x20, atac 50x30) over a shared 50-cell axis."""
    rng = np.random.default_rng(0)
    obs_names = [f"cell{i}" for i in range(50)]
    rna = ad.AnnData(
        X=rng.poisson(5, (50, 20)).astype(float),
        obs=pd.DataFrame(index=obs_names),
        var=pd.DataFrame(index=[f"gene{j}" for j in range(20)]),
    )
    atac = ad.AnnData(
        X=rng.poisson(1, (50, 30)).astype(float),
        obs=pd.DataFrame(index=obs_names),
        var=pd.DataFrame(index=[f"peak{j}" for j in range(30)]),
    )
    return md.MuData({"rna": rna, "atac": atac})


def test_construct_mods_and_shape():
    mdata = _make_mudata()
    assert set(mdata.mod.keys()) == {"rna", "atac"}
    # Cells shared across modalities; features are the union of both var axes.
    assert mdata.n_obs == 50
    assert mdata.shape == (50, 50)
    assert mdata["rna"].shape == (50, 20)
    assert mdata["atac"].shape == (50, 30)


def test_cross_modality_obs():
    mdata = _make_mudata()
    mdata.obs["batch"] = ["b0" if i % 2 == 0 else "b1" for i in range(50)]
    assert list(mdata.obs["batch"][:4]) == ["b0", "b1", "b0", "b1"]
    assert mdata["rna"].n_obs == mdata["atac"].n_obs == 50


def test_h5mu_write_read_roundtrip():
    import tempfile

    mdata = _make_mudata()
    fd, path = tempfile.mkstemp(suffix=".h5mu")
    os.close(fd)
    try:
        mdata.write(path)
        back = md.read(path)
        assert set(back.mod.keys()) == {"rna", "atac"}
        assert back.n_obs == 50
        assert np.allclose(back["rna"].X, mdata["rna"].X)
        assert np.allclose(back["atac"].X, mdata["atac"].X)
    finally:
        os.remove(path)


run_test("construct: mods + shape", test_construct_mods_and_shape)
run_test("cross-modality obs", test_cross_modality_obs)
run_test("h5mu tempfile write/read round-trip", test_h5mu_write_read_roundtrip)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all mudata smoke tests passed")
