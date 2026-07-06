#!/usr/bin/env python3
"""Smoke test for the Python `pytometry` package.

Fully self-contained: no input files, no network, no packages beyond pytometry
(and its implied deps: anndata, scanpy, numpy). Exercises the core API surface
and exits 0 only if every check passes, so it can be used as a pass/fail
library validator:

    python3 pytometry.py

Install: pip install pytometry   (import name: pytometry)

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
    import pytometry as pm
except ImportError:
    print("FAIL: package 'pytometry' is not installed")
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


print(f"pytometry version: {_version(pm, 'pytometry')}")

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


# NOTE: pytometry is a flow/mass-cytometry toolkit layered on AnnData. This
# validator builds a tiny SYNTHETIC AnnData of marker intensities (no files, no
# network) and exercises a tl transform. FLAG: real use needs anndata; kept
# MODEST (surface + one transform).
def test_submodules_present():
    # pytometry mirrors scanpy's pp / tl / pl namespace layout.
    for sub in ("pp", "tl", "pl"):
        assert hasattr(pm, sub), f"pytometry.{sub} missing"


def test_pp_surface_present():
    # Preprocessing entrypoints (compensation / signal splitting).
    assert hasattr(pm.pp, "split_signal") or hasattr(pm.pp, "compensate")


def test_tl_arcsinh_transform_changes_values():
    import numpy as np
    import anndata as ad

    rng = np.random.default_rng(0)
    # 20 cells x 5 markers of raw positive intensities.
    x = (rng.random((20, 5)) * 1000.0).astype("float32")
    adata = ad.AnnData(X=x.copy())
    adata.var_names = [f"marker{i}" for i in range(5)]

    before = adata.X.copy()
    # arcsinh normalization is the canonical cytometry variance stabilizer.
    result = pm.tl.normalize_arcsinh(adata, cofactor=5)
    # pytometry tools may transform in place (return None) or return a copy.
    out = result if result is not None else adata
    assert out.shape == (20, 5)  # shape preserved
    assert not np.allclose(out.X, before)  # arcsinh actually transformed values


run_test("scanpy-style submodules present", test_submodules_present)
run_test("pp preprocessing surface present", test_pp_surface_present)
run_test("tl arcsinh transform changes values", test_tl_arcsinh_transform_changes_values)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all pytometry smoke tests passed")
