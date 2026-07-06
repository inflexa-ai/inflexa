#!/usr/bin/env python3
"""Smoke test for the Python `scvi-tools` package (import name: scvi).

Fully self-contained: no input files, no network, no packages beyond scvi-tools
(and its implied deps — anndata, torch, lightning, numpy). Exercises the core
API surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 scvi-tools.py

Install: pip install scvi-tools   (import name: scvi)

FLAG: heavy. scvi-tools pulls in PyTorch + Lightning and this smoke test trains
a model (1 epoch on tiny synthetic data). It is slow to import and CPU-bound to
run; keep the budget modest.

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
    import scvi
except ImportError:
    print("FAIL: package 'scvi-tools' is not installed")
    sys.exit(1)

import numpy as np


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


print(f"scvi-tools version: {_version(scvi, 'scvi-tools')}")

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


def test_synthetic_iid_is_anndata():
    adata = scvi.data.synthetic_iid()
    # synthetic_iid() yields a small labelled AnnData (counts in .X).
    assert adata.n_obs > 0 and adata.n_vars > 0
    assert adata.X is not None


def test_setup_and_train_and_latent():
    # FLAG: torch + training. One epoch on the tiny synthetic dataset keeps this
    # cheap; we assert only structure (latent shape), never convergence.
    scvi.settings.seed = 0
    adata = scvi.data.synthetic_iid()
    scvi.model.SCVI.setup_anndata(adata)
    model = scvi.model.SCVI(adata, n_latent=5)
    model.train(max_epochs=1)
    latent = model.get_latent_representation()
    assert latent.shape == (adata.n_obs, 5)
    assert np.isfinite(latent).all()


run_test("synthetic_iid returns AnnData", test_synthetic_iid_is_anndata)
run_test("setup + 1-epoch train + latent shape (torch)", test_setup_and_train_and_latent)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all scvi-tools smoke tests passed")
