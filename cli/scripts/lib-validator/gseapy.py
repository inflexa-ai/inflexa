#!/usr/bin/env python3
"""Smoke test for the Python `gseapy` package.

Fully self-contained: no input files, no network, no packages beyond gseapy
(and its implied deps — numpy, pandas, scipy). Exercises the core API surface
and exits 0 only if every check passes, so it can be used as a pass/fail library
validator:

    python3 gseapy.py

Install: pip install "gseapy>=1.1.11"   (import name: gseapy)

FLAG — no network. This test uses ONLY `gseapy.prerank` with an in-memory
`gene_sets` dict and an in-memory ranked pandas Series. `gseapy.enrichr` (and
any gene-set download) hits the network and is deliberately NOT exercised — the
validator must stay offline.

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
    import gseapy as gp
except ImportError:
    print("FAIL: package 'gseapy' is not installed")
    sys.exit(1)

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


print(f"gseapy version: {_version(gp, 'gseapy')}")

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


def _make_rank_and_sets():
    """A 200-gene ranked Series + two in-memory gene sets (no downloads).

    GENE0..GENE9 are pushed to the top of the ranking and form SET_TOP, so that
    set should enrich positively; SET_RANDOM is a scattered control.
    """
    rng = np.random.default_rng(0)
    genes = [f"GENE{i}" for i in range(200)]
    scores = rng.normal(size=200)
    scores[:10] += 5.0  # lift the SET_TOP members to the head of the ranking
    rnk = pd.Series(scores, index=genes).sort_values(ascending=False)

    gene_sets = {
        "SET_TOP": [f"GENE{i}" for i in range(10)],
        "SET_RANDOM": [f"GENE{i}" for i in range(50, 65)],
    }
    return rnk, gene_sets


def test_ranked_series_and_sets():
    rnk, gene_sets = _make_rank_and_sets()
    assert rnk.shape == (200,)
    assert rnk.is_monotonic_decreasing
    assert set(gene_sets.keys()) == {"SET_TOP", "SET_RANDOM"}
    assert len(gene_sets["SET_TOP"]) == 10


def test_prerank_res2d():
    # In-memory prerank: gene_sets is a dict, rnk is a Series — no network.
    rnk, gene_sets = _make_rank_and_sets()
    pre = gp.prerank(
        rnk=rnk,
        gene_sets=gene_sets,
        min_size=5,
        max_size=100,
        permutation_num=100,
        seed=0,
        no_plot=True,
        outdir=None,
    )
    res = pre.res2d
    assert isinstance(res, pd.DataFrame)
    assert len(res) >= 1
    for col in ("Term", "NES"):
        assert col in res.columns
    # A p-value column exists under one of gseapy's spellings across versions.
    assert any(c in res.columns for c in ("pval", "NOM p-val", "FDR q-val"))


run_test("ranked Series + in-memory gene sets", test_ranked_series_and_sets)
run_test("prerank res2d (offline, no enrichr)", test_prerank_res2d)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all gseapy smoke tests passed")
