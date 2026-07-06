#!/usr/bin/env python3
"""Smoke test for the Python `louvain` package.

Fully self-contained: no input files, no network, no packages beyond louvain
(and its implied dep — python-igraph). Exercises the core API surface and exits
0 only if every check passes, so it can be used as a pass/fail library
validator:

    python3 louvain.py

Install: pip install louvain   (import name: louvain)

FLAG — igraph dependency. louvain operates on `igraph.Graph` objects and does
NOT vendor igraph; the test imports `igraph` too. If igraph is missing the
relevant checks fail (isolated by the harness) rather than crashing.

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
    import louvain
except ImportError:
    print("FAIL: package 'louvain' is not installed")
    sys.exit(1)

import math


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


print(f"louvain version: {_version(louvain, 'louvain')}")

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


def test_partition_zachary():
    # FLAG: needs python-igraph. Zachary's karate club is a fixed 34-node graph.
    import igraph

    g = igraph.Graph.Famous("Zachary")
    assert g.vcount() == 34
    part = louvain.find_partition(g, louvain.ModularityVertexPartition, seed=0)
    assert len(part.membership) == 34
    assert math.isfinite(part.modularity)
    assert part.modularity > 0.0
    assert len(set(part.membership)) >= 2


def test_rbconfiguration_flavour():
    import igraph

    g = igraph.Graph.Famous("Zachary")
    part = louvain.find_partition(g, louvain.RBConfigurationVertexPartition, seed=0)
    assert len(part.membership) == 34
    assert math.isfinite(part.modularity)


run_test("find_partition on Zachary (Modularity, needs igraph)", test_partition_zachary)
run_test("RBConfigurationVertexPartition modularity finite", test_rbconfiguration_flavour)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all louvain smoke tests passed")
