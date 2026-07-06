#!/usr/bin/env python3
"""Smoke test for the Python `PyWGCNA` package (weighted gene co-expression).

Fully self-contained: no input files, no network. Deliberately MODEST — see the
note below — so it can be used as a pass/fail library validator:

    python3 PyWGCNA.py

Install: pip install PyWGCNA   (import name: PyWGCNA)

DESIGN NOTE (why this validator is intentionally shallow): PyWGCNA is a heavy
co-expression pipeline whose `WGCNA(...)` object is normally built from a file
path (`geneExpPath`) or an AnnData, and whose real work (`preprocess`,
`findModules`, `runWGCNA`) writes plots/objects to an output directory. A
network-free, file-free smoke test therefore cannot exercise the pipeline
end-to-end without side effects, so this validator asserts only the public
API surface: the `WGCNA` class, its headline methods, and the
expression-input parameters of its constructor (verified by introspection, so
no `WGCNA` object is constructed and nothing touches disk).

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
    import PyWGCNA
except ImportError:
    print("FAIL: package 'PyWGCNA' is not installed")
    sys.exit(1)

import inspect


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


print(f"PyWGCNA version: {_version(PyWGCNA, 'PyWGCNA')}")

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


def test_wgcna_class_exists():
    # The headline entry point of the library is the WGCNA class.
    assert hasattr(PyWGCNA, "WGCNA")
    assert inspect.isclass(PyWGCNA.WGCNA)


def test_wgcna_core_methods():
    cls = PyWGCNA.WGCNA
    # The core co-expression pipeline steps are exposed as instance methods.
    for meth in ("preprocess", "findModules", "runWGCNA"):
        assert callable(getattr(cls, meth, None)), f"missing method: {meth}"


def test_constructor_accepts_expression_input():
    # Confirm the documented expression-input API via introspection only —
    # constructing a WGCNA object can create output dirs / read files, which a
    # file-free smoke test must avoid.
    sig = inspect.signature(PyWGCNA.WGCNA.__init__)
    params = set(sig.parameters)
    assert "name" in params
    # At least one in-memory / path expression-input channel must be offered.
    assert params & {"geneExp", "geneExpPath", "anndata"}


run_test("WGCNA class exists", test_wgcna_class_exists)
run_test("WGCNA core methods present", test_wgcna_core_methods)
run_test("constructor expression-input API", test_constructor_accepts_expression_input)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all PyWGCNA smoke tests passed")
