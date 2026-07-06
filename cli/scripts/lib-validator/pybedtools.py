#!/usr/bin/env python3
"""Smoke test for the Python `pybedtools` package.

Fully self-contained: no input files, no network. Intervals are built from
in-memory BED strings via `from_string=True`. Exercises the core API surface and
exits 0 only if every check passes, so it can be used as a pass/fail library
validator:

    python3 pybedtools.py

Install: pip install pybedtools   (import name: pybedtools)

RUNTIME NOTE: pybedtools is a wrapper around the standalone `bedtools` binary —
it shells out to it for merge/intersect/etc. The `bedtools` executable must be
installed and on PATH (e.g. `conda install -c bioconda bedtools`, or a system
package); the Python package alone is not enough. A missing binary surfaces as a
pybedtools helper/`OSError` at the first operation, not at import.

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
    import pybedtools
except ImportError:
    print("FAIL: package 'pybedtools' is not installed")
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


print(f"pybedtools version: {_version(pybedtools, 'pybedtools')}")

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


def test_bedtool_from_string():
    # BED is 0-based half-open; from_string accepts whitespace-separated fields.
    bt = pybedtools.BedTool("chr1 10 20\nchr1 15 25\nchr1 40 50", from_string=True)
    intervals = list(bt)
    assert len(intervals) == 3
    assert intervals[0].chrom == "chr1"
    assert intervals[0].start == 10
    assert intervals[0].end == 20


def test_merge():
    # Input is sorted; merge collapses book-ended/overlapping features.
    bt = pybedtools.BedTool("chr1 10 20\nchr1 15 25\nchr1 40 50", from_string=True)
    merged = list(bt.merge())
    # [10,20) and [15,25) overlap -> [10,25); [40,50) stands alone.
    assert len(merged) == 2
    assert (merged[0].chrom, merged[0].start, merged[0].end) == ("chr1", 10, 25)
    assert (merged[1].start, merged[1].end) == (40, 50)


def test_intersect():
    a = pybedtools.BedTool("chr1 10 20\nchr1 40 50", from_string=True)
    b = pybedtools.BedTool("chr1 15 45", from_string=True)
    inter = list(a.intersect(b))
    # [10,20) & [15,45) -> [15,20); [40,50) & [15,45) -> [40,45).
    assert len(inter) == 2
    assert (inter[0].start, inter[0].end) == (15, 20)
    assert (inter[1].start, inter[1].end) == (40, 45)


run_test("BedTool from_string parse", test_bedtool_from_string)
run_test("merge overlapping intervals", test_merge)
run_test("intersect two BedTools", test_intersect)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all pybedtools smoke tests passed")
