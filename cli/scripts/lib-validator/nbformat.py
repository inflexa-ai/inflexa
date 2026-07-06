#!/usr/bin/env python3
"""Smoke test for the Python `nbformat` package.

Fully self-contained: no input files, no network, no packages beyond nbformat
(and its implied deps). Builds a notebook entirely in memory, validates it, and
roundtrips it through the JSON serializer. Exits 0 only if every check passes,
so it can be used as a pass/fail library validator:

    python3 nbformat.py

Install: pip install nbformat   (import name: nbformat)

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
    import nbformat
except ImportError:
    print("FAIL: package 'nbformat' is not installed")
    sys.exit(1)

from nbformat.v4 import new_code_cell, new_notebook


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


print(f"nbformat version: {_version(nbformat, 'nbformat')}")

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


def _notebook():
    """A minimal v4 notebook with a single code cell."""
    nb = new_notebook()
    nb.cells.append(new_code_cell("1+1"))
    return nb


def test_new_notebook_and_code_cell():
    nb = _notebook()
    assert nb.nbformat == 4
    assert len(nb.cells) == 1
    cell = nb.cells[0]
    assert cell.cell_type == "code"
    assert cell.source == "1+1"


def test_validate_passes():
    nb = _notebook()
    # validate() raises ValidationError on a malformed notebook; a clean return
    # (None) means the notebook conforms to the v4 schema.
    assert nbformat.validate(nb) is None


def test_writes_produces_json_string():
    nb = _notebook()
    s = nbformat.writes(nb)
    assert isinstance(s, str)
    import json

    parsed = json.loads(s)
    assert parsed["nbformat"] == 4
    assert parsed["cells"][0]["source"] == "1+1"


def test_reads_roundtrips_cell_source():
    nb = _notebook()
    s = nbformat.writes(nb)
    back = nbformat.reads(s, as_version=4)
    assert back.nbformat == 4
    assert len(back.cells) == 1
    assert back.cells[0].cell_type == "code"
    assert back.cells[0].source == "1+1"


run_test("new notebook and code cell", test_new_notebook_and_code_cell)
run_test("validate passes", test_validate_passes)
run_test("writes produces JSON string", test_writes_produces_json_string)
run_test("reads roundtrips cell source", test_reads_roundtrips_cell_source)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all nbformat smoke tests passed")
