#!/usr/bin/env python3
"""Smoke test for the Python `spatialdata` package.

Fully self-contained: no input files, no network. Builds a minimal synthetic
`SpatialData` object entirely in memory and verifies it constructs and exposes
its element containers, exiting 0 only if every check passes, so it can be used
as a pass/fail library validator:

    python3 spatialdata.py

Install: pip install spatialdata   (import name: spatialdata)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.

NOTE (correct-by-review, deliberately MODEST): spatialdata's element models are
intricate — images/labels are lazy xarray/dask arrays, points/shapes are
parsed through `spatialdata.models.PointsModel.parse` / `ShapesModel.parse`,
and tables are AnnData carrying a coordinate-transform + region annotation.
This test only builds the simplest valid elements (a points frame and a table
AnnData) to confirm the container composes and its `.points`/`.tables`/
`.images`/`.labels`/`.shapes` accessors exist; it does not exercise coordinate
systems, transforms, or on-disk (zarr) I/O.
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import spatialdata
except ImportError:
    print("FAIL: package 'spatialdata' is not installed")
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


print(f"spatialdata version: {_version(spatialdata, 'spatialdata')}")

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


def test_empty_spatialdata_exposes_containers():
    from spatialdata import SpatialData

    sdata = SpatialData()
    # The five element containers are the object's public surface; each is an
    # (empty) mapping on a freshly-constructed object.
    for attr in ("images", "labels", "points", "shapes", "tables"):
        assert hasattr(sdata, attr)
    assert len(sdata.points) == 0
    assert len(sdata.tables) == 0


def test_points_element_from_dataframe():
    import numpy as np
    import pandas as pd
    from spatialdata import SpatialData
    from spatialdata.models import PointsModel

    rng = np.random.default_rng(0)
    df = pd.DataFrame(
        {"x": rng.random(5), "y": rng.random(5), "gene": ["g0", "g1", "g2", "g3", "g4"]}
    )
    # PointsModel.parse converts the frame into the lazy (dask) points element
    # spatialdata expects, wiring in the coordinate columns.
    points = PointsModel.parse(df, coordinates={"x": "x", "y": "y"})
    sdata = SpatialData(points={"pts": points})
    assert "pts" in sdata.points
    assert len(sdata.points) == 1


def test_table_element_from_anndata():
    import anndata as ad
    import numpy as np
    from spatialdata import SpatialData
    from spatialdata.models import TableModel

    rng = np.random.default_rng(1)
    adata = ad.AnnData(rng.random((6, 3)).astype("float32"))
    table = TableModel.parse(adata)
    sdata = SpatialData(tables={"table": table})
    assert "table" in sdata.tables
    assert sdata.tables["table"].shape == (6, 3)


run_test("empty SpatialData exposes element containers", test_empty_spatialdata_exposes_containers)
run_test("points element from DataFrame", test_points_element_from_dataframe)
run_test("table element from AnnData", test_table_element_from_anndata)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all spatialdata smoke tests passed")
