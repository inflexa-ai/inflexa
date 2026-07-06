#!/usr/bin/env python3
"""Smoke test for the Python `scikit-bio` package (import name: skbio).

Fully self-contained: no input files, no network, no packages beyond
scikit-bio and its implied deps (numpy, scipy, pandas). Exercises the core API
surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 scikit-bio.py

Install: pip install scikit-bio   (import name: skbio)

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
    import skbio
except ImportError:
    print("FAIL: package 'scikit-bio' is not installed")
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


print(f"scikit-bio version: {_version(skbio, 'scikit-bio')}")

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


def test_dna_reverse_complement_and_gc():
    seq = skbio.DNA("ACGT")
    assert str(seq) == "ACGT"
    assert len(seq) == 4
    # ACGT is its own reverse complement.
    assert str(seq.reverse_complement()) == "ACGT"
    # Two of four bases (C, G) are G/C → 50%.
    assert abs(float(seq.gc_content()) - 0.5) < 1e-9

    seq2 = skbio.DNA("GGGGCCCC")
    # All eight bases are G/C → 100%.
    assert abs(float(seq2.gc_content()) - 1.0) < 1e-9
    assert str(seq2.reverse_complement()) == "GGGGCCCC"


def test_alpha_diversity_shannon():
    from skbio.diversity.alpha import shannon
    import numpy as np

    counts = [10, 10, 10, 10]
    h = shannon(counts)
    assert np.isfinite(h)
    # Four equally-abundant taxa → Shannon (log2) index of exactly 2 bits.
    assert abs(float(h) - 2.0) < 1e-9
    # A single-taxon community has zero diversity.
    assert abs(float(shannon([42, 0, 0]))) < 1e-9


def test_distance_matrix_condensed_form():
    from skbio.stats.distance import DistanceMatrix
    import numpy as np

    square = np.array(
        [
            [0.0, 1.0, 2.0],
            [1.0, 0.0, 3.0],
            [2.0, 3.0, 0.0],
        ]
    )
    dm = DistanceMatrix(square, ids=["a", "b", "c"])
    assert dm.shape == (3, 3)
    assert list(dm.ids) == ["a", "b", "c"]
    # The condensed form is the upper triangle, row-major: (a,b), (a,c), (b,c).
    assert np.allclose(dm.condensed_form(), np.array([1.0, 2.0, 3.0]))
    assert abs(dm["a", "c"] - 2.0) < 1e-9


def test_treenode_newick_parse():
    from io import StringIO

    tree = skbio.TreeNode.read(StringIO("((a,b),c);"))
    tip_names = sorted(t.name for t in tree.tips())
    assert tip_names == ["a", "b", "c"]
    assert tree.count(tips=True) == 3
    # a and b are siblings, so their LCA is not the whole-tree root.
    lca = tree.lca(["a", "b"])
    assert lca is not tree
    assert sorted(t.name for t in lca.tips()) == ["a", "b"]


run_test("DNA reverse_complement + gc_content", test_dna_reverse_complement_and_gc)
run_test("alpha diversity shannon finite", test_alpha_diversity_shannon)
run_test("DistanceMatrix condensed_form", test_distance_matrix_condensed_form)
run_test("TreeNode newick parse", test_treenode_newick_parse)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all scikit-bio smoke tests passed")
