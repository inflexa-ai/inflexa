#!/usr/bin/env python3
"""Smoke test for the Python `spatialdata-plot` package.

Fully self-contained: no input files, no network. `spatialdata-plot` registers
a matplotlib-backed `.pl` plotting accessor on `SpatialData`; importing it is
the side effect under test. Forces the headless Agg backend before the import
so nothing ever tries to open a window, and asserts the accessor is attached
without rendering any real data, exiting 0 only if every check passes, so it
can be used as a pass/fail library validator:

    python3 spatialdata-plot.py

Install: pip install spatialdata-plot   (import name: spatialdata_plot)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.

NOTE (correct-by-review, deliberately MODEST): actually rendering needs valid
spatialdata elements + a matplotlib canvas, so this test only confirms that
importing the package augments `SpatialData` with the `.pl` accessor and that
the accessor exposes its render/show methods — it draws nothing.
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    # Force the non-interactive Agg backend BEFORE spatialdata_plot pulls in
    # pyplot: this test runs headless and must never open a window, and
    # selecting the backend after pyplot is imported is a no-op. matplotlib is a
    # hard dependency of spatialdata_plot, so importing it here cannot mask a
    # missing spatialdata_plot.
    import matplotlib

    matplotlib.use("Agg")
    import spatialdata_plot
except ImportError:
    print("FAIL: package 'spatialdata-plot' is not installed")
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


print(f"spatialdata-plot version: {_version(spatialdata_plot, 'spatialdata-plot')}")

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


def test_import_registers_pl_accessor():
    from spatialdata import SpatialData

    sdata = SpatialData()
    # Importing spatialdata_plot registers the `.pl` accessor on SpatialData;
    # every instance gains it as a side effect of the import above.
    assert hasattr(sdata, "pl"), "spatialdata_plot did not register a .pl accessor"


def test_pl_accessor_exposes_render_methods():
    from spatialdata import SpatialData

    sdata = SpatialData()
    pl = sdata.pl
    # The accessor is the plotting API surface: render_* builders plus show().
    for method in ("render_images", "render_shapes", "render_points", "show"):
        assert hasattr(pl, method), f"missing plotting method: {method}"
        assert callable(getattr(pl, method)), f"not callable: {method}"


def test_agg_backend_is_active():
    # Confirms the headless guard above took effect (no interactive canvas).
    assert matplotlib.get_backend().lower() == "agg"


run_test("import registers .pl accessor", test_import_registers_pl_accessor)
run_test(".pl accessor exposes render methods", test_pl_accessor_exposes_render_methods)
run_test("Agg backend is active", test_agg_backend_is_active)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all spatialdata-plot smoke tests passed")
