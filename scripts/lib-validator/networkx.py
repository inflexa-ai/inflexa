#!/usr/bin/env python3
"""Smoke test for the Python `networkx` package.

Fully self-contained: no input files, no network, no packages beyond networkx
(and its implied deps — scipy for adjacency matrices). Exercises the core API
surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 networkx.py

Install: pip install networkx   (import name: networkx)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.
"""
import math
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import networkx as nx
except ImportError:
    print("FAIL: package 'networkx' is not installed")
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


print(f"networkx version: {_version(nx, 'networkx')}")

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


def test_graph_construction():
    g = nx.Graph()
    g.add_nodes_from([1, 2, 3, 4])
    g.add_edges_from([(1, 2), (2, 3), (3, 4)])
    assert g.number_of_nodes() == 4
    assert g.number_of_edges() == 3
    assert g.degree(2) == 2
    assert g.degree(1) == 1
    assert set(g.neighbors(2)) == {1, 3}


def test_from_edgelist_triangle():
    # A triangle: three mutually-adjacent nodes, every degree exactly 2.
    g = nx.from_edgelist([(0, 1), (1, 2), (2, 0)])
    assert g.number_of_nodes() == 3
    assert g.number_of_edges() == 3
    assert all(d == 2 for _, d in g.degree())


def test_shortest_path_length():
    # Path graph 0-1-2-3-4: hop distance equals index gap.
    g = nx.path_graph(5)
    assert nx.shortest_path_length(g, 0, 4) == 4
    assert nx.shortest_path_length(g, 1, 3) == 2
    assert nx.shortest_path(g, 0, 4) == [0, 1, 2, 3, 4]


def test_connected_components():
    g = nx.Graph()
    g.add_edges_from([(1, 2), (2, 3), (10, 11)])
    comps = sorted(nx.connected_components(g), key=len, reverse=True)
    assert nx.number_connected_components(g) == 2
    assert comps[0] == {1, 2, 3}
    assert comps[1] == {10, 11}


def test_karate_club_shape():
    g = nx.karate_club_graph()
    assert g.number_of_nodes() == 34
    assert g.number_of_edges() == 78


def test_betweenness_and_pagerank_finite():
    g = nx.karate_club_graph()
    bc = nx.betweenness_centrality(g)
    assert isinstance(bc, dict)
    assert len(bc) == 34
    assert all(math.isfinite(v) and v >= 0.0 for v in bc.values())
    pr = nx.pagerank(g)
    assert isinstance(pr, dict)
    assert len(pr) == 34
    assert all(math.isfinite(v) and v > 0.0 for v in pr.values())
    # PageRank is a probability distribution over nodes: it must sum to 1.
    assert math.isclose(sum(pr.values()), 1.0, rel_tol=1e-6)


def test_adjacency_matrix_shape():
    g = nx.path_graph(5)
    A = nx.adjacency_matrix(g)
    assert A.shape == (5, 5)
    # 4 undirected edges → 8 stored nonzeros (symmetric matrix).
    assert A.nnz == 8


run_test("graph construction + degree", test_graph_construction)
run_test("from_edgelist triangle", test_from_edgelist_triangle)
run_test("shortest path length", test_shortest_path_length)
run_test("connected components", test_connected_components)
run_test("karate club shape (34/78)", test_karate_club_shape)
run_test("betweenness + pagerank finite", test_betweenness_and_pagerank_finite)
run_test("adjacency matrix shape", test_adjacency_matrix_shape)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all networkx smoke tests passed")
