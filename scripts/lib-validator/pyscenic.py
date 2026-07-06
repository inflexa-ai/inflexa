#!/usr/bin/env python3
"""Smoke test for the Python `pyscenic` package.

Fully self-contained: no input files, no network. Exercises the core API
surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 pyscenic.py

Install: pip install pyscenic   (import name: pyscenic)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.

MODEST + FLAGGED: pySCENIC is SCENIC gene-regulatory-network inference. The full
pipeline (grn → prune against motif databases → aucell) needs downloaded ranking
databases and motif annotations (network) — NOT done here. AUCell alone can run
offline but requires ctxcore.genesig.GeneSignature objects; rather than couple
to that internal, this asserts the package imports and exposes its documented
step modules (aucell, grn, prune, utils). It does NOT run SCENIC.
(correct-by-review.)
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import pyscenic
except ImportError:
    print("FAIL: package 'pyscenic' is not installed")
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


print(f"pyscenic version: {_version(pyscenic, 'pyscenic')}")

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


def test_exposes_step_modules():
    import importlib

    # The three SCENIC steps live in dedicated submodules; import lazily so a
    # missing one is a test failure, not a top-level crash.
    assert importlib.import_module("pyscenic.aucell") is not None
    assert importlib.import_module("pyscenic.grn") is not None
    assert importlib.import_module("pyscenic.prune") is not None


def test_aucell_and_utils_callables():
    import importlib

    aucell_mod = importlib.import_module("pyscenic.aucell")
    assert hasattr(aucell_mod, "aucell")
    assert importlib.import_module("pyscenic.utils") is not None


run_test("exposes pyscenic.aucell / grn / prune", test_exposes_step_modules)
run_test("aucell callable + utils importable", test_aucell_and_utils_callables)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all pyscenic smoke tests passed")
