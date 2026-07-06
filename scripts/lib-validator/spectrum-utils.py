#!/usr/bin/env python3
"""Smoke test for the Python `spectrum-utils` package.

Fully self-contained: no input files, no network, no packages beyond
spectrum-utils (and its implied deps: numpy). Exercises the core API surface
and exits 0 only if every check passes, so it can be used as a pass/fail
library validator:

    python3 spectrum-utils.py

Install: pip install spectrum-utils   (import name: spectrum_utils)

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
    import spectrum_utils
except ImportError:
    print("FAIL: package 'spectrum-utils' is not installed")
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


print(f"spectrum_utils version: {_version(spectrum_utils, 'spectrum-utils')}")

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


# spectrum_utils is genuinely offline-shaped: an MsmsSpectrum is built from
# in-memory arrays, and its transforms are deterministic and chainable (each
# returns self).
def _spectrum(mz=None, intensity=None):
    import numpy as np
    from spectrum_utils.spectrum import MsmsSpectrum

    if mz is None:
        mz = np.array([100.5, 150.2, 200.9, 250.1])
    if intensity is None:
        intensity = np.array([10.0, 40.0, 5.0, 25.0])
    return MsmsSpectrum("spec1", 500.0, 2, mz, intensity)


def test_construct_and_arrays():
    import numpy as np

    mz = np.array([100.5, 150.2, 200.9, 250.1])
    intensity = np.array([10.0, 40.0, 5.0, 25.0])
    spec = _spectrum(mz, intensity)
    assert np.allclose(spec.mz, mz)
    assert np.allclose(spec.intensity, intensity)
    assert len(spec.mz) == 4


def test_round_transform():
    import numpy as np

    mz = np.array([100.53, 150.27, 200.94, 250.11])
    spec = _spectrum(mz, np.array([10.0, 40.0, 5.0, 25.0]))
    spec.round(1)  # round m/z to 1 decimal, in place
    assert np.allclose(spec.mz, np.round(mz, 1))


def test_scale_intensity_changes_values():
    import numpy as np

    spec = _spectrum()
    before = spec.intensity.copy()
    spec.scale_intensity(scaling="root")
    assert spec.intensity.shape == before.shape  # shape preserved
    assert not np.allclose(spec.intensity, before)  # values transformed


def test_filter_intensity_chainable():
    from spectrum_utils.spectrum import MsmsSpectrum

    # Transforms return self, so they chain: filter then scale.
    result = _spectrum().filter_intensity(min_intensity=0.2, max_num_peaks=2).scale_intensity(
        scaling="root"
    )
    assert isinstance(result, MsmsSpectrum)
    assert len(result.mz) == len(result.intensity)  # arrays stay aligned
    assert len(result.mz) <= 2  # capped by max_num_peaks


run_test("MsmsSpectrum construct + arrays", test_construct_and_arrays)
run_test("round() transform", test_round_transform)
run_test("scale_intensity() changes values", test_scale_intensity_changes_values)
run_test("filter_intensity() chainable", test_filter_intensity_chainable)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all spectrum-utils smoke tests passed")
