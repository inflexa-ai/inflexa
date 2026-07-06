#!/usr/bin/env python3
"""Smoke test for the Python `jupytext` package.

Fully self-contained: no input files, no network, no packages beyond jupytext
(and its implied deps: nbformat). Exercises the core API surface and exits 0
only if every check passes, so it can be used as a pass/fail library validator:

    python3 jupytext.py

Install: pip install jupytext   (import name: jupytext)

NOTE — jupytext format names: text formats are `py:percent` / `py:light` /
`md` (+ `md:myst`); the JSON notebook format is `ipynb` (the jupytext CLI also
accepts the `notebook` alias for it). These checks read the `py:percent`
representation and round-trip through both `py:percent` and `ipynb`.

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
    import jupytext
except ImportError:
    print("FAIL: package 'jupytext' is not installed")
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


print(f"jupytext version: {_version(jupytext, 'jupytext')}")

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


def test_reads_percent_script_to_notebook():
    nb = jupytext.reads("# %%\nprint(1)\n", fmt="py:percent")
    # A notebook node exposes .cells; a single percent cell -> one code cell.
    assert hasattr(nb, "cells")
    assert len(nb.cells) == 1
    assert nb.cells[0].cell_type == "code"
    assert nb.cells[0].source == "print(1)"


def test_writes_percent_roundtrip():
    nb = jupytext.reads("# %%\nprint(1)\n", fmt="py:percent")
    text = jupytext.writes(nb, fmt="py:percent")
    assert isinstance(text, str)
    assert "print(1)" in text
    # Re-reading the emitted text reproduces the same single code cell.
    nb2 = jupytext.reads(text, fmt="py:percent")
    assert len(nb2.cells) == 1
    assert nb2.cells[0].source == "print(1)"


def test_writes_ipynb_roundtrip():
    nb = jupytext.reads("# %%\nprint(1)\n", fmt="py:percent")
    ipynb = jupytext.writes(nb, fmt="ipynb")
    assert isinstance(ipynb, str)
    # The ipynb form is JSON text.
    assert ipynb.lstrip().startswith("{")
    back = jupytext.reads(ipynb, fmt="ipynb")
    assert len(back.cells) == 1
    assert back.cells[0].source == "print(1)"


def test_multi_cell_percent_script():
    src = "# %% [markdown]\n# a heading\n\n# %%\nx = 2\nprint(x)\n"
    nb = jupytext.reads(src, fmt="py:percent")
    assert len(nb.cells) == 2
    assert nb.cells[0].cell_type == "markdown"
    assert nb.cells[1].cell_type == "code"
    assert "print(x)" in nb.cells[1].source


run_test("reads py:percent -> notebook", test_reads_percent_script_to_notebook)
run_test("writes py:percent roundtrip", test_writes_percent_roundtrip)
run_test("writes ipynb roundtrip", test_writes_ipynb_roundtrip)
run_test("multi-cell percent script", test_multi_cell_percent_script)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all jupytext smoke tests passed")
