#!/usr/bin/env python3
"""Smoke test for the Python `decoupler` package.

Fully self-contained: no input files, no network, no packages beyond decoupler
(and its implied deps — anndata, numpy, pandas, scipy). Exercises the core API
surface and exits 0 only if every check passes, so it can be used as a pass/fail
library validator:

    python3 decoupler.py

Install: pip install "decoupler[full]>=2.1.2"   (import name: decoupler)

FLAG — 1.x vs 2.x API split (this is the big one). decoupler 2.x RENAMED the
public surface:
  * 1.x: `dc.run_ulm(mat, net, source=..., target=..., weight=...)`, and the
    activities land in `mat.obsm['ulm_estimate']` (or a returned estimate/pvals
    tuple for a DataFrame input).
  * 2.x: methods live under `dc.mt.*` (e.g. `dc.mt.ulm(data, net)`), the net
    columns are the fixed names `source`/`target`/`weight`, and for an AnnData
    the scores land in `adata.obsm['score_ulm']` (p-values in `padj_ulm`).
Because the install note pins >=2.1.2, the body below targets the 2.x API.

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
    import decoupler as dc
except ImportError:
    print("FAIL: package 'decoupler' is not installed")
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


print(f"decoupler version: {_version(dc, 'decoupler')}")

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


def _make_data_and_net():
    """A 5-sample x 20-gene AnnData plus a 3-source regulatory net.

    Sources s0/s1/s2 each regulate a disjoint block of genes with unit weights —
    a toy but structurally valid `net` (columns source/target/weight).
    """
    rng = np.random.default_rng(0)
    genes = [f"g{j}" for j in range(20)]
    samples = [f"s{i}" for i in range(5)]
    mat = pd.DataFrame(
        rng.normal(size=(5, 20)), index=samples, columns=genes
    )
    adata = ad.AnnData(mat)

    rows = []
    for src, block in {"s0": genes[0:6], "s1": genes[6:12], "s2": genes[12:20]}.items():
        for g in block:
            rows.append({"source": src, "target": g, "weight": 1.0})
    net = pd.DataFrame(rows, columns=["source", "target", "weight"])
    return adata, net


def test_net_shape_and_columns():
    _, net = _make_data_and_net()
    assert list(net.columns) == ["source", "target", "weight"]
    assert set(net["source"].unique()) == {"s0", "s1", "s2"}
    assert len(net) == 20


def test_ulm_activities_shape():
    # 2.x API: dc.mt.ulm mutates the AnnData in place, writing per-source scores
    # into adata.obsm['score_ulm'] with shape (n_samples, n_sources).
    adata, net = _make_data_and_net()
    dc.mt.ulm(data=adata, net=net, tmin=3)
    scores = adata.obsm["score_ulm"]
    assert scores.shape == (5, 3)
    assert list(scores.columns) == ["s0", "s1", "s2"]
    assert np.isfinite(scores.to_numpy()).all()


run_test("net DataFrame shape/columns (source/target/weight)", test_net_shape_and_columns)
run_test("dc.mt.ulm activities shape (2.x API)", test_ulm_activities_shape)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all decoupler smoke tests passed")
