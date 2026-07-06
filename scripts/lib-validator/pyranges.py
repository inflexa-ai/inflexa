#!/usr/bin/env python3
"""Smoke test for the Python `pyranges` package.

Fully self-contained: no input files, no network. Builds its intervals from
in-memory pandas DataFrames. Exercises the core API surface and exits 0 only if
every check passes, so it can be used as a pass/fail library validator:

    python3 pyranges.py

Install: pip install pyranges   (import name: pyranges; pulls in pandas)

API NOTE (v0 vs v1): pyranges 1.x is a breaking rewrite. This script targets the
CURRENT v1 API — a PyRanges IS a pandas.DataFrame subclass and overlapping
intervals are collapsed with `.merge_overlaps()`. On the legacy v0.x API the
constructor took keyword arrays (`pr.PyRanges(chromosomes=..., starts=...,
ends=...)`) and the same operation was spelled `.merge()`. If you run this
against a v0 install it will fail at `merge_overlaps` / column access — that is
the API divergence, not a regression in the checks.

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
    import pyranges
except ImportError:
    print("FAIL: package 'pyranges' is not installed")
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


print(f"pyranges version: {_version(pyranges, 'pyranges')}")

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


def _gr(chroms, starts, ends):
    """Build a PyRanges from parallel Chromosome/Start/End arrays (half-open)."""
    import pandas as pd

    return pyranges.PyRanges(
        pd.DataFrame({"Chromosome": chroms, "Start": starts, "End": ends})
    )


def test_lengths():
    # chr1: [1,10)=9, [5,15)=10, [20,30)=10  -> total 29 bp.
    gr = _gr(["chr1", "chr1", "chr1"], [1, 5, 20], [10, 15, 30])
    # Per-interval width via column arithmetic (works on the DataFrame subclass).
    widths = list(gr.End - gr.Start)
    assert widths == [9, 10, 10]
    # `.length` is the total covered-by-rows base count (sum of widths).
    assert gr.length == 29


def test_overlap_and_intersect():
    a = _gr(["chr1", "chr1", "chr1"], [1, 5, 20], [10, 15, 30])
    b = _gr(["chr1"], [8], [22])

    # overlap: rows of `a` that touch any interval of `b`. All three chr1 rows
    # overlap [8,22): [1,10)->[8,10), [5,15)->[8,15), [20,30)->[20,22).
    ov = a.overlap(b)
    assert len(ov) == 3

    # intersect: the clipped intersection intervals themselves.
    inter = a.intersect(b)
    clipped = sorted(zip(inter.Start, inter.End))
    assert clipped == [(8, 10), (8, 15), (20, 22)]


def test_merge_overlaps():
    gr = _gr(["chr1", "chr1", "chr1"], [1, 5, 20], [10, 15, 30])
    # [1,10) and [5,15) overlap -> [1,15); [20,30) stands alone.
    merged = gr.merge_overlaps()
    ranges = sorted(zip(merged.Start, merged.End))
    assert ranges == [(1, 15), (20, 30)]


run_test("interval lengths + total .length", test_lengths)
run_test("overlap + intersect of two PyRanges", test_overlap_and_intersect)
run_test("merge_overlaps collapses overlapping intervals", test_merge_overlaps)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all pyranges smoke tests passed")
