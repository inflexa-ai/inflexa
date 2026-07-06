#!/usr/bin/env python3
"""Smoke test for the Python `shapely` package.

Fully self-contained: no input files, no network, no packages beyond shapely
(and its bundled GEOS). Exercises the core planar-geometry API and exits 0 only
if every check passes, so it can be used as a pass/fail library validator:

    python3 shapely.py

Install: pip install shapely   (import name: shapely)

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
    import shapely
    from shapely.geometry import LineString, Point, Polygon
except ImportError:
    print("FAIL: package 'shapely' is not installed")
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


print(f"shapely version: {_version(shapely, 'shapely')}")

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


def test_point_buffer_area_approximates_pi():
    circle = Point(0, 0).buffer(1)
    # A buffer is a polygonal approximation of the disk (default 8 segments per
    # quadrant), so its area is a touch under pi — allow a loose tolerance.
    assert abs(circle.area - math.pi) < 0.05
    assert circle.geom_type == "Polygon"


def test_polygon_area_and_contains():
    square = Polygon([(0, 0), (1, 0), (1, 1), (0, 1)])
    assert abs(square.area - 1.0) < 1e-9
    assert square.contains(Point(0.5, 0.5))
    assert not square.contains(Point(2.0, 2.0))
    assert abs(square.length - 4.0) < 1e-9


def test_intersection_and_union():
    a = Polygon([(0, 0), (1, 0), (1, 1), (0, 1)])
    b = Polygon([(0.5, 0.5), (1.5, 0.5), (1.5, 1.5), (0.5, 1.5)])
    inter = a.intersection(b)
    uni = a.union(b)
    # Overlap is a 0.5 x 0.5 square (0.25); union is 1 + 1 - 0.25.
    assert abs(inter.area - 0.25) < 1e-9
    assert abs(uni.area - 1.75) < 1e-9


def test_linestring_length():
    line = LineString([(0, 0), (3, 4)])
    # 3-4-5 right triangle: the hypotenuse length is exactly 5.
    assert abs(line.length - 5.0) < 1e-9
    assert line.geom_type == "LineString"


run_test("Point.buffer area ~ pi", test_point_buffer_area_approximates_pi)
run_test("Polygon area + contains", test_polygon_area_and_contains)
run_test("intersection + union areas", test_intersection_and_union)
run_test("LineString length", test_linestring_length)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all shapely smoke tests passed")
