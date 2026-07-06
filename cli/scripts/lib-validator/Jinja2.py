#!/usr/bin/env python3
"""Smoke test for the Python `Jinja2` package (import name: jinja2).

Fully self-contained: no input files, no network, no packages beyond Jinja2
(and its implied deps). Exercises the core API surface and exits 0 only if every
check passes, so it can be used as a pass/fail library validator:

    python3 Jinja2.py

Install: pip install Jinja2   (import name: jinja2)

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
    import jinja2
except ImportError:
    print("FAIL: package 'Jinja2' is not installed")
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


print(f"Jinja2 version: {_version(jinja2, 'Jinja2')}")

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


def test_simple_variable_substitution():
    out = jinja2.Template("Hello {{ name }}!").render(name="X")
    assert out == "Hello X!"


def test_environment_loop_and_filter():
    env = jinja2.Environment()
    tmpl = env.from_string("{{ items | join(', ') }}")
    assert tmpl.render(items=["a", "b", "c"]) == "a, b, c"
    loop = env.from_string("{% for i in xs %}{{ i }}{% endfor %}")
    assert loop.render(xs=[1, 2, 3]) == "123"


def test_autoescape_behavior():
    # autoescape ON: HTML-special characters are entity-escaped.
    on = jinja2.Environment(autoescape=True)
    assert on.from_string("{{ v }}").render(v="<b>") == "&lt;b&gt;"
    # autoescape OFF (the default): the value passes through verbatim.
    off = jinja2.Environment(autoescape=False)
    assert off.from_string("{{ v }}").render(v="<b>") == "<b>"


def test_conditional_and_default_filter():
    env = jinja2.Environment()
    cond = env.from_string("{% if n > 1 %}many{% else %}one{% endif %}")
    assert cond.render(n=5) == "many"
    assert cond.render(n=1) == "one"
    dflt = env.from_string("{{ missing | default('fallback') }}")
    assert dflt.render() == "fallback"


run_test("simple variable substitution", test_simple_variable_substitution)
run_test("Environment loop + join filter", test_environment_loop_and_filter)
run_test("autoescape on/off behavior", test_autoescape_behavior)
run_test("conditional + default filter", test_conditional_and_default_filter)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all Jinja2 smoke tests passed")
