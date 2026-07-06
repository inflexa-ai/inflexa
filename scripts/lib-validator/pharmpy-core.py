#!/usr/bin/env python3
"""Smoke test for the Python `pharmpy-core` package (population PK/PD modeling).

Fully self-contained: no input files, no network. Exercises the core API
surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 pharmpy-core.py

Install: pip install pharmpy-core   (import name: pharmpy)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.

MODEST + FLAGGED: pharmpy-core (import name `pharmpy`) is a population PK/PD
model-handling toolkit. PARSING a real model (a NONMEM control stream, an
mrgsolve/nlmixr model, …) needs an on-disk model file, so that path is
deliberately NOT exercised here. This asserts the package imports and exposes
its documented surface — the `pharmpy.Model` class and the large functional
`pharmpy.modeling` API namespace — and, since it is cheap and file-free,
constructs a minimal model via `pharmpy.modeling.create_basic_pk_model()` and
asserts its type. RE-CHECK once installed (the modeling API is broad and
version-sensitive): that `pharmpy.Model` is the top-level class name, that
`create_basic_pk_model` exists in `pharmpy.modeling`, and that it constructs
with no required dataset argument. (correct-by-review; the modeling API is
FLAGGED.)
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import pharmpy
except ImportError:
    print("FAIL: package 'pharmpy-core' is not installed")
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


print(f"pharmpy version: {_version(pharmpy, 'pharmpy-core')}")

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


def test_exposes_model_and_modeling():
    import importlib

    # Model is the top-level model class; modeling is the functional API
    # namespace (transforms, parameterisation, estimation setup, …). Import the
    # namespace lazily so a rename is a test failure, not a top-level crash.
    assert hasattr(pharmpy, "Model")
    modeling = importlib.import_module("pharmpy.modeling")
    assert callable(getattr(modeling, "create_basic_pk_model", None))


def test_create_basic_pk_model_constructs():
    from pharmpy.modeling import create_basic_pk_model

    # create_basic_pk_model builds a minimal PK model with no dataset file —
    # cheap, offline, and file-free (unlike parsing a real NONMEM control
    # stream, which is deliberately not exercised here).
    model = create_basic_pk_model()
    assert isinstance(model, pharmpy.Model)


run_test("exposes pharmpy.Model + pharmpy.modeling", test_exposes_model_and_modeling)
run_test("create_basic_pk_model() constructs a Model", test_create_basic_pk_model_constructs)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all pharmpy smoke tests passed")
