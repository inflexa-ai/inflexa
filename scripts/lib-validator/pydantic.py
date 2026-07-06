#!/usr/bin/env python3
"""Smoke test for the Python `pydantic` package.

Fully self-contained: no input files, no network, no packages beyond pydantic
(and its implied deps: pydantic-core, typing-extensions). Exercises the core
API surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 pydantic.py

Install: pip install pydantic   (import name: pydantic)

Targets the pydantic v2 API (`model_dump`, `model_validate`, `ValidationError`
raised from construction). pydantic v1 differs — `.dict()`/`.parse_obj()` and
looser coercion — so this asserts against the v2 surface.

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
    import pydantic
except ImportError:
    print("FAIL: package 'pydantic' is not installed")
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


print(f"pydantic version: {_version(pydantic, 'pydantic')}")

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


from pydantic import BaseModel, ValidationError


class Sample(BaseModel):
    """A tiny typed model exercising fields, defaults, and coercion."""

    name: str
    count: int
    ratio: float = 1.0
    tags: list[str] = []


def test_construct_and_field_values():
    m = Sample(name="alpha", count=3, tags=["x", "y"])
    assert m.name == "alpha"
    assert m.count == 3
    assert m.ratio == 1.0
    assert m.tags == ["x", "y"]


def test_type_coercion():
    # pydantic v2 coerces a numeric string to int in lax mode.
    m = Sample(name="beta", count="7")
    assert m.count == 7
    assert isinstance(m.count, int)


def test_validation_error_on_bad_input():
    raised = False
    try:
        Sample(name="gamma", count="not-a-number")
    except ValidationError:
        raised = True
    assert raised


def test_model_dump_validate_roundtrip():
    m = Sample(name="delta", count=5, ratio=2.5, tags=["a"])
    dumped = m.model_dump()
    assert dumped == {"name": "delta", "count": 5, "ratio": 2.5, "tags": ["a"]}
    back = Sample.model_validate(dumped)
    assert back == m


run_test("construct + field values", test_construct_and_field_values)
run_test("type coercion", test_type_coercion)
run_test("ValidationError on bad input", test_validation_error_on_bad_input)
run_test("model_dump/model_validate roundtrip", test_model_dump_validate_roundtrip)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all pydantic smoke tests passed")
