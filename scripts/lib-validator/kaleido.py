#!/usr/bin/env python3
"""Smoke test for the Python `kaleido` package.

Fully self-contained: no input files, no network, no packages beyond kaleido
itself. kaleido is plotly's static-image exporter. Exits 0 only if every check
passes, so it can be used as a pass/fail library validator:

    python3 kaleido.py

Install: pip install kaleido   (import name: kaleido)

CHROMIUM — this test DOES render. It used to stop at the import, on the reasoning
that exporting would spawn kaleido's bundled Chromium; that reasoning expired with
kaleido 1.0, which dropped the bundled browser and now drives an external one over
CDP. The browser is staged in images/sandbox-base/Dockerfile precisely so this
works, and the failure it guards against is silent: `import kaleido` succeeds with
no browser anywhere on the box, and the breakage only shows up when an analysis
tries to export a figure. Importability is therefore no longer evidence of
anything, so the render below is the assertion that matters.

It renders from a raw figure DICT rather than a plotly Figure, which keeps the
"no packages beyond kaleido itself" contract — plotly has its own validator.

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
    # (see the module docstring's version FLAG).
    legacy = hasattr(kaleido, "scopes") or hasattr(kaleido, "Scope")
    modern = (
        hasattr(kaleido, "Kaleido")
        or hasattr(kaleido, "calc_fig")
        or hasattr(kaleido, "calc_fig_sync")
        or hasattr(kaleido, "write_fig")
        or hasattr(kaleido, "write_fig_sync")
    )
    assert legacy or modern


def test_renders_a_real_png():
    """Drive an actual browser render and check the bytes are a real PNG.

    This is the check that distinguishes a working exporter from an importable
    one. A bare `len(img) > 0` would not: assert the PNG magic number so a
    stub/error payload cannot pass, and a floor on the size so a technically-valid
    but empty render cannot either.
    """
    spec = {
        "data": [{"type": "scatter", "x": [1, 2, 3], "y": [3, 1, 2]}],
        "layout": {"title": {"text": "kaleido validator"}, "width": 500, "height": 350},
    }
    img = kaleido.calc_fig_sync(spec, opts={"format": "png"})
    assert img[:8] == b"\x89PNG\r\n\x1a\n", f"not a PNG (first bytes: {img[:8]!r})"
    assert len(img) > 1000, f"degenerate {len(img)}-byte PNG"
    print(f"       rendered {len(img)}-byte PNG via {os.environ.get('BROWSER_PATH') or 'PATH-discovered browser'}")


run_test("module imports and names itself", test_module_imports_and_names_itself)
run_test("version string present", test_version_string_present)
run_test("exposes known exporter surface", test_exposes_known_exporter_surface)

# 1.x-only: the render goes through calc_fig_sync, which the 0.x scope API has no
# equivalent for. Skip rather than fail blind on a legacy install (the manifest
# resolves 1.x, so a skip here is itself worth noticing).
if hasattr(kaleido, "calc_fig_sync"):
    run_test("renders a real PNG through a browser", test_renders_a_real_png)
else:
    print("  note kaleido: pre-1.x install, no calc_fig_sync; skipping the render check")

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all kaleido smoke tests passed")
