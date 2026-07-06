#!/usr/bin/env python3
"""Smoke test for the Python `pyarrow` package.

Fully self-contained: no input files, no network, no packages beyond pyarrow.
Exercises the core API surface and exits 0 only if every check passes, so it
can be used as a pass/fail library validator:

    python3 pyarrow.py

Install: pip install pyarrow   (import name: pyarrow)

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
    import pyarrow as pa
except ImportError:
    print("FAIL: package 'pyarrow' is not installed")
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


print(f"pyarrow version: {_version(pa, 'pyarrow')}")

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


def test_array_and_table_construct():
    arr = pa.array([1, 2, 3, 4])
    assert len(arr) == 4
    assert arr.to_pylist() == [1, 2, 3, 4]
    table = pa.table({"a": [1, 2, 3], "b": [4.0, 5.0, 6.0]})
    assert table.num_rows == 3
    assert table.num_columns == 2
    assert table.column_names == ["a", "b"]


def test_column_access_and_pydict_roundtrip():
    data = {"a": [1, 2, 3], "b": ["x", "y", "z"]}
    table = pa.table(data)
    assert table.column("a").to_pylist() == [1, 2, 3]
    assert table.to_pydict() == data


def test_compute_sum():
    import pyarrow.compute as pc

    table = pa.table({"a": [1, 2, 3, 4, 5]})
    assert pc.sum(table.column("a")).as_py() == 15


def test_parquet_roundtrip_tempfile():
    import tempfile

    import pyarrow.parquet as pq

    table = pa.table({"a": [1, 2, 3], "b": [4.0, 5.0, 6.0]})
    fd, path = tempfile.mkstemp(suffix=".parquet")
    os.close(fd)
    try:
        pq.write_table(table, path)
        back = pq.read_table(path)
        assert back.to_pydict() == table.to_pydict()
    finally:
        os.remove(path)


def test_feather_roundtrip_tempfile():
    import tempfile

    import pyarrow.feather as feather

    table = pa.table({"i": [10, 20, 30], "s": ["p", "q", "r"]})
    fd, path = tempfile.mkstemp(suffix=".feather")
    os.close(fd)
    try:
        feather.write_feather(table, path)
        back = feather.read_table(path)
        assert back.to_pydict() == table.to_pydict()
    finally:
        os.remove(path)


run_test("array/table construct", test_array_and_table_construct)
run_test("column access + to_pydict roundtrip", test_column_access_and_pydict_roundtrip)
run_test("compute.sum", test_compute_sum)
run_test("parquet tempfile round-trip", test_parquet_roundtrip_tempfile)
run_test("feather tempfile round-trip", test_feather_roundtrip_tempfile)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all pyarrow smoke tests passed")
