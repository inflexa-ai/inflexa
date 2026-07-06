#!/usr/bin/env python3
"""Smoke test for the Python `cooler` package.

Fully self-contained: no input files, no network, no packages beyond cooler
and its implied deps (numpy, pandas, h5py, scipy). Exercises the core API
surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 cooler.py

Install: pip install cooler   (import name: cooler)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.

MODEST + FLAG: cooler stores Hi-C contact matrices in a `.cool` (HDF5) file.
Building a valid cooler is non-trivial — `cooler.create_cooler(path, bins,
pixels)` demands a bins DataFrame with columns (chrom, start, end) and a pixels
DataFrame with columns (bin1_id, bin2_id, count) whose bin ids index into the
bins table. The create-then-reopen check below encodes that schema exactly; if
the create API drifts, this is the check to revisit first.
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import cooler
except ImportError:
    print("FAIL: package 'cooler' is not installed")
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


print(f"cooler version: {_version(cooler, 'cooler')}")

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


def _toy_bins_pixels():
    """A minimal 4-bin single-chromosome contact set (chr1, 10bp binsize)."""
    import pandas as pd

    bins = pd.DataFrame(
        {
            "chrom": ["chr1", "chr1", "chr1", "chr1"],
            "start": [0, 10, 20, 30],
            "end": [10, 20, 30, 40],
        }
    )
    # Upper-triangle pixels (bin1_id <= bin2_id) with integer counts.
    pixels = pd.DataFrame(
        {
            "bin1_id": [0, 0, 1, 2, 3],
            "bin2_id": [0, 1, 1, 2, 3],
            "count": [5, 3, 7, 4, 6],
        }
    )
    return bins, pixels


def test_create_and_reopen_cool_tempfile():
    import tempfile

    bins, pixels = _toy_bins_pixels()
    fd, path = tempfile.mkstemp(suffix=".cool")
    os.close(fd)
    try:
        cooler.create_cooler(path, bins, pixels)
        c = cooler.Cooler(path)
        # Four bins on a single chromosome.
        assert c.chromnames == ["chr1"]
        assert c.binsize == 10
        assert c.bins().shape[0] == 4
        # A dense 4x4 contact matrix reconstructed from the sparse pixels.
        mat = c.matrix(balance=False)[:]
        assert mat.shape == (4, 4)
        # Diagonal (0,0) pixel had count 5; matrix is symmetric.
        assert mat[0, 0] == 5
        assert mat[0, 1] == 3
        assert mat[1, 0] == 3
    finally:
        os.remove(path)


def test_bins_and_pixels_accessors():
    import tempfile

    bins, pixels = _toy_bins_pixels()
    fd, path = tempfile.mkstemp(suffix=".cool")
    os.close(fd)
    try:
        cooler.create_cooler(path, bins, pixels)
        c = cooler.Cooler(path)
        bdf = c.bins()[:]
        assert list(bdf.columns[:3]) == ["chrom", "start", "end"]
        assert int(bdf.iloc[1]["start"]) == 10
        pdf = c.pixels()[:]
        assert "count" in pdf.columns
        # Five stored (upper-triangle) contacts.
        assert len(pdf) == 5
    finally:
        os.remove(path)


run_test("create_cooler + reopen matrix", test_create_and_reopen_cool_tempfile)
run_test("bins/pixels accessors", test_bins_and_pixels_accessors)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all cooler smoke tests passed")
