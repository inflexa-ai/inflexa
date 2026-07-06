#!/usr/bin/env python3
"""Smoke test for the Python `scirpy` package.

Fully self-contained: no input files, no network (scirpy.datasets fetches are
deliberately avoided), no packages beyond scirpy (and its implied deps:
anndata, scanpy). Exercises the core API surface and exits 0 only if every
check passes, so it can be used as a pass/fail library validator:

    python3 scirpy.py

Install: pip install scirpy   (import name: scirpy)

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
    import scirpy as ir
except ImportError:
    print("FAIL: package 'scirpy' is not installed")
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


print(f"scirpy version: {_version(ir, 'scirpy')}")

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


# NOTE: scirpy operates on AnnData objects and its datasets fetch over the
# network, so this validator stays MODEST: it confirms the package imports and
# that the scanpy-style namespaces + the clonotype-pipeline entrypoints exist,
# without building/processing a repertoire. FLAG: real use needs anndata.
def test_submodules_present():
    # scirpy mirrors scanpy's pp / tl / io / pl namespace layout.
    for sub in ("pp", "tl", "io", "pl"):
        assert hasattr(ir, sub), f"scirpy.{sub} missing"


def test_pp_and_tl_functions_present():
    # The workhorses of the clonotype pipeline: distance calc then clustering.
    assert callable(ir.pp.ir_dist)
    assert callable(ir.tl.define_clonotypes)
    assert callable(ir.tl.define_clonotype_clusters)
    assert callable(ir.tl.clonal_expansion)


def test_io_reader_present():
    # AIRR ingest entrypoints (no file is read here — MODEST surface check).
    assert hasattr(ir.io, "read_airr") or hasattr(ir.io, "from_airr_cells")


run_test("scanpy-style submodules present", test_submodules_present)
run_test("pp/tl pipeline functions present", test_pp_and_tl_functions_present)
run_test("io AIRR reader present", test_io_reader_present)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all scirpy smoke tests passed")
