#!/usr/bin/env python3
"""Smoke test for the Python `geopandas` package.

Fully self-contained: no input files, no network. Builds geometries in-memory
with shapely and exercises the core GeoDataFrame API, exiting 0 only if every
check passes, so it can be used as a pass/fail library validator:

    python3 geopandas.py

Install: pip install geopandas   (import name: geopandas)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.

NOTE (correct-by-review): geopandas layers on a stack of native libraries —
shapely/GEOS for geometry, pyproj/PROJ for CRS reprojection (`.to_crs`), and
fiona/pyogrio (GDAL) for file I/O. The CRS test below needs pyproj; none of the
checks touch disk, so no GDAL file drivers are required here.
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import geopandas
    from shapely.geometry import Point, Polygon
except ImportError:
    print("FAIL: package 'geopandas' is not installed")
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


print(f"geopandas version: {_version(geopandas, 'geopandas')}")

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


def _sample_gdf():
    """Two unit-side squares plus an attribute column."""
    polys = [
        Polygon([(0, 0), (2, 0), (2, 2), (0, 2)]),
        Polygon([(2, 2), (4, 2), (4, 4), (2, 4)]),
    ]
    return geopandas.GeoDataFrame({"name": ["a", "b"], "geometry": polys})


def test_construct_geometry_and_area():
    gdf = _sample_gdf()
    assert list(gdf["name"]) == ["a", "b"]
    assert isinstance(gdf.geometry, geopandas.GeoSeries)
    assert list(gdf.geometry.geom_type) == ["Polygon", "Polygon"]
    # Each square is 2 x 2 = area 4.
    assert list(gdf.area) == [4.0, 4.0]


def test_bounds():
    gdf = _sample_gdf()
    bounds = gdf.bounds
    assert list(bounds.columns) == ["minx", "miny", "maxx", "maxy"]
    first = bounds.iloc[0]
    assert (first.minx, first.miny, first.maxx, first.maxy) == (0.0, 0.0, 2.0, 2.0)
    # Total extent spans both squares.
    assert tuple(gdf.total_bounds) == (0.0, 0.0, 4.0, 4.0)


def test_spatial_predicate_contains():
    gdf = _sample_gdf()
    mask = gdf.contains(Point(1, 1))
    # Only the first square encloses (1, 1).
    assert list(mask) == [True, False]


def test_set_and_reproject_crs():
    gdf = _sample_gdf()
    gdf = gdf.set_crs("EPSG:4326")
    assert gdf.crs is not None
    assert gdf.crs.to_epsg() == 4326
    # .to_crs needs pyproj/PROJ to reproject the coordinates.
    web = gdf.to_crs("EPSG:3857")
    assert web.crs.to_epsg() == 3857
    assert not web.geometry.iloc[0].equals(gdf.geometry.iloc[0])


def test_dissolve_by_group():
    polys = [
        Polygon([(0, 0), (1, 0), (1, 1), (0, 1)]),
        Polygon([(1, 0), (2, 0), (2, 1), (1, 1)]),
        Polygon([(0, 2), (1, 2), (1, 3), (0, 3)]),
    ]
    gdf = geopandas.GeoDataFrame({"grp": ["x", "x", "y"], "geometry": polys})
    merged = gdf.dissolve(by="grp")
    assert set(merged.index) == {"x", "y"}
    # The two "x" unit squares dissolve into a single area-2 geometry.
    assert abs(float(merged.loc["x"].geometry.area) - 2.0) < 1e-9


run_test("construct GeoDataFrame + area", test_construct_geometry_and_area)
run_test("bounds / total_bounds", test_bounds)
run_test("spatial predicate: contains", test_spatial_predicate_contains)
run_test("set_crs + to_crs reprojection", test_set_and_reproject_crs)
run_test("dissolve by group", test_dissolve_by_group)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all geopandas smoke tests passed")
