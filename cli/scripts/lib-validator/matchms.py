#!/usr/bin/env python3
"""Smoke test for the Python `matchms` package.

Fully self-contained: no input files, no network, no packages beyond matchms
(and its implied deps: numpy). Exercises the core API surface and exits 0 only
if every check passes, so it can be used as a pass/fail library validator:

    python3 matchms.py

Install: pip install matchms   (import name: matchms)

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
    import matchms
except ImportError:
    print("FAIL: package 'matchms' is not installed")
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


print(f"matchms version: {_version(matchms, 'matchms')}")

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


# matchms is genuinely offline-shaped: a Spectrum is built from in-memory
# arrays, and its filters/similarities are deterministic. m/z must be sorted
# ascending, which it is here.
def _spectrum():
    import numpy as np

    return matchms.Spectrum(
        mz=np.array([100.0, 150.0, 200.0]),
        intensities=np.array([0.1, 1.0, 0.5]),
        metadata={"precursor_mz": 250.0},
    )


def test_spectrum_construct_and_metadata():
    import numpy as np

    spec = _spectrum()
    assert np.array_equal(spec.peaks.mz, np.array([100.0, 150.0, 200.0]))
    assert np.array_equal(spec.peaks.intensities, np.array([0.1, 1.0, 0.5]))
    assert abs(float(spec.get("precursor_mz")) - 250.0) < 1e-9


def test_normalize_intensities_max_is_one():
    from matchms.filtering import normalize_intensities

    normalized = normalize_intensities(_spectrum())
    assert abs(float(normalized.peaks.intensities.max()) - 1.0) < 1e-9


def test_cosine_greedy_self_similarity():
    from matchms.similarity import CosineGreedy

    spec = _spectrum()
    score = CosineGreedy().pair(spec, spec)
    # A spectrum's cosine similarity with itself is 1.0.
    assert abs(float(score["score"]) - 1.0) < 1e-6


run_test("Spectrum construct + metadata", test_spectrum_construct_and_metadata)
run_test("normalize_intensities -> max 1.0", test_normalize_intensities_max_is_one)
run_test("CosineGreedy self-similarity ~1.0", test_cosine_greedy_self_similarity)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all matchms smoke tests passed")
