#!/usr/bin/env python3
"""Smoke test for the Python `pertpy` package.

Fully self-contained: no input files, no network, no packages beyond pertpy
(and its implied deps — scanpy, anndata, and the model stack). Exercises the
core API surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 pertpy.py

Install: pip install pertpy   (import name: pertpy)

FLAG — heavy import. pertpy transitively imports scanpy AND scvi-tools, which
pulls in jax -> numpyro (this is why environments pin jax <0.10) plus torch.
Importing pertpy alone is expensive, so this smoke test stays MODEST: it asserts
the package imports and exposes its `pt.tl` / `pt.pp` / `pt.data` namespaces, and
deliberately does NOT construct or train any model.

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
    import pertpy as pt
except ImportError:
    print("FAIL: package 'pertpy' is not installed")
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


print(f"pertpy version: {_version(pt, 'pertpy')}")

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


def test_namespaces_present():
    # FLAG: heavy. We only assert the top-level API surface exists — importing
    # pertpy already exercised the expensive scanpy/scvi/jax/torch stack.
    assert hasattr(pt, "tl")
    assert hasattr(pt, "pp")
    assert hasattr(pt, "data")


def test_tool_classes_exposed():
    # A representative differential/perturbation tool should be exposed on pt.tl.
    # Do NOT instantiate or run it — construction pulls the model backends.
    assert any(hasattr(pt.tl, name) for name in ("Augur", "Mixscape", "Dialogue"))


run_test("pt.tl / pt.pp / pt.data namespaces present", test_namespaces_present)
run_test("pt.tl exposes perturbation tool classes (no model run)", test_tool_classes_exposed)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all pertpy smoke tests passed")
