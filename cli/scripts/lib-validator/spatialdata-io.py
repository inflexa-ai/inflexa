#!/usr/bin/env python3
"""Smoke test for the Python `spatialdata-io` package.

Fully self-contained: no input files, no network. `spatialdata-io` is a library
of readers that turn on-disk spatial-omics platform outputs (Xenium, Visium,
MERSCOPE, …) into `SpatialData` objects, so every reader needs a real data
directory that this test deliberately does NOT provide. Instead it asserts the
package imports and exposes its reader functions, exiting 0 only if every check
passes, so it can be used as a pass/fail library validator:

    python3 spatialdata-io.py

Install: pip install spatialdata-io   (import name: spatialdata_io)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.

NOTE (correct-by-review, deliberately MODEST): the readers require real
platform export directories (and pull in spatialdata + its element models), so
this test does not invoke any reader — it only confirms the callable reader
surface is present.
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import spatialdata_io
except ImportError:
    print("FAIL: package 'spatialdata-io' is not installed")
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


print(f"spatialdata-io version: {_version(spatialdata_io, 'spatialdata-io')}")

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


def test_module_imports():
    assert spatialdata_io is not None
    # The package re-exports its readers at the top level.
    assert hasattr(spatialdata_io, "__all__") or dir(spatialdata_io)


def test_exposes_platform_readers():
    # Core platform readers that every spatialdata-io release ships.
    for reader in ("xenium", "visium", "merscope"):
        assert hasattr(spatialdata_io, reader), f"missing reader: {reader}"
        assert callable(getattr(spatialdata_io, reader)), f"not callable: {reader}"


def test_at_least_one_extra_reader_present():
    # Beyond the core three, the package exposes many more platform readers;
    # assert the surface is broad without pinning a brittle exact set.
    candidates = (
        "visium_hd",
        "cosmx",
        "steinbock",
        "curio",
        "dbit",
        "iss",
        "mcmicro",
    )
    present = [c for c in candidates if callable(getattr(spatialdata_io, c, None))]
    assert present, "expected at least one additional platform reader"


run_test("module imports", test_module_imports)
run_test("exposes core platform readers", test_exposes_platform_readers)
run_test("exposes additional platform readers", test_at_least_one_extra_reader_present)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all spatialdata-io smoke tests passed")
