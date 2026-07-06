#!/usr/bin/env python3
"""Smoke test for the Python `ms-deisotope` package.

Fully self-contained: no input files, no network, no packages beyond
ms-deisotope (and its implied deps: brainpy, ms_peak_picker). Exercises the
core API surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 ms-deisotope.py

Install: pip install ms-deisotope   (import name: ms_deisotope)

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
    import ms_deisotope
except ImportError:
    print("FAIL: package 'ms-deisotope' is not installed")
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


print(f"ms_deisotope version: {_version(ms_deisotope, 'ms-deisotope')}")

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


# NOTE: a full ms_deisotope.deconvolute_peaks run needs a real peak list, an
# averagine model, and a scorer; MSFileLoader needs a real MS file. This
# validator stays MODEST: it confirms the top-level surface, then exercises the
# one genuinely offline piece — the averagine isotopic-pattern model. FLAG: no
# deconvolution or file loading is performed.
def test_top_level_surface():
    assert callable(ms_deisotope.deconvolute_peaks)
    assert callable(ms_deisotope.MSFileLoader)
    from ms_deisotope import averagine

    assert hasattr(averagine, "peptide")  # predefined peptide averagine model


def test_averagine_isotopic_cluster():
    from ms_deisotope import averagine

    # The peptide averagine yields a normalized theoretical isotopic pattern —
    # a purely offline computation that needs no peak list or MS file.
    pattern = averagine.peptide.isotopic_cluster(1000.0, charge=2)
    peaks = list(pattern)
    assert len(peaks) > 0
    total = sum(p.intensity for p in peaks)
    assert abs(total - 1.0) < 1e-3  # pattern intensities are normalized to 1
    assert all(p.mz > 0 for p in peaks)


run_test("top-level surface present", test_top_level_surface)
run_test("averagine isotopic cluster", test_averagine_isotopic_cluster)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all ms-deisotope smoke tests passed")
