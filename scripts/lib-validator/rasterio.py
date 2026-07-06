#!/usr/bin/env python3
"""Smoke test for the Python `rasterio` package.

Fully self-contained: no external input files, no network. Writes a small
in-memory array to a temporary GeoTIFF, reads it back, and verifies the
round-trip, exiting 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 rasterio.py

Install: pip install rasterio   (import name: rasterio)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.

NOTE (correct-by-review): rasterio is a Python binding over GDAL; the GeoTIFF
("GTiff") driver used below comes from the bundled/native GDAL. Everything is
written to and read from a tempfile that is removed in a `finally`, so no
external raster data is required.
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import rasterio
    from rasterio.transform import from_origin
except ImportError:
    print("FAIL: package 'rasterio' is not installed")
    sys.exit(1)

# numpy is a hard dependency of rasterio, so it is importable whenever rasterio is.
import numpy as np
import tempfile


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


print(f"rasterio version: {_version(rasterio, 'rasterio')}")

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


def test_geotiff_write_read_roundtrip():
    data = np.arange(64, dtype="float32").reshape(8, 8)
    transform = from_origin(west=0, north=8, xsize=1, ysize=1)
    fd, path = tempfile.mkstemp(suffix=".tif")
    os.close(fd)
    try:
        with rasterio.open(
            path,
            "w",
            driver="GTiff",
            height=8,
            width=8,
            count=1,
            dtype="float32",
            transform=transform,
        ) as dst:
            dst.write(data, 1)
        with rasterio.open(path) as src:
            back = src.read(1)
            assert src.width == 8
            assert src.height == 8
            assert src.count == 1
            assert src.dtypes[0] == "float32"
            assert np.allclose(back, data)
    finally:
        os.remove(path)


def test_profile_metadata_roundtrips():
    data = np.arange(12, dtype="uint8").reshape(3, 4)
    fd, path = tempfile.mkstemp(suffix=".tif")
    os.close(fd)
    try:
        with rasterio.open(
            path,
            "w",
            driver="GTiff",
            height=3,
            width=4,
            count=1,
            dtype="uint8",
        ) as dst:
            dst.write(data, 1)
        with rasterio.open(path) as src:
            profile = src.profile
            assert profile["driver"] == "GTiff"
            assert profile["width"] == 4
            assert profile["height"] == 3
            assert profile["count"] == 1
            assert str(profile["dtype"]) == "uint8"
    finally:
        os.remove(path)


def test_multiband_write_read():
    band1 = np.full((4, 4), 1, dtype="int16")
    band2 = np.full((4, 4), 2, dtype="int16")
    fd, path = tempfile.mkstemp(suffix=".tif")
    os.close(fd)
    try:
        with rasterio.open(
            path,
            "w",
            driver="GTiff",
            height=4,
            width=4,
            count=2,
            dtype="int16",
        ) as dst:
            dst.write(band1, 1)
            dst.write(band2, 2)
        with rasterio.open(path) as src:
            assert src.count == 2
            stack = src.read()  # shape (bands, rows, cols)
            assert stack.shape == (2, 4, 4)
            assert np.all(stack[0] == 1)
            assert np.all(stack[1] == 2)
    finally:
        os.remove(path)


run_test("GeoTIFF write/read round-trip", test_geotiff_write_read_roundtrip)
run_test("profile metadata roundtrips", test_profile_metadata_roundtrips)
run_test("multi-band write/read", test_multiband_write_read)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all rasterio smoke tests passed")
