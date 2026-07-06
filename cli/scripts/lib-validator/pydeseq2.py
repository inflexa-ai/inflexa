#!/usr/bin/env python3
"""Smoke test for the Python `pydeseq2` package.

Fully self-contained: no input files, no network, no packages beyond pydeseq2
(and its implied deps — numpy, pandas, scipy, anndata). Exercises the core API
surface and exits 0 only if every check passes, so it can be used as a pass/fail
library validator:

    python3 pydeseq2.py

Install: pip install "pydeseq2>=0.5.3"   (import name: pydeseq2)

FLAG — design/arg names. pydeseq2 0.5.x takes a formula string via
`design="~condition"` on DeseqDataSet; older releases used
`design_factors="condition"`. The install note pins >=0.5.3, so the body uses
the `design=` formula form. Results columns are log2FoldChange / pvalue / padj.

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
    import pydeseq2
except ImportError:
    print("FAIL: package 'pydeseq2' is not installed")
    sys.exit(1)

import numpy as np
import pandas as pd
from pydeseq2.dds import DeseqDataSet
from pydeseq2.ds import DeseqStats


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


print(f"pydeseq2 version: {_version(pydeseq2, 'pydeseq2')}")

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


def _make_counts_and_metadata():
    """20 samples x 30 genes of negative-binomial-ish counts, two conditions.

    Genes 0-4 are up-shifted in condition B so at least some signal exists; the
    rest are null. Rows are samples, columns are genes (pydeseq2's orientation).
    """
    rng = np.random.default_rng(0)
    n_samples, n_genes = 20, 30
    samples = [f"sample{i}" for i in range(n_samples)]
    genes = [f"gene{j}" for j in range(n_genes)]
    condition = np.array(["A"] * 10 + ["B"] * 10)

    base = rng.poisson(50, (n_samples, n_genes)).astype(int)
    base[condition == "B", :5] += rng.poisson(80, (10, 5))
    counts = pd.DataFrame(base, index=samples, columns=genes)
    metadata = pd.DataFrame({"condition": condition}, index=samples)
    return counts, metadata


def test_counts_metadata_shape():
    counts, metadata = _make_counts_and_metadata()
    assert counts.shape == (20, 30)
    assert list(metadata["condition"].unique()) == ["A", "B"]
    assert (counts.to_numpy() >= 0).all()


def test_deseq2_results():
    counts, metadata = _make_counts_and_metadata()
    dds = DeseqDataSet(counts=counts, metadata=metadata, design="~condition")
    dds.deseq2()
    stats = DeseqStats(dds)
    stats.summary()
    res = stats.results_df
    assert res.shape[0] == 30
    for col in ("log2FoldChange", "pvalue", "padj"):
        assert col in res.columns
    # p-values that exist are in [0, 1]; NaNs (filtered genes) are allowed.
    pvals = res["pvalue"].dropna().to_numpy()
    assert ((pvals >= 0.0) & (pvals <= 1.0)).all()


run_test("counts/metadata shape", test_counts_metadata_shape)
run_test("deseq2 + DeseqStats.summary results_df", test_deseq2_results)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all pydeseq2 smoke tests passed")
