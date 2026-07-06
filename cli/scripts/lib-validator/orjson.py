#!/usr/bin/env python3
"""Smoke test for the Python `orjson` package.

Fully self-contained: no input files, no network, no packages beyond orjson
(and its implied deps; the numpy check needs numpy). Exercises the core API
surface and exits 0 only if every check passes, so it can be used as a pass/fail
library validator:

    python3 orjson.py

Install: pip install orjson   (import name: orjson)

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
    import orjson
except ImportError:
    print("FAIL: package 'orjson' is not installed")
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


print(f"orjson version: {_version(orjson, 'orjson')}")

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


def test_dumps_returns_bytes():
    out = orjson.dumps({"a": 1, "b": [1, 2]})
    # Unlike stdlib json, orjson.dumps returns bytes, not str.
    assert isinstance(out, bytes)
    assert out == b'{"a":1,"b":[1,2]}'


def test_roundtrip():
    obj = {"a": 1, "b": [1, 2], "c": {"nested": True}, "d": None}
    assert orjson.loads(orjson.dumps(obj)) == obj


def test_sort_keys_option():
    out = orjson.dumps({"b": 2, "a": 1}, option=orjson.OPT_SORT_KEYS)
    assert out == b'{"a":1,"b":2}'


def test_numpy_option():
    import numpy as np

    arr = np.array([[1, 2], [3, 4]], dtype=np.int64)
    out = orjson.dumps(arr, option=orjson.OPT_SERIALIZE_NUMPY)
    assert orjson.loads(out) == [[1, 2], [3, 4]]


def test_datetime_serialization():
    import datetime

    dt = datetime.datetime(2021, 1, 1, 12, 0, 0)
    out = orjson.dumps(dt)
    # orjson emits RFC 3339 / ISO 8601 timestamps natively.
    assert out == b'"2021-01-01T12:00:00"'


run_test("dumps returns bytes", test_dumps_returns_bytes)
run_test("loads/dumps roundtrip", test_roundtrip)
run_test("OPT_SORT_KEYS orders keys", test_sort_keys_option)
run_test("OPT_SERIALIZE_NUMPY", test_numpy_option)
run_test("datetime serialization", test_datetime_serialization)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all orjson smoke tests passed")
