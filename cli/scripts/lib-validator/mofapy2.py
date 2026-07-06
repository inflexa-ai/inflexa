#!/usr/bin/env python3
"""Smoke test for the Python `mofapy2` package.

Fully self-contained: no input files, no network. Exercises the core API
surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 mofapy2.py

Install: pip install mofapy2   (import name: mofapy2)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.

MODEST + FLAGGED: mofapy2 is the MOFA+ multi-omics factor analysis TRAINING
backend. A real fit — set_data_matrix(list-of-views) → set_model_options →
set_train_options → build() → run() — is a heavy variational-inference
optimisation, so this deliberately does NOT train a model. It only asserts the
package imports, exposes its documented entry point
(mofapy2.run.entry_point.entry_point), and that constructing an entry_point()
is cheap (it just initialises the options container). RE-CHECK once installed:
the entry_point module path and class name against the installed API.
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
    import mofapy2
except ImportError:
    print("FAIL: package 'mofapy2' is not installed")
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


print(f"mofapy2 version: {_version(mofapy2, 'mofapy2')}")

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


def test_exposes_entry_point():
    import importlib

    # entry_point lives at mofapy2.run.entry_point; import it lazily so a
    # missing/renamed module is a test failure, not a top-level crash.
    ep_mod = importlib.import_module("mofapy2.run.entry_point")
    assert hasattr(ep_mod, "entry_point")
    assert callable(ep_mod.entry_point)


def test_entry_point_constructs_cheaply():
    import importlib

    ep_mod = importlib.import_module("mofapy2.run.entry_point")
    # Constructing the entry point only initialises the options container; it
    # touches no data and runs no inference, so this stays cheap and offline.
    ep = ep_mod.entry_point()
    assert isinstance(ep, ep_mod.entry_point)


run_test("exposes mofapy2.run.entry_point.entry_point", test_exposes_entry_point)
run_test("entry_point() constructs cheaply", test_entry_point_constructs_cheaply)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all mofapy2 smoke tests passed")
