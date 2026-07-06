#!/usr/bin/env python3
"""Smoke test for the Python `kaleido` package.

Fully self-contained: no input files, no network, no packages beyond kaleido
itself. kaleido is plotly's static-image exporter and needs BOTH plotly and a
bundled Chromium backend to actually render an image — so this smoke test is
deliberately MODEST: it only asserts the package imports and exposes its
version and exporter surface. It never exports an image (that would spawn
Chromium). Exits 0 only if every check passes, so it can be used as a pass/fail
library validator:

    python3 kaleido.py

Install: pip install kaleido   (import name: kaleido)

FLAG — Chromium: real image export (`fig.to_image` / `fig.write_image` via
plotly, or kaleido's own exporter) launches the bundled Chromium; this test
intentionally does not do that, so a green run does NOT prove image export
works end-to-end — only that the package is importable.

FLAG — version API: kaleido's public API changed across major versions. The
0.x line exposed a scope-based exporter (`kaleido.scopes.plotly.PlotlyScope` /
a `Scope` object); the 1.x rewrite moved to a `Kaleido` class plus top-level
`calc_fig`/`write_fig` helpers. The API-surface check below accepts EITHER
shape rather than pinning one.

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
    import kaleido
except ImportError:
    print("FAIL: package 'kaleido' is not installed")
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


print(f"kaleido version: {_version(kaleido, 'kaleido')}")

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


def test_module_imports_and_names_itself():
    assert kaleido.__name__ == "kaleido"


def test_version_string_present():
    v = _version(kaleido, "kaleido")
    assert isinstance(v, str)
    assert v and v != "unknown"


def test_exposes_known_exporter_surface():
    # Accept either the legacy scope-based API or the 1.x Kaleido/calc_fig API
    # (see the module docstring's version FLAG). We assert only that an
    # exporter surface EXISTS — we never invoke it, because a real export needs
    # plotly + the bundled Chromium, which this smoke test deliberately avoids.
    legacy = hasattr(kaleido, "scopes") or hasattr(kaleido, "Scope")
    modern = (
        hasattr(kaleido, "Kaleido")
        or hasattr(kaleido, "calc_fig")
        or hasattr(kaleido, "calc_fig_sync")
        or hasattr(kaleido, "write_fig")
        or hasattr(kaleido, "write_fig_sync")
    )
    assert legacy or modern


run_test("module imports and names itself", test_module_imports_and_names_itself)
run_test("version string present", test_version_string_present)
run_test("exposes known exporter surface", test_exposes_known_exporter_surface)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all kaleido smoke tests passed")
