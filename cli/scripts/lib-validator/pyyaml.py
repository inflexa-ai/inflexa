#!/usr/bin/env python3
"""Smoke test for the Python `PyYAML` package.

Fully self-contained: no input files, no network, no packages beyond PyYAML.
Exercises the core API surface and exits 0 only if every check passes, so it
can be used as a pass/fail library validator:

    python3 pyyaml.py

Install: pip install pyyaml   (import name: yaml)

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
    import yaml
except ImportError:
    print("FAIL: package 'pyyaml' is not installed")
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


print(f"pyyaml version: {_version(yaml, 'pyyaml')}")

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


def test_safe_dump_load_roundtrip():
    data = {
        "name": "smoke",
        "count": 3,
        "nested": {"a": [1, 2, 3], "b": {"deep": True}},
        "items": ["x", "y", "z"],
    }
    text = yaml.safe_dump(data)
    assert isinstance(text, str)
    back = yaml.safe_load(text)
    assert back == data


def test_safe_load_literal_multiline():
    doc = """
    name: project
    version: 2
    tags:
      - alpha
      - beta
    config:
      enabled: true
      threshold: 0.5
    """
    parsed = yaml.safe_load(doc)
    assert parsed["name"] == "project"
    assert parsed["version"] == 2
    assert parsed["tags"] == ["alpha", "beta"]
    assert parsed["config"] == {"enabled": True, "threshold": 0.5}


def test_type_coercion():
    parsed = yaml.safe_load("i: 42\nf: 3.14\nb: yes\nn: null\nlst: [1, 2, 3]\n")
    assert parsed["i"] == 42 and isinstance(parsed["i"], int)
    assert abs(parsed["f"] - 3.14) < 1e-12 and isinstance(parsed["f"], float)
    assert parsed["b"] is True
    assert parsed["n"] is None
    assert parsed["lst"] == [1, 2, 3]


run_test("safe_dump/safe_load roundtrip", test_safe_dump_load_roundtrip)
run_test("safe_load literal multi-line YAML", test_safe_load_literal_multiline)
run_test("scalar type coercion", test_type_coercion)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all pyyaml smoke tests passed")
